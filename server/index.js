'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Store } = require('./store');
const { createData } = require('./data');
const { Engine } = require('./engine');
const { brokerCatalog, createBroker, STOCK_BROKERS, CRYPTO_BROKERS } = require('./brokers');
const { authorizeUrl, exchangeCode } = require('./brokers/schwab');
const { isMarketOpen, marketHoliday } = require('./indicators');
const { tradesToCsv } = require('./csv');
const { testBroker } = require('./brokers/check');
const { STRATEGIES, paramsFor } = require('./strategies');
const { PROFILES, smartPlan } = require('./smart');
const { backtestAll } = require('./backtest');
const { buildPerformance } = require('./performance');
const totp = require('./totp');
const ai = require('./ai');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

// Settings the API may change, with validation. Anything not listed here is ignored.
const NUM = (min, max) => (v) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const SYMS = (v) => Array.isArray(v) && v.length <= 50 && v.every((x) => /^[A-Z.]{1,6}$/.test(x));
const CSYMS = (v) => Array.isArray(v) && v.length <= 30 && v.every((x) => /^[A-Z0-9]{2,10}-(USD|USDT|USDC)$/.test(x));
const SETTING_RULES = {
  mode: (v) => ['paper', 'live', 'signals'].includes(v),
  broker: (v) => STOCK_BROKERS.includes(v),
  cryptoBroker: (v) => CRYPTO_BROKERS.includes(v),
  stocksEnabled: (v) => typeof v === 'boolean',
  cryptoEnabled: (v) => typeof v === 'boolean',
  cryptoWatchlist: CSYMS,
  paused: (v) => typeof v === 'boolean',
  autoRun: (v) => typeof v === 'boolean',
  autopilot: (v) => typeof v === 'boolean',
  autopilotFailLimit: NUM(1, 20),
  autopilotDrawdownPct: NUM(0, 90),
  showWarnings: (v) => typeof v === 'boolean',
  smartMode: (v) => typeof v === 'boolean',
  riskLevel: (v) => ['cautious', 'balanced', 'aggressive'].includes(v),
  smartBudgetStocks: NUM(0, 10000000),
  smartBudgetCrypto: NUM(0, 10000000),
  aiReview: (v) => typeof v === 'boolean',
  requireEarningsData: (v) => typeof v === 'boolean',
  useBrackets: (v) => typeof v === 'boolean',
  enabledStrategies: (v) => Array.isArray(v) && v.length >= 1 && v.every((x) => STRATEGIES[x]) && new Set(v).size === v.length,
  tickMinutes: NUM(5, 1440),
  exitCheckMinutes: NUM(1, 120),
  earningsBlockDays: NUM(1, 30),
  tradeDollars: NUM(1, 1000),
  minTradeDollars: NUM(0.5, 100),
  maxPositions: NUM(1, 20),
  maxPositionPct: NUM(1, 100),
  maxTradesPerDay: NUM(1, 50),
  dailyLossLimitPct: NUM(0.5, 50),
  minPrice: NUM(0.5, 10000),
  watchlist: SYMS,
  blocklist: SYMS,
};
const STRATEGY_RULES = {
  rsiMin: NUM(1, 99),
  rsiMax: NUM(1, 99),
  targetPct: NUM(0.5, 50),
  stopPct: NUM(0.5, 50),
  timeStopDays: NUM(1, 30),
};

function createApp({ env = process.env, store, data, engine, fetchImpl = fetch } = {}) {
  const password = env.APP_PASSWORD;
  if (!password || password.length < 8) throw new Error('Set APP_PASSWORD (at least 8 characters) before starting the server.');
  store = store || new Store(path.join(env.DATA_DIR || path.join(__dirname, '..', 'data'), 'state.json'));
  data = data || createData(env);
  engine = engine || new Engine({ store, data, env, fetchImpl });
  const secret = Buffer.from(env.SESSION_SECRET || crypto.createHash('sha256').update('aitrader|' + password).digest('hex'));
  const failures = new Map();

  const sign = (payload) => crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const issueToken = () => {
    const exp = String(Date.now() + 30 * 86400e3);
    return `${exp}.${sign(exp)}`;
  };
  const validToken = (t) => {
    if (!t) return false;
    const [exp, sig] = t.split('.');
    if (!exp || !sig) return false;
    const good = Buffer.from(sign(exp));
    const got = Buffer.from(sig);
    return good.length === got.length && crypto.timingSafeEqual(good, got) && Number(exp) > Date.now();
  };
  const safeEq = (a, b) => {
    const x = crypto.createHash('sha256').update(String(a)).digest();
    const y = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(x, y);
  };

  const json = (res, code, body) => {
    const buf = Buffer.from(JSON.stringify(body));
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': buf.length });
    res.end(buf);
  };
  const html = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI Trader</title><body style="font-family:system-ui;padding:24px;max-width:480px;margin:auto">${body}</body>`);
  };
  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > 100_000) {
          reject(new Error('body too large'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {});
        } catch {
          reject(new Error('invalid JSON'));
        }
      });
    });

  const schwabInfo = () => {
    const tok = store.state.tokens.schwab;
    if (!tok || !tok.refreshToken) return { connected: false, configured: Boolean(env.SCHWAB_APP_KEY && env.SCHWAB_REDIRECT_URI) };
    const daysLeft = 7 - (Date.now() - new Date(tok.obtainedAt)) / 86400e3;
    return { connected: true, configured: true, daysLeft: Math.max(0, Number(daysLeft.toFixed(1))), expired: daysLeft <= 0 };
  };

  // One block per enabled asset class: its own account, positions, open trades and results.
  async function laneStatus(cls) {
    const s = store.state.settings;
    let account = null;
    let positions = [];
    let accountError = null;
    try {
      const b = await engine.brokerFor(s.mode, cls);
      account = await b.account();
      positions = await b.positions();
      account.source = b.name;
    } catch (e) {
      accountError = e.message;
    }
    const mine = store.state.trades.filter((t) => (t.assetClass || 'stocks') === cls && t.mode === s.mode);
    const closed = mine.filter((t) => t.status === 'closed');
    const wins = closed.filter((t) => t.pnl > 0).length;
    return {
      enabled: cls === 'crypto' ? s.cryptoEnabled : s.stocksEnabled,
      broker: engine.brokerName(cls),
      marketOpen: cls === 'crypto' ? true : isMarketOpen(),
      holiday: cls === 'crypto' ? null : marketHoliday(),
      dataProvider: engine.dataFor(cls).name,
      account,
      accountError,
      smart: s.smartMode && account ? smartPlan(s, cls, account.equity, { liveCap: s.mode === 'live' ? Number(env.MAX_LIVE_TRADE_DOLLARS || 25) : Infinity }) : null,
      positions,
      openTrades: mine.filter((t) => t.status === 'open'),
      stats: { closed: closed.length, winRate: closed.length ? wins / closed.length : null, totalPnl: closed.reduce((a, t) => a + (t.pnl || 0), 0) },
    };
  }

  async function status() {
    const s = store.state.settings;
    const classes = {};
    for (const cls of ['stocks', 'crypto']) classes[cls] = (cls === 'crypto' ? s.cryptoEnabled : s.stocksEnabled) ? await laneStatus(cls) : { enabled: false, broker: engine.brokerName(cls) };
    const first = classes.stocks.enabled ? classes.stocks : classes.crypto; // top-level fields mirror the first enabled side
    return {
      settings: s,
      classes,
      marketOpen: first.marketOpen,
      dataProvider: first.dataProvider,
      aiAvailable: ai.enabled(env),
      earningsAvailable: Boolean(engine.calendar),
      newsAvailable: data.name === 'alpaca',
      notificationsOn: Boolean(engine.notify.enabled),
      healthcheckOn: Boolean(env.HEALTHCHECK_URL),
      twoFactorOn: Boolean(store.state.auth.totpEnabled),
      lastScanAt: store.state.meta.lastTickAt,
      schwab: schwabInfo(),
      brokers: brokerCatalog(env),
      riskProfiles: Object.fromEntries(Object.entries(PROFILES).map(([k, v]) => [k, { label: v.label, note: v.note }])),
      strategies: Object.values(STRATEGIES).map((x) => ({ id: x.id, label: x.label, params: paramsFor(x.id, s), cryptoParams: paramsFor(x.id, s, 'crypto') })),
      account: first.account,
      accountError: first.accountError,
      positions: first.positions,
      openTrades: first.openTrades,
      stats: first.stats,
    };
  }

  const performance = (cls) => buildPerformance({ store, data: engine.dataFor(cls), mode: store.state.settings.mode, benchmark: cls === 'crypto' ? 'BTC-USD' : 'SPY', assetClass: cls });

  async function route(req, res, url) {
    const { pathname } = url;

    // ---- no login needed: health probe for uptime monitors (reveals nothing but ok / not ok) ----
    if (pathname === '/healthz' && req.method === 'GET') {
      const s = store.state.settings;
      const last = store.state.meta.lastTickAt;
      const ageMin = last ? (Date.now() - new Date(last)) / 60000 : null;
      const stale = s.autoRun && !s.paused && (s.cryptoEnabled || isMarketOpen()) && (ageMin == null || ageMin > s.tickMinutes * 3 + 5);
      return json(res, stale ? 503 : 200, { ok: !stale, lastScanMinutesAgo: ageMin == null ? null : Math.round(ageMin) });
    }

    // ---- Schwab sends the browser back here after you approve. Protected by a one-time, 10-minute `state` code. ----
    if (pathname === '/oauth/schwab/callback' && req.method === 'GET') {
      const pending = store.state.auth.schwabState;
      const state = url.searchParams.get('state') || '';
      const code = url.searchParams.get('code');
      if (!pending || Date.now() > pending.exp || !safeEq(state, pending.nonce) || !code) {
        return html(res, 400, '<h2>Link expired or invalid</h2><p>Start again from Settings in the app.</p>');
      }
      delete store.state.auth.schwabState;
      try {
        store.state.tokens.schwab = await exchangeCode(env, code, fetchImpl);
        store.save();
        store.log('info', 'Schwab connected');
        return html(res, 200, '<h2>Schwab connected</h2><p>You can close this tab and go back to the app.</p>');
      } catch (e) {
        store.save();
        store.log('error', `Schwab connect failed: ${e.message}`);
        return html(res, 502, '<h2>Could not connect Schwab</h2><p>Check the app log for details.</p>');
      }
    }

    if (pathname === '/api/login' && req.method === 'POST') {
      const ip = req.socket.remoteAddress;
      const f = failures.get(ip) || { n: 0, until: 0 };
      if (f.n >= 5 && Date.now() < f.until) return json(res, 429, { error: 'too many attempts, try again later' });
      const body = await readBody(req);
      const bad = (msg, extra = {}) => {
        failures.set(ip, { n: f.n + 1, until: Date.now() + 15 * 60000 });
        return json(res, 401, { error: msg, ...extra });
      };
      if (!safeEq(body.password || '', password)) return bad('wrong password');
      if (store.state.auth.totpEnabled) {
        if (!body.code) return json(res, 401, { error: 'enter your 6-digit code', need2fa: true });
        const step = totp.verifyTotp(store.state.auth.totpSecret, String(body.code));
        if (step == null || step <= (store.state.auth.lastStep || 0)) return bad('wrong or already-used code', { need2fa: true });
        store.state.auth.lastStep = step; // a code works once
        store.save();
      }
      failures.delete(ip);
      return json(res, 200, { token: issueToken() });
    }

    const auth = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!validToken(auth)) return json(res, 401, { error: 'unauthorized' });

    if (pathname === '/api/status' && req.method === 'GET') return json(res, 200, await status());
    if (pathname === '/api/trades' && req.method === 'GET') return json(res, 200, store.state.trades.slice().reverse().slice(0, 200));
    if (pathname === '/api/trades.csv' && req.method === 'GET') {
      const cls = url.searchParams.get('class');
      const rows = store.state.trades.filter((t) => !cls || (t.assetClass || 'stocks') === cls);
      const buf = Buffer.from(tradesToCsv(rows));
      res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="trades.csv"', 'cache-control': 'no-store', 'content-length': buf.length });
      return res.end(buf);
    }
    if (pathname === '/api/broker/test' && req.method === 'POST') {
      const body = await readBody(req);
      const cls = body.assetClass === 'crypto' ? 'crypto' : 'stocks';
      const s = store.state.settings;
      const sample = cls === 'crypto' ? (s.cryptoWatchlist[0] || 'BTC-USD') : (s.watchlist[0] || 'SPY');
      const out = await testBroker(() => engine.brokerFor('live', cls), {
        feed: engine.dataFor(cls), sampleSymbol: sample, tradeDollars: cls === 'crypto' ? (s.cryptoLimits.tradeDollars || s.tradeDollars) : s.tradeDollars, orderTest: Boolean(body.orderTest),
      });
      return json(res, 200, { assetClass: cls, ...out });
    }
    if (pathname === '/api/signals' && req.method === 'GET') return json(res, 200, store.state.signals.slice().reverse().slice(0, 100));
    if (pathname === '/api/log' && req.method === 'GET') return json(res, 200, store.state.log.slice().reverse().slice(0, 150));
    if (pathname === '/api/performance' && req.method === 'GET') {
      return json(res, 200, await performance(url.searchParams.get('class') === 'crypto' ? 'crypto' : 'stocks'));
    }

    if (pathname === '/api/settings' && req.method === 'POST') {
      const body = await readBody(req);
      const s = store.state.settings;
      const next = { ...s, strategy: { ...s.strategy }, strategyParams: JSON.parse(JSON.stringify(s.strategyParams || {})), cryptoParams: JSON.parse(JSON.stringify(s.cryptoParams || {})), cryptoLimits: { ...s.cryptoLimits } };
      const rejected = [];
      for (const [k, v] of Object.entries(body)) {
        if (k === 'confirm') continue;
        if (k === 'strategy' && v && typeof v === 'object') {
          for (const [sk, sv] of Object.entries(v)) {
            if (STRATEGY_RULES[sk] && STRATEGY_RULES[sk](sv)) next.strategy[sk] = sv;
            else rejected.push(`strategy.${sk}`);
          }
        } else if (k === 'cryptoLimits' && v && typeof v === 'object') {
          for (const [lk, lv] of Object.entries(v)) {
            if (lk in s.cryptoLimits && SETTING_RULES[lk] && SETTING_RULES[lk](lv)) next.cryptoLimits[lk] = lv;
            else rejected.push(`cryptoLimits.${lk}`);
          }
        } else if (k === 'cryptoParams' && v && typeof v === 'object') {
          for (const [sid, params] of Object.entries(v)) {
            if (!STRATEGIES[sid] || !params || typeof params !== 'object') { rejected.push(`cryptoParams.${sid}`); continue; }
            next.cryptoParams[sid] = next.cryptoParams[sid] || {};
            for (const [pk, pv] of Object.entries(params)) {
              if (pk in STRATEGIES[sid].defaults && NUM(0, 1000)(pv)) next.cryptoParams[sid][pk] = pv;
              else rejected.push(`cryptoParams.${sid}.${pk}`);
            }
          }
        } else if (k === 'strategyParams' && v && typeof v === 'object') {
          for (const [sid, params] of Object.entries(v)) {
            if (!STRATEGIES[sid] || sid === 'pullback' || typeof params !== 'object') { rejected.push(`strategyParams.${sid}`); continue; }
            next.strategyParams[sid] = next.strategyParams[sid] || {};
            for (const [pk, pv] of Object.entries(params)) {
              if (pk in STRATEGIES[sid].defaults && NUM(0, 1000)(pv)) next.strategyParams[sid][pk] = pv;
              else rejected.push(`strategyParams.${sid}.${pk}`);
            }
          }
        } else if (SETTING_RULES[k] && SETTING_RULES[k](v)) next[k] = v;
        else rejected.push(k);
      }
      if (next.strategy.rsiMin >= next.strategy.rsiMax) return json(res, 400, { error: 'rsiMin must be below rsiMax' });
      if (next.autopilot) next.autoRun = true; // autopilot means scanning runs by itself
      if (next.autopilot && !s.autopilot && next.mode === 'live' && body.confirm !== 'ENABLE LIVE TRADING') {
        return json(res, 400, { error: 'Autopilot in live mode places real orders with nobody watching. Send confirm: "ENABLE LIVE TRADING" to turn it on' });
      }
      if (!next.stocksEnabled && !next.cryptoEnabled) return json(res, 400, { error: 'Turn on stocks, crypto, or both' });
      for (const [cls, flag] of [['stocks', 'stocksEnabled'], ['crypto', 'cryptoEnabled']]) {
        if (s[flag] && !next[flag] && store.state.trades.some((t) => t.status === 'open' && t.mode === s.mode && (t.assetClass || 'stocks') === cls)) {
          return json(res, 400, { error: `Close your open ${cls} trades (Sell everything) before turning ${cls} off` });
        }
      }
      if (next.mode === 'live' && s.mode !== 'live') {
        if (body.confirm !== 'ENABLE LIVE TRADING') return json(res, 400, { error: 'To switch to live trading send confirm: "ENABLE LIVE TRADING"' });
      }
      // In live mode, every enabled side must have working keys, checked whenever it is newly switched on or its broker changes.
      if (next.mode === 'live') {
        for (const cls of ['stocks', 'crypto']) {
          const on = cls === 'stocks' ? next.stocksEnabled : next.cryptoEnabled;
          const flag = cls === 'stocks' ? 'stocksEnabled' : 'cryptoEnabled';
          const bk = cls === 'stocks' ? 'broker' : 'cryptoBroker';
          if (!on || (s.mode === 'live' && s[flag] && next[bk] === s[bk])) continue;
          const name = next[bk];
          if (name === 'robinhood') return json(res, 400, { error: 'Robinhood has no stock API, so it cannot place live stock orders. Use Signals mode (you get each trade as a phone alert), or pick another stock broker' });
          try {
            createBroker(name, { env, store, fetchImpl, data: cls === 'crypto' ? engine.cryptoData : data }); // fail early if keys are missing
          } catch (e) {
            return json(res, 400, { error: `${cls}: ${e.message}` });
          }
        }
      }
      store.state.settings = next;
      store.save();
      engine.start();
      store.log('info', `settings changed: ${Object.keys(body).filter((k) => k !== 'confirm').join(', ')}`);
      return json(res, 200, { settings: next, rejected });
    }

    if (pathname === '/api/tick' && req.method === 'POST') {
      const body = await readBody(req);
      return json(res, 200, await engine.tick({ force: Boolean(body.force) }));
    }

    if (pathname === '/api/kill' && req.method === 'POST') {
      store.state.settings.paused = true;
      store.save();
      store.log('warn', 'PAUSED: no new trades; exits on open positions still run');
      await engine.alert('Paused', 'No new trades will be opened. Exits on open positions still run.');
      return json(res, 200, { paused: true });
    }

    if (pathname === '/api/flatten' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.confirm !== 'SELL EVERYTHING') return json(res, 400, { error: 'send confirm: "SELL EVERYTHING"' });
      return json(res, 200, await engine.flatten());
    }

    if (pathname === '/api/paper/reset' && req.method === 'POST') {
      store.state.paper = { cash: store.state.settings.paperStartingCash, positions: {} };
      store.state.paperCrypto = { cash: store.state.settings.paperStartingCash, positions: {} };
      for (const k of Object.keys(store.state.meta.peak || {})) if (k.startsWith('paper:')) delete store.state.meta.peak[k];
      store.state.trades = store.state.trades.filter((t) => t.mode !== 'paper');
      store.state.equity = store.state.equity.filter((e) => e.mode !== 'paper');
      store.save();
      return json(res, 200, { ok: true });
    }

    if (pathname === '/api/backtest' && req.method === 'POST') {
      const body = await readBody(req);
      const s = store.state.settings;
      const ids = body.strategy === 'all' || !body.strategy ? Object.keys(STRATEGIES) : [body.strategy];
      if (!ids.every((x) => STRATEGIES[x])) return json(res, 400, { error: 'unknown strategy' });
      const years = Number(body.years || 5);
      if (!(years >= 1 && years <= 10)) return json(res, 400, { error: 'years must be 1 to 10' });
      const crypto = body.assetClass === 'crypto' || (body.assetClass == null && !s.stocksEnabled);
      const cls = crypto ? 'crypto' : 'stocks';
      const feed = engine.dataFor(cls);
      const symbols = (body.symbols && (crypto ? CSYMS : SYMS)(body.symbols) ? body.symbols : crypto ? s.cryptoWatchlist : s.watchlist).slice(0, 25);
      const params = Object.fromEntries(ids.map((id) => [id, paramsFor(id, s, cls)]));
      // Crypto trades cost more to enter and leave (spread plus fees), so it is charged more slippage than stocks.
      const { results, skipped } = await backtestAll({
        data: feed, symbols, years, strategies: ids, params, benchmark: crypto ? 'BTC-USD' : 'SPY',
        opts: { startingCash: 100, tradeDollars: s.tradeDollars, maxPositions: s.maxPositions, slippagePct: crypto ? 0.3 : 0.05, calendarDays: crypto },
      });
      return json(res, 200, { results: results.map(({ tradesList, ...r }) => r), skipped, dataProvider: feed.name, assetClass: cls });
    }

    if (pathname === '/api/suggest' && req.method === 'POST') {
      if (!ai.enabled(env)) return json(res, 400, { error: 'AI is off: set ANTHROPIC_API_KEY on the server' });
      const s = store.state.settings;
      const body = await readBody(req);
      const crypto = body.assetClass === 'crypto' || (body.assetClass == null && !s.stocksEnabled);
      const feed = engine.dataFor(crypto ? 'crypto' : 'stocks');
      const ideas = await ai.suggest(crypto ? s.cryptoWatchlist : s.watchlist, env, fetchImpl, crypto ? 'crypto' : 'stocks');
      const checked = [];
      for (const i of ideas) {
        try {
          const bars = await feed.getBars(i.symbol, 260);
          const last = bars[bars.length - 1].c;
          checked.push({ ...i, price: last, hasHistory: bars.length >= 205, ok: (crypto || last >= s.minPrice) && bars.length >= 205 });
        } catch {
          checked.push({ ...i, ok: false, price: null, hasHistory: false });
        }
      }
      return json(res, 200, { ideas: checked });
    }

    if (pathname === '/api/schwab/link' && req.method === 'POST') {
      if (!env.SCHWAB_APP_KEY || !env.SCHWAB_REDIRECT_URI) return json(res, 400, { error: 'Set SCHWAB_APP_KEY, SCHWAB_APP_SECRET and SCHWAB_REDIRECT_URI on the server first' });
      const nonce = crypto.randomBytes(24).toString('base64url');
      store.state.auth.schwabState = { nonce, exp: Date.now() + 10 * 60000 };
      store.save();
      return json(res, 200, { url: authorizeUrl(env, nonce) });
    }

    if (pathname === '/api/2fa/setup' && req.method === 'POST') {
      const pending = totp.newSecret();
      store.state.auth.totpPending = pending;
      store.save();
      return json(res, 200, { secret: pending, uri: totp.otpauthUri(pending, 'trader') });
    }
    if (pathname === '/api/2fa/enable' && req.method === 'POST') {
      const body = await readBody(req);
      const pending = store.state.auth.totpPending;
      const step = pending ? totp.verifyTotp(pending, String(body.code || '')) : null;
      if (step == null) return json(res, 400, { error: 'wrong code; check the time on your phone and try again' });
      store.state.auth.totpSecret = pending;
      store.state.auth.totpEnabled = true;
      store.state.auth.lastStep = step;
      delete store.state.auth.totpPending;
      store.save();
      store.log('info', 'two-factor login enabled');
      return json(res, 200, { enabled: true });
    }
    if (pathname === '/api/2fa/disable' && req.method === 'POST') {
      const body = await readBody(req);
      const step = store.state.auth.totpEnabled ? totp.verifyTotp(store.state.auth.totpSecret, String(body.code || '')) : null;
      if (step == null || step <= (store.state.auth.lastStep || 0)) return json(res, 400, { error: 'enter a fresh 6-digit code' });
      store.state.auth = { ...store.state.auth, totpEnabled: false };
      delete store.state.auth.totpSecret;
      store.save();
      store.log('warn', 'two-factor login disabled');
      return json(res, 200, { enabled: false });
    }

    return json(res, 404, { error: 'not found' });
  }

  function serveStatic(req, res, url) {
    let p = decodeURIComponent(url.pathname);
    if (p === '/') p = '/index.html';
    const file = path.normalize(path.join(PUBLIC_DIR, p));
    if (!file.startsWith(PUBLIC_DIR)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] || 'application/octet-stream',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      });
      res.end(buf);
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname.startsWith('/api/') || url.pathname === '/healthz' || url.pathname.startsWith('/oauth/')) await route(req, res, url);
      else serveStatic(req, res, url);
    } catch (e) {
      if (!res.headersSent) json(res, 500, { error: e.message });
    }
  });
  return { server, store, engine, data, issueToken, status, laneStatus, performance };
}

// Minimal .env loader (no dependency). Real environment variables win over the file.
function loadDotEnv(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*([^#\r\n]*?)\s*(?:#.*)?$/);
    if (m && m[2] !== '' && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

if (require.main === module) {
  loadDotEnv(path.join(__dirname, '..', '.env'));
  const env = process.env;
  try {
    const app = createApp({ env });
    const port = Number(env.PORT || 8080);
    const host = env.HOST || '127.0.0.1';
    app.server.listen(port, host, () => {
      console.log(`aitrader on http://${host}:${port}  (data: ${app.data.name}, AI review: ${ai.enabled(env) ? 'on' : 'off, set ANTHROPIC_API_KEY'}, alerts: ${app.engine.notify.enabled ? 'on' : 'off'})`);
    });
    app.engine.start();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

module.exports = { createApp };
