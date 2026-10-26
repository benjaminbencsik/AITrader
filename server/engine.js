'use strict';
const crypto = require('crypto');
const { STRATEGIES, paramsFor } = require('./strategies');
const { checkOrder, nyDay } = require('./risk');
const { businessDaysBetween, calendarDaysBetween, isMarketOpen } = require('./indicators');
const { CryptoData } = require('./cryptodata');
const { createBroker } = require('./brokers');
const { createCalendar } = require('./calendar');
const { createNotifier, pingHealthcheck } = require('./notifier');
const ai = require('./ai');
const { smartLimits, smartTradeDollars, profileFor } = require('./smart');

const id = () => crypto.randomBytes(6).toString('hex');
const usd = (n) => (n < 0 ? '-$' : '$') + Math.abs(n).toFixed(2);

class Engine {
  constructor({ store, data, cryptoData, env = process.env, aiReview = ai.review, now = () => new Date(), notify, calendar, fetchImpl = fetch }) {
    this.store = store;
    this.data = data;
    // Demo prices are synthetic for any symbol, so demo mode reuses them for crypto too.
    this.cryptoData = cryptoData || (data.name === 'demo' ? data : new CryptoData(env, fetchImpl));
    this.env = env;
    this.aiReview = aiReview;
    this.now = now;
    this.fetch = fetchImpl;
    this.notify = notify || createNotifier(env, fetchImpl);
    this.calendar = calendar !== undefined ? calendar : createCalendar(env, fetchImpl);
    this.running = false;
    this.timer = null;
    this.exitTimer = null;
    this.failStreak = 0;
  }

  get settings() {
    return this.store.state.settings;
  }

  // Stocks and crypto run side by side, each with its own broker account, budget, limits and open trades.
  classes() {
    const s = this.settings;
    return [s.stocksEnabled && 'stocks', s.cryptoEnabled && 'crypto'].filter(Boolean);
  }
  cfg(cls) {
    const s = this.settings;
    return cls === 'crypto' ? { ...s, ...s.cryptoLimits } : s;
  }
  dataFor(cls) {
    return cls === 'crypto' ? this.cryptoData : this.data;
  }
  brokerName(cls) {
    return cls === 'crypto' ? this.settings.cryptoBroker : this.settings.broker;
  }
  clsOf(t) {
    return t.assetClass || 'stocks';
  }
  // Crypto never closes; stocks follow the NY session (demo data ignores the clock so previews always work).
  marketClosed(cls = 'stocks') {
    return cls !== 'crypto' && this.data.name !== 'demo' && !isMarketOpen(this.now());
  }

  // paper -> simulated account. live -> the chosen broker. signals -> read-only view of the live broker, else paper.
  async brokerFor(mode, cls = 'stocks') {
    const ctx = { env: this.env, store: this.store, data: this.dataFor(cls), fetchImpl: this.fetch, paperKey: cls === 'crypto' ? 'paperCrypto' : 'paper' };
    if (mode === 'paper') return createBroker('paper', ctx);
    const live = () => createBroker(this.brokerName(cls), ctx);
    if (mode === 'live') return live();
    try {
      const b = live();
      await b.account();
      return b;
    } catch {
      return createBroker('paper', ctx);
    }
  }

  // ---- scheduling ----
  start() {
    this.stop();
    if (!this.settings.autoRun && !this.settings.autopilot) return;
    const err = (what) => (e) => this.store.log('error', `${what} failed: ${e.message}`);
    this.timer = setInterval(() => this.tick().catch(err('scan')), Math.max(1, this.settings.tickMinutes) * 60000);
    this.exitTimer = setInterval(() => this.exitCheck().catch(err('exit check')), Math.max(1, this.settings.exitCheckMinutes) * 60000);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.exitTimer) clearInterval(this.exitTimer);
    this.timer = this.exitTimer = null;
  }

  // ---- full scan: for each enabled asset class, reconcile, exits, then entries ----
  async tick({ force = false } = {}) {
    if (this.running) return { skipped: 'already running' };
    this.running = true;
    const summary = { exits: [], entries: [], signals: [], errors: [] };
    try {
      const s = this.settings;
      const mode = s.mode;
      const enabled = this.classes();
      const lanes = enabled.filter((c) => force || !this.marketClosed(c));
      if (!lanes.length) return { skipped: enabled.length ? 'market closed' : 'nothing enabled' };
      let laneFailed = false;
      for (const cls of lanes) {
        try {
          const broker = await this.brokerFor(mode, cls);
          await this.reconcile(broker);
          if (mode !== 'signals') await this.handleExits(broker, mode, summary, cls);
          // Pause blocks new entries only; open positions keep their exits managed.
          if (!s.paused) await this.handleEntries(broker, mode, summary, cls);
          await this.snapshot(broker, mode, cls);
          this.store.log('info', `scan done (${cls}, ${mode}/${broker.name})`);
        } catch (e) {
          this.store.log('error', `${cls} scan error: ${e.message}`);
          summary.errors.push(`${cls}: ${e.message}`);
          laneFailed = true;
        }
      }
      await this.autopilotCheck(laneFailed);
      this.store.state.meta.lastTickAt = this.now().toISOString();
      this.store.save();
      this.store.log('info', `scan summary: ${summary.entries.length} entries, ${summary.exits.length} exits, ${summary.signals.length} signals`);
      if (summary.errors.length) await this.alert('Scan had errors', summary.errors.slice(0, 3).join('; '), 4);
      else await pingHealthcheck(this.env, this.fetch);
      return summary;
    } catch (e) {
      this.store.log('error', `scan error: ${e.message}`);
      summary.errors.push(e.message);
      await this.alert('Scan failed', e.message, 4);
      return summary;
    } finally {
      this.running = false;
    }
  }

  // ---- lightweight check between scans: only manages exits on open positions ----
  async exitCheck({ force = false } = {}) {
    if (this.running) return { skipped: 'busy' };
    const s = this.settings;
    const open = (cls) => this.store.state.trades.filter((t) => t.mode === s.mode && this.clsOf(t) === cls && (t.status === 'open' || t.pending));
    const lanes = this.classes().filter((c) => open(c).length && (force || !this.marketClosed(c)));
    if (s.mode === 'signals' || !lanes.length) {
      await this.maybeDailySummary();
      return { skipped: 'nothing to check' };
    }
    this.running = true;
    const summary = { exits: [], entries: [], signals: [], errors: [] };
    try {
      for (const cls of lanes) {
        try {
          const broker = await this.brokerFor(s.mode, cls);
          await this.reconcile(broker);
          await this.handleExits(broker, s.mode, summary, cls);
          await this.snapshot(broker, s.mode, cls);
        } catch (e) {
          summary.errors.push(`${cls}: ${e.message}`);
        }
      }
      if (summary.errors.length) await this.alert('Exit check had errors', summary.errors.slice(0, 3).join('; '), 4);
      return summary;
    } finally {
      this.running = false;
      await this.maybeDailySummary();
    }
  }

  // ---- autopilot safety stops: they pause NEW buys only; exits keep running ----
  async autopilotCheck(laneFailed) {
    const s = this.settings;
    if (!s.autopilot) return;
    this.failStreak = laneFailed ? this.failStreak + 1 : 0;
    if (!s.paused && this.failStreak >= s.autopilotFailLimit) {
      s.paused = true;
      this.store.save();
      this.store.log('error', `AUTOPILOT PAUSED: ${this.failStreak} scans in a row failed`);
      await this.alert('Autopilot paused', `${this.failStreak} scans in a row failed (broker or account errors). New buys are paused; exits still run. Check the app, then Resume.`, 5);
    }
  }

  async drawdownCheck(mode, cls, equity) {
    const s = this.settings;
    const smartOn = s.smartMode;
    const limit = smartOn ? profileFor(s.riskLevel).drawdownPausePct : s.autopilotDrawdownPct;
    if ((!s.autopilot && !smartOn) || !(limit > 0) || !(equity > 0)) return;
    const meta = this.store.state.meta;
    meta.peak = meta.peak || {};
    const key = `${mode}:${cls}`;
    meta.peak[key] = Math.max(meta.peak[key] || 0, equity);
    const dd = (1 - equity / meta.peak[key]) * 100;
    if (!s.paused && dd >= limit) {
      s.paused = true;
      this.store.save();
      this.store.log('error', `AUTOPILOT PAUSED: ${cls} account is ${dd.toFixed(1)}% below its peak`);
      await this.alert('Autopilot paused', `The ${cls} account is ${dd.toFixed(1)}% below its peak (limit ${limit}%). New buys are paused; exits still run. Resume when you are ready.`, 5);
    }
  }

  // ---- alerts ----
  async alert(title, message, priority = 3) {
    if (this.notify.enabled) await this.notify(title, message, { priority });
  }

  async maybeDailySummary() {
    if (!this.notify.enabled) return;
    const now = this.now();
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(now);
    const g = (t) => parts.find((p) => p.type === t).value;
    const mins = (Number(g('hour')) % 24) * 60 + Number(g('minute'));
    if (['Sat', 'Sun'].includes(g('weekday')) || mins < 16 * 60 + 5) return;
    const today = nyDay(now.toISOString());
    const meta = this.store.state.meta;
    if (meta.lastSummaryDay === today) return;
    meta.lastSummaryDay = today;
    this.store.save();
    const s = this.settings;
    const lines = [`Mode ${s.mode}${s.paused ? ' (paused)' : ''}`];
    for (const cls of this.classes()) {
      const mine = this.store.state.trades.filter((t) => t.mode === s.mode && this.clsOf(t) === cls);
      const closedToday = mine.filter((t) => t.status === 'closed' && t.exitAt && nyDay(t.exitAt) === today);
      const pnl = closedToday.reduce((a, t) => a + (t.pnl || 0), 0);
      const open = mine.filter((t) => t.status === 'open');
      lines.push(`${cls === 'crypto' ? 'Crypto' : 'Stocks'}: closed today ${closedToday.length}, P&L ${usd(pnl)}; open ${open.map((t) => t.symbol).join(', ') || 'none'}`);
    }
    const tok = this.store.state.tokens.schwab;
    if (s.broker === 'schwab' && tok && tok.obtainedAt) {
      const daysLeft = 7 - (now - new Date(tok.obtainedAt)) / 86400e3;
      if (daysLeft < 2) lines.push(`Schwab login expires in ${Math.max(0, daysLeft).toFixed(1)} days: reconnect in the app.`);
    }
    await this.alert('AI Trader daily summary', lines.join('\n'));
  }

  // ---- equity history for the performance screen ----
  async snapshot(broker, mode, cls = 'stocks') {
    try {
      const last = [...this.store.state.equity].reverse().find((e) => e.mode === mode && (e.assetClass || 'stocks') === cls);
      const now = this.now();
      if (last && now - new Date(last.t) < 10 * 60000) return;
      const a = await broker.account();
      await this.drawdownCheck(mode, cls, a.equity);
      this.store.state.equity.push({ t: now.toISOString(), mode, assetClass: cls, equity: a.equity });
      if (this.store.state.equity.length > 8000) this.store.state.equity.splice(0, this.store.state.equity.length - 8000);
      this.store.save();
    } catch {
      /* snapshots are best-effort */
    }
  }

  openTrades(mode, cls = 'stocks') {
    return this.store.state.trades.filter((t) => t.mode === mode && t.status === 'open' && this.clsOf(t) === cls);
  }

  async reconcile(broker) {
    for (const t of this.store.state.trades) {
      if (!t.pending || t.broker !== broker.name) continue;
      try {
        const o = await broker.getOrder(t.pending.orderId);
        if (o.status !== 'filled') continue;
        if (t.pending.kind === 'entry') {
          if (o.filledQty) t.qty = o.filledQty;
          if (o.filledAvgPrice) t.entryPrice = o.filledAvgPrice;
          if (o.fee) t.entryFee = o.fee;
          if (t.signalPrice && o.filledAvgPrice) t.entrySlipPct = ((o.filledAvgPrice - t.signalPrice) / t.signalPrice) * 100;
        } else if (o.filledAvgPrice) {
          t.exitPrice = o.filledAvgPrice;
          if (o.fee) t.exitFee = o.fee;
          this.settle(t);
        }
        delete t.pending;
        this.store.save();
      } catch (e) {
        this.store.log('warn', `reconcile ${t.symbol}: ${e.message}`);
      }
    }
  }

  // P&L after the exchange's fees. Price differences are real fills when the broker reported them.
  settle(t) {
    const fees = (t.entryFee || 0) + (t.exitFee || 0);
    t.fees = fees || undefined;
    t.pnl = (t.exitPrice - t.entryPrice) * t.qty - fees;
    t.pnlPct = (t.pnl / (t.entryPrice * t.qty)) * 100;
  }

  closeTrade(t, px, reason, res) {
    const now = this.now();
    t.status = 'closed';
    t.exitAt = now.toISOString();
    t.exitPrice = px;
    t.exitReason = reason;
    if (res && res.fee) t.exitFee = res.fee;
    if (res && res.filledAvgPrice) t.exitReal = true;
    this.settle(t);
    if (res && res.status !== 'filled' && res.id) t.pending = { orderId: res.id, kind: 'exit' };
    this.store.save();
    this.store.log('info', `closed ${t.symbol} (${reason}) at ~${px.toFixed(2)}, P&L ${usd(t.pnl)}${t.fees ? ` after ${usd(t.fees)} fees` : ''}`);
  }

  // Takes down the exchange-held target/stop before the app sells by itself, so the coins are free and nothing double-sells.
  async dropProtection(broker, t) {
    if (t.protectId && broker.cancelProtection) {
      await broker.cancelProtection(t.protectId);
      t.protectId = null;
    }
  }

  async handleExits(broker, mode, summary, cls = 'stocks') {
    const now = this.now();
    let held = null;
    const trades = this.openTrades(mode, cls).filter((t) => t.broker === broker.name);
    if (trades.some((t) => t.bracket || (mode === 'live' && !t.pending))) {
      try {
        held = await broker.positions();
      } catch (e) {
        this.store.log('warn', `could not read positions to check for outside changes: ${e.message}`);
      }
    }

    for (const t of trades) {
      try {
        // Exchange-held target/stop (crypto): it may already have fired while the app was off.
        if (t.protectId && broker.protectionResult) {
          const r = await broker.protectionResult(t.protectId, t.target, t.stop);
          if (r.state === 'target' || r.state === 'stop') {
            const reason = `${r.state} (exchange)`;
            if (r.fee) t.exitFee = r.fee;
            t.exitReal = true;
            this.closeTrade(t, r.price, reason);
            summary.exits.push({ symbol: t.symbol, reason, pnl: t.pnl });
            await this.alert(`Sold ${t.symbol}`, `${reason}: ${usd(t.pnl)} (${t.pnlPct.toFixed(1)}%)`, t.pnl < 0 ? 4 : 3);
            continue;
          }
          if (r.state === 'canceled') {
            this.store.log('warn', `${t.symbol}: the exchange-held target/stop was cancelled outside the app; the app will manage the exit itself`);
            t.protectId = null;
          }
        }

        // Sold or moved somewhere else (the exchange's own app, a manual order)? Stop tracking it rather than sell what isn't there.
        if (held && !t.bracket && !t.pending && mode === 'live' && !held.some((p) => p.symbol === t.symbol)) {
          const px = await this.dataFor(cls).getQuote(t.symbol).catch(() => t.entryPrice);
          this.closeTrade(t, px, 'closed outside the app');
          t.estimated = true;
          this.store.save();
          summary.exits.push({ symbol: t.symbol, reason: 'closed outside the app', pnl: t.pnl });
          this.store.log('warn', `${t.symbol} is no longer in the account; marked closed at about ${px.toFixed(2)} (price is an estimate, you sold it somewhere else)`);
          await this.alert(`${t.symbol} closed elsewhere`, `Not in the account anymore, so the app stopped tracking it. P&L is an estimate: ${usd(t.pnl)}.`, 4);
          continue;
        }

        // Broker-side bracket: the broker may have already sold at the target or stop.
        if (t.bracket && !held.some((p) => p.symbol === t.symbol)) {
          const f = broker.recentFilledSell ? await broker.recentFilledSell(t.symbol, t.entryAt) : null;
          if (f) {
            const reason = f.price >= t.target * 0.999 ? 'target (broker)' : 'stop (broker)';
            this.closeTrade(t, f.price, reason);
            summary.exits.push({ symbol: t.symbol, reason, pnl: t.pnl });
            await this.alert(`Sold ${t.symbol}`, `${reason}: ${usd(t.pnl)} (${t.pnlPct.toFixed(1)}%)`, t.pnl < 0 ? 4 : 3);
          }
          continue;
        }

        const price = await this.dataFor(cls).getQuote(t.symbol);
        let reason = null;
        if (price >= t.target) reason = 'target';
        else if (price <= t.stop) reason = 'stop';
        else if ((cls === 'crypto' ? calendarDaysBetween : businessDaysBetween)(t.entryAt, now) >= t.timeStopDays) reason = 'time stop';
        if (!reason) continue;

        if (t.bracket && broker.cancelOpenOrders) await broker.cancelOpenOrders(t.symbol);
        await this.dropProtection(broker, t);
        const res = await broker.placeOrder({ symbol: t.symbol, side: 'sell', qty: t.qty });
        this.closeTrade(t, res.filledAvgPrice || price, reason, res);
        summary.exits.push({ symbol: t.symbol, reason, pnl: t.pnl });
        await this.alert(`Sold ${t.symbol}`, `${reason}: ${usd(t.pnl)} (${t.pnlPct.toFixed(1)}%)`, t.pnl < 0 ? 4 : 3);
      } catch (e) {
        this.store.log('error', `exit ${t.symbol} failed: ${e.message}`);
        summary.errors.push(`exit ${t.symbol}: ${e.message}`);
      }
    }
  }

  // Sell everything this app opened in the current mode, then pause new buying.
  async flatten() {
    const s = this.settings;
    const mode = s.mode;
    const out = { sold: [], errors: [] };
    if (mode === 'signals') return out;
    const classes = new Set([...this.classes(), ...this.store.state.trades.filter((t) => t.status === 'open' && t.mode === mode).map((t) => this.clsOf(t))]);
    for (const cls of classes) {
      let broker;
      try {
        broker = await this.brokerFor(mode, cls);
      } catch (e) {
        out.errors.push(`${cls}: ${e.message}`);
        continue;
      }
      for (const t of this.openTrades(mode, cls).filter((x) => x.broker === broker.name)) {
        try {
          if (t.bracket && broker.cancelOpenOrders) await broker.cancelOpenOrders(t.symbol);
          await this.dropProtection(broker, t);
          const px = await this.dataFor(cls).getQuote(t.symbol);
          const res = await broker.placeOrder({ symbol: t.symbol, side: 'sell', qty: t.qty });
          this.closeTrade(t, res.filledAvgPrice || px, 'manual flatten', res);
          out.sold.push({ symbol: t.symbol, pnl: t.pnl });
        } catch (e) {
          out.errors.push(`${t.symbol}: ${e.message}`);
          this.store.log('error', `flatten ${t.symbol} failed: ${e.message}`);
        }
      }
    }
    s.paused = true;
    this.store.save();
    this.store.log('warn', `FLATTEN: sold ${out.sold.length}, errors ${out.errors.length}; new trades paused`);
    await this.alert('Flattened', `Sold ${out.sold.length} positions${out.errors.length ? `, ${out.errors.length} failed` : ''}. New trades paused.`, 4);
    return out;
  }

  async handleEntries(broker, mode, summary, assetClass = 'stocks') {
    let s = this.cfg(assetClass);
    const account = await broker.account();
    const allPositions = await broker.positions();
    const held = new Set(allPositions.map((p) => p.symbol)); // never buy something already in the account
    // Limits count only what this app opened, so holdings you keep for the long term don't use up its slots.
    const mineTrades = this.openTrades(mode, assetClass);
    const mine = new Set(mineTrades.map((t) => t.symbol));
    const positions = allPositions.filter((p) => mine.has(p.symbol));
    // Smart mode replaces the manual size and limits with ones derived from the account's real balance and the chosen risk level.
    const smart = this.settings.smartMode ? smartLimits(this.settings, assetClass, account.equity) : null;
    if (smart) {
      s = { ...s, maxPositions: smart.maxPositions, maxPositionPct: smart.maxPositionPct, dailyLossLimitPct: smart.dailyLossLimitPct, tradeDollars: smart.maxPositionDollars, enabledStrategies: smart.strategies };
    }
    if (s.maxPositions - positions.length <= 0) return;

    const order = s.enabledStrategies && s.enabledStrategies.length ? s.enabledStrategies : ['pullback'];
    const candidates = [];
    const crypto = assetClass === 'crypto';
    const feed = this.dataFor(assetClass);
    for (const symbol of crypto ? s.cryptoWatchlist : s.watchlist) {
      if (held.has(symbol) || (s.blocklist || []).includes(symbol)) continue;
      try {
        const bars = await feed.getBars(symbol, 260);
        for (const sid of order) {
          const ev = STRATEGIES[sid].evaluate(bars, paramsFor(sid, this.settings, assetClass));
          if (ev.pass) {
            candidates.push({ symbol, strategy: sid, ev, recentCloses: bars.slice(-10).map((b) => b.c) });
            break;
          }
        }
      } catch (e) {
        this.store.log('warn', `${symbol}: ${e.message}`);
        summary.errors.push(`${symbol}: ${e.message}`);
      }
    }
    const score = (c) => (c.strategy === 'meanrev' ? c.ev.metrics.rsi : Math.abs(c.ev.metrics.rsi - 45));
    candidates.sort((a, b) => order.indexOf(a.strategy) - order.indexOf(b.strategy) || score(a) - score(b));

    const deployed = mineTrades.reduce((a, t) => a + t.qty * t.entryPrice, 0);
    // With a budget, the app may only use what is left of it, even if the account holds more cash.
    let cash = smart ? Math.min(account.cash, Math.max(0, smart.managed - deployed)) : account.cash;
    const equity = smart ? smart.managed : account.equity;
    const curPositions = [...positions];
    let openCount = positions.length;
    for (const c of candidates) {
      if (openCount >= s.maxPositions) break;
      const liveCap = this.env.MAX_LIVE_TRADE_DOLLARS ? Number(this.env.MAX_LIVE_TRADE_DOLLARS) : 25;
      let dollars;
      if (smart) dollars = smartTradeDollars(smart, c.ev.entry, c.ev.stop, { cash, liveCap: mode === 'live' ? liveCap : Infinity, minTrade: s.minTradeDollars });
      else dollars = Math.floor(Math.min(s.tradeDollars, mode === 'live' ? liveCap : Infinity, cash) * 100) / 100;
      const sig = {
        id: id(), t: this.now().toISOString(), symbol: c.symbol, strategy: c.strategy, type: 'entry', mode, assetClass,
        price: c.ev.entry, target: c.ev.target, stop: c.ev.stop, dollars, metrics: c.ev.metrics,
      };

      if (smart && dollars <= 0) {
        this.finishSignal(sig, 'blocked', `smart mode: no room for this trade (risk ${profileFor(this.settings.riskLevel).label}, managing $${smart.managed.toFixed(2)}, $${cash.toFixed(2)} free)`, summary);
        continue;
      }
      const risk = checkOrder(
        { symbol: c.symbol, side: 'buy', dollars, price: c.ev.entry },
        { settings: s, account: { cash, equity }, positions: curPositions, trades: this.store.state.trades.filter((t) => this.clsOf(t) === assetClass), mode, assetClass, now: this.now() }
      );
      if (!risk.ok) {
        this.finishSignal(sig, 'blocked', risk.reason, summary);
        continue;
      }

      // Earnings rule: a hard gate, not an opinion. If the lookup fails we don't guess.
      if (crypto) {
        sig.earnings = 'not applicable (crypto)';
      } else if (this.calendar) {
        try {
          const next = await this.calendar.earningsWithin(c.symbol, s.earningsBlockDays, this.now());
          if (next) {
            this.finishSignal(sig, 'blocked', `earnings on ${next} (within ${s.earningsBlockDays} days)`, summary);
            continue;
          }
          sig.earnings = 'clear';
        } catch (e) {
          this.finishSignal(sig, 'blocked', `earnings lookup failed (${e.message}); not trading blind`, summary);
          continue;
        }
      } else if (s.requireEarningsData) {
        this.finishSignal(sig, 'blocked', 'earnings data required but FINNHUB_API_KEY is not set', summary);
        continue;
      } else {
        sig.earnings = 'unchecked';
      }

      if (s.aiReview && ai.enabled(this.env)) {
        try {
          let news = [];
          if (!crypto && feed.getNews) {
            try { news = await feed.getNews(c.symbol, 5); } catch { /* news is best-effort */ }
          }
          sig.ai = await this.aiReview(
            { symbol: c.symbol, strategy: c.strategy, price: c.ev.entry, metrics: c.ev.metrics, target: c.ev.target, stop: c.ev.stop, timeStopDays: c.ev.timeStopDays, recentCloses: c.recentCloses, earnings: sig.earnings, news },
            this.env
          );
          if (sig.ai.decision === 'reject') {
            this.finishSignal(sig, 'vetoed', `AI: ${sig.ai.reasoning}`, summary);
            continue;
          }
        } catch (e) {
          // Fail closed: if the AI step breaks, don't trade on an unreviewed setup.
          this.finishSignal(sig, 'blocked', `AI review failed (${e.message}); not trading unreviewed`, summary);
          continue;
        }
      }

      if (mode === 'signals') {
        this.finishSignal(sig, 'signal', 'signals mode: not placing orders', summary);
        await this.alert(`Signal: ${c.symbol}`, `${c.strategy} setup at ${c.ev.entry.toFixed(2)}, target ${c.ev.target}, stop ${c.ev.stop}`);
        continue;
      }

      try {
        const wholeShares = Math.floor(dollars / c.ev.entry);
        const bracket = Boolean(s.useBrackets && mode === 'live' && broker.placeBracketBuy && wholeShares >= 1);
        const res = bracket
          ? await broker.placeBracketBuy({ symbol: c.symbol, qty: wholeShares, takeProfit: c.ev.target, stopLoss: c.ev.stop })
          : await broker.placeOrder({ symbol: c.symbol, side: 'buy', notional: dollars });
        const price = res.filledAvgPrice || c.ev.entry;
        const trade = {
          id: id(), symbol: c.symbol, side: 'buy', mode, broker: broker.name, assetClass, strategy: c.strategy,
          qty: res.filledQty || (bracket ? wholeShares : dollars / price), entryPrice: price, entryAt: this.now().toISOString(),
          target: c.ev.target, stop: c.ev.stop, timeStopDays: c.ev.timeStopDays, status: 'open',
          bracket, ai: sig.ai, earnings: sig.earnings, signalId: sig.id,
          signalPrice: c.ev.entry, entryReal: Boolean(res.filledAvgPrice),
        };
        if (res.fee) trade.entryFee = res.fee;
        if (res.filledAvgPrice) trade.entrySlipPct = ((res.filledAvgPrice - c.ev.entry) / c.ev.entry) * 100;
        if (res.status !== 'filled') trade.pending = { orderId: res.id, kind: 'entry' };
        // Hand the target and stop to the exchange so they still work if this app is offline.
        if (!bracket && mode === 'live' && s.useBrackets && broker.placeProtection && res.status === 'filled') {
          try {
            const pr = await broker.placeProtection({ symbol: c.symbol, qty: trade.qty, takeProfit: c.ev.target, stopLoss: c.ev.stop });
            trade.protectId = pr.id;
          } catch (e) {
            this.store.log('warn', `${c.symbol}: could not place the exchange-held target/stop (${e.message}); the app will watch it instead`);
          }
        }
        this.store.state.trades.push(trade);
        const spent = bracket ? wholeShares * price : dollars;
        cash -= spent;
        openCount += 1;
        curPositions.push({ symbol: c.symbol, marketValue: spent });
        this.finishSignal(sig, 'executed', `bought ${usd(spent)} via ${broker.name}${bracket || trade.protectId ? ' with target and stop held at the broker' : ''}${trade.entrySlipPct != null && Math.abs(trade.entrySlipPct) >= 0.05 ? ` (filled ${trade.entrySlipPct >= 0 ? '+' : ''}${trade.entrySlipPct.toFixed(2)}% vs signal)` : ''}`, summary);
        summary.entries.push({ symbol: c.symbol, dollars: spent });
        await this.alert(`Bought ${c.symbol}`, `${usd(spent)} at ${price.toFixed(2)} (${c.strategy}). Target ${c.ev.target}, stop ${c.ev.stop}.`);
      } catch (e) {
        if (e.code === 'size') {
          this.finishSignal(sig, 'blocked', e.message, summary); // too small for this exchange: a skip, not a failure
        } else {
          this.finishSignal(sig, 'error', e.message, summary);
          summary.errors.push(`${c.symbol}: ${e.message}`);
        }
      }
    }
  }

  finishSignal(sig, status, reason, summary) {
    sig.status = status;
    sig.reason = reason;
    this.store.addSignal(sig);
    summary.signals.push({ symbol: sig.symbol, status, reason });
    this.store.log(status === 'error' ? 'error' : 'info', `${sig.symbol}: ${status}, ${reason}`);
  }
}

module.exports = { Engine };
