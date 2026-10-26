'use strict';
// Dependency-free dashboard. All dynamic text goes through textContent (never innerHTML), so
// symbols, AI replies and error messages can't inject markup.

const $app = document.getElementById('app');
const GH = () => window.AITRADER_GITHUB; // set when this is the serverless build (website on GitHub Pages, or the APK)
let token = safeGet('aitrader_token') || (GH() && GH().hasSession() ? 'github' : null);
let state = null;
let busy = false;
let tab = 'dashboard';
let backtest = null; // last backtest result, kept while you switch tabs
let ideas = null; // last AI watchlist ideas
let twoFa = null; // pending 2FA setup {secret, uri}

function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* storage blocked */ } }

// ---------------- theme (per device) ----------------
const THEMES = ['auto', 'dark', 'light'];
const THEME_LABEL = { auto: 'Auto', dark: 'Night', light: 'Day' };
let theme = THEMES.includes(safeGet('aitrader_theme')) ? safeGet('aitrader_theme') : 'auto';
function applyTheme() {
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
  const meta = document.querySelector('meta[name=theme-color]');
  const dark = theme === 'dark' || (theme === 'auto' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  if (meta) meta.setAttribute('content', dark ? '#0b1220' : '#f5f6f8');
}
function cycleTheme() {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  safeSet('aitrader_theme', theme);
  applyTheme();
  render();
}
applyTheme();

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
function s(tag, props, ...kids) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(props || {})) el.setAttribute(k, v);
  for (const kid of kids.flat()) if (kid != null) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

async function api(path, opts = {}) {
  if (window.AITRADER_GITHUB) return window.AITRADER_GITHUB.api(path, opts);
  const r = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (r.status === 401 && path !== '/api/login') { token = null; safeSet('aitrader_token', null); render(); throw new Error('Signed out'); }
  if ((r.headers.get('content-type') || '').includes('text/csv')) return r.text();
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || 'Request failed (' + r.status + ')'); e.data = j; throw e; }
  return j;
}
function saveText(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type: type || 'text/csv' }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const money = (n) => (n == null || isNaN(n) ? '–' : (n < 0 ? '-$' : '$') + Math.abs(n).toFixed(2));
const pct = (n, d = 0) => (n == null || isNaN(n) ? '–' : (n * 100).toFixed(d) + '%');
const pp = (n, d = 1) => (n == null || isNaN(n) ? '–' : n.toFixed(d) + '%');
const cls = (n) => (n > 0 ? 'good' : n < 0 ? 'bad' : '');
const when = (iso) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const ago = (iso) => { if (!iso) return 'never'; const m = Math.round((Date.now() - new Date(iso)) / 60000); return m < 1 ? 'just now' : m < 90 ? m + ' min ago' : Math.round(m / 60) + ' h ago'; };
const stratLabel = (id) => ((state && state.strategies.find((x) => x.id === id)) || { label: id }).label;

// ---------------- sign-in ----------------
function loginView(msg, need2fa) {
  if (GH()) return GH().loginView(() => { token = 'github'; refresh(); });
  const pw = h('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password', autofocus: !need2fa });
  const code = h('input', { type: 'text', inputmode: 'numeric', placeholder: '6-digit code', autocomplete: 'one-time-code', maxlength: '6', class: need2fa ? '' : 'hidden', autofocus: need2fa });
  const err = h('div', { class: 'bad', style: 'min-height:20px;margin-top:8px' }, msg || '');
  const go = async () => {
    try {
      const j = await api('/api/login', { method: 'POST', body: { password: pw.value, code: code.value || undefined } });
      token = j.token; safeSet('aitrader_token', token);
      await refresh();
    } catch (e) {
      if (e.data && e.data.need2fa) { $app.replaceChildren(loginView(code.value ? e.message : '', true)); const p = document.querySelector('input[type=password]'); p.value = pw.value; return; }
      err.textContent = e.message;
    }
  };
  pw.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  code.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  return h('div', { class: 'login' }, h('h1', {}, 'AI Trader'), h('p', { class: 'muted' }, 'Private trading assistant. Sign in to continue.'), pw, h('div', { style: 'height:8px' }), code, h('div', { style: 'height:10px' }), h('button', { onclick: go, style: 'width:100%' }, 'Sign in'), err);
}

async function act(fn) {
  if (busy) return;
  busy = true; render();
  try { await fn(); } catch (e) { alert(e.message); }
  busy = false;
  await refresh();
}

let loadError = null;
let view = null; // which side (stocks or crypto) the Dashboard, Performance and Backtest tabs show
const enabledClasses = () => ['stocks', 'crypto'].filter((c) => state && state.classes[c].enabled);
const viewCls = () => { const e = enabledClasses(); return e.includes(view) ? view : e[0] || 'stocks'; };
const lane = () => state.classes[viewCls()];
const bmName = () => (viewCls() === 'crypto' ? 'Bitcoin' : 'SPY');
const brokersLabel = (st) => enabledClasses().map((c) => (c === 'crypto' ? st.cryptoBroker : st.broker)).join(' + ');

function setMode(mode) {
  return act(async () => {
    const body = { mode };
    if (mode === 'live') {
      const typed = prompt('LIVE trading places REAL orders with real money on ' + brokersLabel(state.settings) + '.\nType ENABLE LIVE TRADING to continue.');
      if (typed !== 'ENABLE LIVE TRADING') return;
      body.confirm = typed;
    }
    await api('/api/settings', { method: 'POST', body });
  });
}

// ---------------- shell ----------------
function shell(content) {
  const s = state.settings;
  const root = h('main', {});
  root.append(h('header', {},
    h('div', { class: 'top' },
      h('h1', {}, 'AI Trader'),
      h('button', { class: 'sec sm', title: 'Colors: ' + THEME_LABEL[theme] + '. Tap to switch between Auto, Night and Day.', onclick: cycleTheme }, 'Theme: ' + THEME_LABEL[theme]),
      h('button', { class: 'sec sm', onclick: () => { token = null; safeSet('aitrader_token', null); if (GH()) GH().signOut(); render(); } }, 'Sign out')),
    h('div', { class: 'pills' },
      h('span', { class: 'pill ' + s.mode }, s.mode === 'live' ? 'LIVE · ' + brokersLabel(s) : s.mode === 'paper' ? 'PAPER · fake money' : 'SIGNALS ONLY'),
      s.autopilot ? h('span', { class: 'pill paper' }, 'AUTOPILOT') : null,
      s.paused ? h('span', { class: 'pill warn' }, 'PAUSED') : null,
      state.github ? h('span', { class: 'pill' }, 'Runner updated ' + ago(state.github.viewAt)) : null,
      enabledClasses().map((c) => h('span', { class: 'pill' }, c === 'crypto' ? 'Crypto · 24/7' : state.classes.stocks.marketOpen ? 'Stocks open' : state.classes.stocks.holiday ? 'Stocks closed · ' + state.classes.stocks.holiday : 'Stocks closed')))
  ));
  root.append(h('div', { class: 'tabs' }, [['dashboard', 'Dashboard'], ['performance', 'Performance'], ['backtest', 'Backtest'], ['settings', 'Settings']].map(([id, label]) =>
    h('button', { class: tab === id ? 'on' : '', onclick: () => { tab = id; render(); } }, label))));
  if (enabledClasses().length > 1 && ['dashboard', 'performance', 'backtest'].includes(tab)) {
    root.append(h('div', { class: 'seg', style: 'margin:0 0 8px' }, enabledClasses().map((c) => h('button', { class: viewCls() === c ? 'on' : '', onclick: () => { view = c; backtest = null; render(); } }, c === 'crypto' ? 'Crypto' : 'Stocks'))));
  }
  root.append(...banners());
  root.append(content);
  return root;
}

function banners() {
  const s = state.settings;
  const out = [];
  const tips = [];
  const add = (kind, text) => out.push(h('div', { class: 'banner ' + kind }, text));
  const quiet = s.showWarnings === false; // quiet mode hides advice, never real problems
  if (s.paused && !quiet) add('warn', 'Paused: no new trades will be opened. Open positions still get their target, stop and time exits.');
  for (const c of enabledClasses()) if (state.classes[c].accountError) add('err', (c === 'crypto' ? 'Crypto' : 'Stocks') + ': could not read the account: ' + state.classes[c].accountError);
  if (s.autoRun && (s.cryptoEnabled || state.classes.stocks.marketOpen) && state.lastScanAt && (Date.now() - new Date(state.lastScanAt)) / 60000 > s.tickMinutes * 3 + 5) add('err', 'The scanner looks stalled: last scan ' + ago(state.lastScanAt) + '.');
  if (state.schwab.connected && (state.schwab.expired || (!quiet && state.schwab.daysLeft < 2))) add('warn', 'Schwab login ' + (state.schwab.expired ? 'has expired' : 'expires in ' + state.schwab.daysLeft + ' days') + '. Reconnect in Settings.');
  // Less urgent setup gaps are tucked into one collapsed line so they don't push the page down.
  if (!state.aiAvailable) tips.push('AI review is off (no ANTHROPIC_API_KEY): trades follow the rules only.');
  if (!state.earningsAvailable) tips.push('Earnings dates are not checked (no FINNHUB_API_KEY): a report can gap a stock through its stop.');
  if (!state.notificationsOn) tips.push('Phone alerts are off: set NTFY_TOPIC to get a message for every trade.');
  if (!state.twoFactorOn) tips.push('Two-step login is off: turn it on in Settings before exposing the app to the internet.');
  if (tips.length && !quiet) out.push(h('details', { class: 'tips' }, h('summary', {}, 'Setup tips (' + tips.length + ')'), tips.map((t) => h('div', { class: 'muted', style: 'font-size:13px;margin:4px 0' }, t))));
  return out;
}

const stat = (k, v, c) => h('div', { class: 'card' }, h('div', { class: 'k' }, k), h('div', { class: 'v ' + (c || '') }, v));

function table(heads, rows) {
  if (!rows.length) return null;
  return h('div', { class: 'card scroll' }, h('table', {}, h('thead', {}, h('tr', {}, heads.map((x) => h('th', {}, x)))), h('tbody', {}, rows.map((r) => h('tr', {}, r.map((c) => h('td', {}, c)))))));
}

// ---------------- dashboard ----------------
function dashboard() {
  const st = state.settings;
  const L = lane();
  const a = L.account;
  const x = L.stats;
  const root = h('div', {});

  root.append(h('div', { class: 'grid', style: 'margin-top:10px' },
    stat('Account value', money(a && a.equity)),
    stat('Cash', money(a && a.cash)),
    stat('Closed P&L', money(x.totalPnl), cls(x.totalPnl)),
    stat('Win rate', x.closed ? pct(x.winRate) + ' of ' + x.closed : '–')
  ));

  if (L.smart) {
    const p = L.smart;
    root.append(h('div', { class: 'card', style: 'margin-top:10px;font-size:13px' },
      h('div', { style: 'font-weight:700' }, 'Smart mode · ' + (state.riskProfiles[st.riskLevel] || {}).label + ' risk'),
      h('div', { class: 'muted', style: 'margin-top:4px' }, 'Managing ' + money(p.managed) + (st['smartBudget' + (viewCls() === 'crypto' ? 'Crypto' : 'Stocks')] > 0 ? ' (your budget)' : ' (the whole account)') + '. Each trade risks about ' + money(p.riskPerTradeDollars) + '; a typical position is ' + money(p.typicalTradeDollars) + ', up to ' + p.maxPositions + ' at once, none over ' + p.maxPositionPct + '% of the money managed.'),
      h('div', { class: 'muted', style: 'margin-top:4px' }, 'Stops buying for the day after a ' + p.dailyLossLimitPct + '% loss, and pauses everything new if the account falls ' + p.drawdownPausePct + '% from its peak. Strategies: ' + p.strategies.map(stratLabel).join(', ') + '.' + (p.cappedByLiveLimit ? ' Live orders are capped by the server limit (MAX_LIVE_TRADE_DOLLARS).' : ''))));
  }
  root.append(h('h2', {}, 'Mode'));
  root.append(h('div', { class: 'seg' },
    ['paper', 'signals', 'live'].map((m) => h('button', { class: st.mode === m ? 'on' : '', disabled: busy, onclick: () => st.mode !== m && setMode(m) }, m === 'paper' ? 'Paper' : m === 'signals' ? 'Signals only' : 'Live'))
  ));
  root.append(h('p', { class: 'muted', style: 'font-size:12px;margin:6px 2px' },
    st.mode === 'paper' ? 'Simulated account with real prices. Safe for testing.' :
    st.mode === 'signals' ? 'Finds and explains trades. You place them yourself.' :
    'Real orders. Per-trade size is capped on the server.') );
  root.append(h('p', { class: 'muted', style: 'font-size:12px;margin:0 2px 6px' }, 'Last scan: ' + ago(state.lastScanAt) + (st.autoRun ? ' · scanning every ' + st.tickMinutes + ' min, exits checked every ' + st.exitCheckMinutes + ' min' : ' · automatic scanning is off')));

  root.append(h('div', { class: 'actions' },
    h('button', { class: 'block', disabled: busy, onclick: () => act(async () => { const r = await api('/api/tick', { method: 'POST', body: { force: true } }); if (r.skipped) alert('Skipped: ' + r.skipped); }) }, busy ? 'Working…' : 'Scan now')));
  root.append(h('div', { class: 'actions cols' },
    st.paused
      ? h('button', { class: 'sec', onclick: () => act(() => api('/api/settings', { method: 'POST', body: { paused: false } })) }, 'Resume trading')
      : h('button', { class: 'sec', onclick: () => act(() => api('/api/kill', { method: 'POST' })) }, 'Pause new trades'),
    st.mode === 'paper' ? h('button', { class: 'sec', onclick: () => confirm('Reset the paper account and delete paper trades?') && act(() => api('/api/paper/reset', { method: 'POST' })) }, 'Reset paper') : null,
    st.mode !== 'signals' ? h('button', { class: 'danger', onclick: () => confirm('Sell every position this app opened (' + st.mode + ' mode) at market and pause new trades?') && act(async () => { const r = await api('/api/flatten', { method: 'POST', body: { confirm: 'SELL EVERYTHING' } }); alert('Sold ' + r.sold.length + (r.errors.length ? '; failed: ' + r.errors.join(', ') : '')); }) }, 'Sell everything') : null
  ));

  root.append(h('h2', {}, 'Open positions'));
  root.append(openTable() || h('div', { class: 'empty' }, 'No open positions.'));
  root.append(h('h2', {}, 'Recent signals'));
  root.append(lazyBox('/api/signals', (j) => table(['When', 'Symbol', 'Strategy', 'Result', 'Price', 'Why'], j.filter((v) => (v.assetClass || 'stocks') === viewCls()).slice(0, 12).map((v) => [when(v.t), v.symbol, stratLabel(v.strategy || 'pullback'), h('span', { class: v.status === 'executed' ? 'good' : v.status === 'error' ? 'bad' : 'muted' }, v.status), money(v.price), v.reason + (v.earnings === 'unchecked' ? ' (earnings unchecked)' : '') + (v.ai && v.ai.risks && v.ai.risks.length ? ' (risks: ' + v.ai.risks.join('; ') + ')' : '')])), 'No signals yet. Tap Scan now.'));
  root.append(h('h2', {}, 'Closed trades'));
  root.append(lazyBox('/api/trades', (all) => table(['Symbol', 'Strategy', 'Closed', 'Price', 'P&L', 'Reason'], all.filter((t) => t.status === 'closed' && t.mode === st.mode && (t.assetClass || 'stocks') === viewCls()).slice(0, 20).map((t) => [t.symbol, stratLabel(t.strategy || 'pullback'), when(t.exitAt), money(t.entryPrice) + ' → ' + money(t.exitPrice), h('div', {}, h('span', { class: cls(t.pnl) }, money(t.pnl) + ' (' + (t.pnlPct || 0).toFixed(1) + '%)'), t.fees ? h('div', { class: 'muted', style: 'font-size:11px' }, 'after ' + money(t.fees) + ' fees') : null, t.estimated ? h('div', { class: 'muted', style: 'font-size:11px' }, 'estimate') : null), t.exitReason])), 'No closed trades in this mode yet.'));
  root.append(h('h2', {}, 'Activity log'));
  const logBox = h('div', { class: 'card log' }, h('div', { class: 'muted' }, 'Loading…'));
  root.append(logBox);
  api('/api/log').then((j) => logBox.replaceChildren(...(j.length ? j.map((l) => h('div', { class: l.level === 'error' ? 'bad' : 'muted' }, when(l.t) + '  ' + l.msg)) : [h('div', { class: 'muted' }, 'Nothing yet.')]))).catch(() => {});
  return root;
}

function lazyBox(path, draw, emptyText) {
  const box = h('div', {}, h('div', { class: 'empty' }, 'Loading…'));
  api(path).then((j) => box.replaceChildren(draw(j) || h('div', { class: 'empty' }, emptyText))).catch(() => box.replaceChildren(h('div', { class: 'empty' }, emptyText)));
  return box;
}

function openTable() {
  const px = Object.fromEntries((lane().positions || []).map((p) => [p.symbol, p]));
  const rows = lane().openTrades.map((t) => {
    const p = px[t.symbol];
    const pnl = p ? (p.price - t.entryPrice) * t.qty : null;
    return [t.symbol, stratLabel(t.strategy || 'pullback'), t.qty.toFixed(4), money(t.entryPrice), p ? money(p.price) : '–', h('span', { class: cls(pnl) }, money(pnl)), money(t.target) + ' / ' + money(t.stop) + (t.bracket ? ' (at broker)' : ''), t.timeStopDays + 'd', t.ai ? t.ai.decision : '–'];
  });
  return table(['Symbol', 'Strategy', 'Shares', 'Bought', 'Now', 'P&L', 'Target / stop', 'Time stop', 'AI'], rows);
}

// ---------------- performance ----------------
function chart(curve, spy) {
  const W = 640, H = 220, P = 56;
  const all = curve.map((p) => p.equity).concat(spy ? spy.map((p) => p.equity) : []);
  let lo = Math.min(...all), hi = Math.max(...all);
  if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
  const t0 = new Date(curve[0].t).getTime(), t1 = new Date(curve[curve.length - 1].t).getTime() || t0 + 1;
  const X = (t) => P + ((new Date(t).getTime() - t0) / Math.max(1, t1 - t0)) * (W - P - 8);
  const Y = (v) => H - 22 - ((v - lo) / (hi - lo)) * (H - 22 - 12);
  const path = (pts) => pts.map((p, i) => (i ? 'L' : 'M') + X(p.t).toFixed(1) + ' ' + Y(p.equity).toFixed(1)).join(' ');
  return s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': 'Account value over time compared with ' + bmName() },
    s('line', { x1: P, y1: Y(lo), x2: W - 8, y2: Y(lo), class: 'axis' }),
    s('text', { x: 4, y: Y(hi) + 4, class: 'lbl' }, '$' + hi.toFixed(2)),
    s('text', { x: 4, y: Y(lo) + 4, class: 'lbl' }, '$' + lo.toFixed(2)),
    s('text', { x: P, y: H - 4, class: 'lbl' }, new Date(curve[0].t).toLocaleDateString([], { month: 'short', day: 'numeric' })),
    s('text', { x: W - 60, y: H - 4, class: 'lbl' }, new Date(curve[curve.length - 1].t).toLocaleDateString([], { month: 'short', day: 'numeric' })),
    spy ? s('path', { d: path(spy), class: 'l-spy' }) : null,
    s('path', { d: path(curve), class: 'l-eq' }));
}

function performance() {
  const root = h('div', {});
  const box = h('div', {}, h('div', { class: 'empty' }, 'Loading…'));
  root.append(box);
  api('/api/performance?class=' + viewCls()).then((p) => {
    const out = [];
    out.push(h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'sec sm', onclick: async () => { try { saveText('trades-' + viewCls() + '.csv', await api('/api/trades.csv?class=' + viewCls())); } catch (e) { alert(e.message); } } }, 'Download trades (CSV)')));
    out.push(h('div', { class: 'grid', style: 'margin-top:10px' }, stat('Closed trades', String(p.totals.closed)), stat('Total P&L', money(p.totals.pnl), cls(p.totals.pnl)), stat('Win rate', pct(p.totals.winRate))));
    out.push(h('h2', {}, 'Account value vs. holding ' + bmName()));
    if (p.curve.length >= 2) {
      const last = p.curve[p.curve.length - 1].equity, first = p.curve[0].equity;
      const spyEnd = p.spy ? p.spy[p.spy.length - 1].equity : null;
      out.push(h('div', { class: 'card' },
        chart(p.curve, p.spy),
        h('div', { class: 'legend' }, h('span', { class: 'sw eq' }), 'Your account ' + pp((last / first - 1) * 100, 2), p.spy ? [h('span', { class: 'sw spy' }), 'Holding ' + bmName() + ' ' + pp((spyEnd / first - 1) * 100, 2)] : null),
        p.note ? h('div', { class: 'muted', style: 'font-size:12px;margin-top:6px' }, p.note) : null));
    } else out.push(h('div', { class: 'empty' }, 'The chart appears after the first couple of scans. Turn on automatic scanning in Settings to build it.'));
    const g = (title, rows, label) => {
      out.push(h('h2', {}, title));
      out.push(table([label, 'Trades', 'Win rate', 'Avg trade', 'P&L'], rows.map((r) => [r.key, r.trades, pct(r.winRate), pp(r.avgPct, 2), h('span', { class: cls(r.pnl) }, money(r.pnl))])) || h('div', { class: 'empty' }, 'Nothing closed yet.'));
    };
    g('By strategy', p.byStrategy.map((r) => ({ ...r, key: stratLabel(r.key) })), 'Strategy');
    g('By symbol', p.bySymbol, 'Symbol');
    g('By exit reason', p.byReason, 'Exit');
    box.replaceChildren(...out);
  }).catch((e) => box.replaceChildren(h('div', { class: 'empty' }, e.message)));
  return root;
}

// ---------------- backtest ----------------
function backtestView() {
  const root = h('div', {});
  const strat = h('select', {}, h('option', { value: 'all' }, 'All strategies'), state.strategies.map((x) => h('option', { value: x.id }, x.label)));
  const years = h('select', {}, [1, 2, 3, 5, 10].map((y) => h('option', { value: y, selected: y === 5 }, y + ' year' + (y > 1 ? 's' : ''))));
  root.append(h('p', { class: 'muted' }, 'Replays a strategy over past prices on your watchlist, buying the next day\'s open with a little slippage, and compares it with simply holding ' + bmName() + '. It uses your current size and position limits.'));
  root.append(h('div', { class: 'row' }, h('div', {}, h('label', {}, 'Strategy'), strat), h('div', {}, h('label', {}, 'History'), years), h('div', { style: 'align-self:end' }, h('button', { disabled: busy, onclick: () => act(async () => { backtest = await api('/api/backtest', { method: 'POST', body: { strategy: strat.value, years: Number(years.value), assetClass: viewCls() } }); }) }, busy ? 'Running…' : 'Run backtest'))));
  if (backtest) {
    for (const [sym, why] of Object.entries(backtest.skipped || {})) root.append(h('div', { class: 'banner' }, 'Skipped ' + sym + ': ' + why));
    for (const r of backtest.results) {
      const bm = r.benchmark;
      root.append(h('h2', {}, stratLabel(r.strategy) + ' · ' + r.period.from + ' to ' + r.period.to));
      root.append(h('div', { class: 'grid' },
        stat('Trades', String(r.trades)),
        stat('Win rate', pct(r.winRate)),
        stat('Avg trade', pp(r.avgPct, 2), cls(r.avgPct)),
        stat('Profit factor', r.profitFactor == null ? '–' : r.profitFactor === null || r.profitFactor === Infinity ? '∞' : r.profitFactor.toFixed(2)),
        stat('Account return', pp(r.totalReturnPct), cls(r.totalReturnPct)),
        stat('Max drawdown', pp(r.maxDrawdownPct), 'bad'),
        stat('Holding ' + bmName(), bm ? pp(bm.returnPct) : '–', bm ? cls(bm.returnPct) : ''),
        stat('Worst losing streak', String(r.worstLosingStreak))));
      const half = (x) => (x.trades ? x.trades + ' trades, avg ' + pp(x.avgPct, 2) + ', win ' + pct(x.winRate) : 'no trades');
      root.append(h('div', { class: 'card', style: 'margin-top:10px;font-size:13px' },
        h('div', {}, 'First half: ' + half(r.halves.firstHalf)),
        h('div', {}, 'Second half: ' + half(r.halves.secondHalf)),
        h('div', { class: 'muted', style: 'margin-top:6px' }, 'Capital in use on average: ' + pp(r.avgCapitalDeployedPct, 0) + ' · avg hold ' + (r.avgDaysHeld == null ? '–' : r.avgDaysHeld.toFixed(1)) + ' days · exits: ' + (Object.entries(r.byReason).map(([k, v]) => k + ' ' + v.trades).join(', ') || 'none')),
        r.avgCapitalDeployedPct < 25 ? h('div', { class: 'muted', style: 'margin-top:6px' }, 'Most of the account sits in cash with these limits, which is why the account return can trail ' + bmName() + ' even when the trades themselves win.') : null));
    }
    root.append(h('p', { class: 'muted', style: 'font-size:12px' }, 'Backtests use only the symbols on your watchlist (so winners that survived are over-represented) and past data. They flatter strategies more often than they hurt them. If the two halves disagree, don\'t trust the average.'));
  }
  return root;
}

// ---------------- settings ----------------
function settingsView() {
  const st = state.settings;
  const f = {};
  const list = (v) => v.split(/[\s,]+/).map((v2) => v2.trim().toUpperCase()).filter(Boolean);

  // --- building blocks ---
  const toggle = (key, title, desc, on, opts = {}) => {
    const i = h('input', { type: 'checkbox', checked: !!on, disabled: !!opts.disabled });
    f[key] = i;
    return h('label', { class: 'switch' }, h('span', { class: 'sw-text' }, h('span', { class: 'sw-title' }, title), desc ? h('span', { class: 'sw-desc' }, desc) : null), h('span', { class: 'sw-ctl' }, i, h('span', { class: 'sw-track' })));
  };
  const field = (key, label, value, { full, text } = {}) => { f[key] = h('input', text ? { value } : { type: 'number', step: 'any', value }); return h('div', { class: full ? 'full' : '' }, h('label', {}, label), f[key]); };
  const num = (key, label) => field(key, label, st[key]);
  const lim = (key, label) => field('limit.' + key, label, st.cryptoLimits[key]);
  const sn = (key, label) => field('strategy.' + key, label, st.strategy[key]);
  const brokerSelect = (crypto) => h('select', {}, state.brokers.filter((b) => (b.assetClass === 'crypto') === crypto).map((b) => h('option', { value: b.id, selected: b.id === (crypto ? st.cryptoBroker : st.broker) }, b.label + ' (' + b.status + ')')));
  const brokerNotes = (crypto) => h('details', {}, h('summary', {}, 'About these brokers'), state.brokers.filter((b) => (b.assetClass === 'crypto') === crypto).map((b) => h('div', { class: 'hint' }, h('b', {}, b.label + ': '), b.note)));
  const card = (...kids) => h('div', { class: 'card sect' }, ...kids);
  // Test connection: read-only checks, plus (OKX demo only) a tiny buy-and-sell-back.
  const testBoxes = {};
  const testRow = (assetClass) => {
    const box = (testBoxes[assetClass] = h('div', { class: 'hint' }, 'Checks your keys, balance, a price and the exchange\'s order sizes. Places no order.'));
    const run = (orderTest) => act(async () => {
      box.replaceChildren(h('span', { class: 'muted' }, 'Testing…'));
      const r = await api('/api/broker/test', { method: 'POST', body: { assetClass, orderTest } });
      box.replaceChildren(...r.checks.map((c) => h('div', {}, h('span', { class: c.ok ? 'good' : 'bad' }, (c.ok ? '✓ ' : '✗ ') + c.name), ' ', h('span', { class: 'muted' }, c.detail))));
    });
    const demo = assetClass === 'crypto' && st.cryptoBroker === 'okx';
    return h('div', {}, h('div', { class: 'row' }, h('button', { type: 'button', class: 'sec sm', onclick: () => run(false) }, 'Test connection'), demo ? h('button', { type: 'button', class: 'sec sm', onclick: () => run(true) }, 'Test with a tiny demo order') : null), box);
  };

  // --- smart mode ---
  let risk = st.riskLevel;
  const riskNote = h('div', { class: 'hint' }, (state.riskProfiles[risk] || {}).note);
  const riskBtns = Object.entries(state.riskProfiles).map(([k, v]) => h('button', {
    type: 'button', class: k === risk ? 'on' : '', 'data-k': k,
    onclick: () => { risk = k; riskBtns.forEach((b) => b.classList.toggle('on', b.dataset.k === k)); riskNote.textContent = v.note; },
  }, v.label));
  f.riskLevel = { get value() { return risk; } };

  const smartCard = card(
    h('h3', {}, 'Smart mode'),
    h('div', { class: 'hint' }, 'Sizes every trade from your real balance and the risk level you choose.'),
    toggle('smartMode', 'Use smart mode', 'Replaces the manual sizes and limits below.', st.smartMode),
    h('label', { style: 'margin-top:6px' }, 'Risk level'),
    h('div', { class: 'seg' }, riskBtns), riskNote,
    h('div', { class: 'fields' }, field('smartBudgetStocks', 'Stocks budget ($)', st.smartBudgetStocks), field('smartBudgetCrypto', 'Crypto budget ($)', st.smartBudgetCrypto)),
    h('div', { class: 'hint' }, '0 means the whole account. A budget keeps the app to part of it, so long-term holdings stay out.'),
    h('details', {}, h('summary', {}, 'How smart mode works'),
      h('div', { class: 'hint' }, 'Each trade risks a small slice of your money: size = balance x risk % / distance to the stop, capped at a share of the account. Higher risk means bigger positions, more at once, and bigger swings. Crypto risks half as much per trade. It also stops buying after a bad day and pauses everything new if the account falls too far from its peak. Levels are defaults, not tested numbers.')));

  // --- automation ---
  const auto = toggle('autopilot', 'Autopilot', 'Trades by itself, even after a restart. Pauses new buys if scans keep failing or an account drops too far.', st.autopilot);
  const scan = toggle('autoRun', 'Scan automatically', st.autopilot ? 'On while autopilot is on.' : 'Scans on a timer without autopilot\'s safety stops.', st.autoRun || st.autopilot, { disabled: st.autopilot });
  f.autopilot.onchange = () => { if (f.autopilot.checked) f.autoRun.checked = true; f.autoRun.disabled = f.autopilot.checked; };
  const autoCard = card(
    h('h3', {}, 'Automation'),
    auto, scan,
    toggle('aiReview', 'AI review', 'Claude can veto a trade. It can never start one.', st.aiReview),
    toggle('showWarnings', 'Show warnings and setup tips', 'Real errors always show.', st.showWarnings !== false),
    toggle('useBrackets', 'Keep target and stop at the broker', 'Live only. Alpaca whole-share stocks and OKX crypto hold the sell orders themselves, so they still work when this app is off.', st.useBrackets),
    h('div', { class: 'fields' }, num('tickMinutes', 'Scan every (min)'), num('exitCheckMinutes', 'Check exits every (min)'), num('autopilotFailLimit', 'Pause after fails'), num('autopilotDrawdownPct', 'Pause at drop (%)'), field('blocklist', 'Never trade (either side)', (st.blocklist || []).join(', '), { full: true, text: true })));

  // --- strategies ---
  const checks = state.strategies.map((x) => { const row = toggle('strat.' + x.id, x.label, null, st.enabledStrategies.includes(x.id)); f['strat.' + x.id].dataset.id = x.id; return row; });
  const stratCard = card(h('h3', {}, 'Strategies'), h('div', { class: 'hint' }, 'What to scan for, on both sides. Smart mode picks its own set for the level you choose.'), checks);

  // --- stocks ---
  const stockCard = card(
    h('h3', {}, 'Stocks & ETFs'),
    toggle('stocksEnabled', 'Trade stocks', 'Follows market hours.', st.stocksEnabled),
    h('div', { class: 'fields' },
      h('div', { class: 'full' }, h('label', {}, 'Broker for live mode'), (f.broker = brokerSelect(false))),
      field('watchlist', 'Watchlist (comma separated)', st.watchlist.join(', '), { full: true, text: true })),
    brokerNotes(false), testRow('stocks'),
    h('details', {}, h('summary', {}, st.smartMode ? 'Manual sizes and limits (not used in smart mode)' : 'Manual sizes and limits'),
      h('div', { class: 'fields' }, num('tradeDollars', 'Per trade ($)'), num('maxPositions', 'Max positions'), num('maxPositionPct', 'Max % in one trade'), num('maxTradesPerDay', 'Max trades per day'), num('dailyLossLimitPct', 'Daily loss stop (%)'), num('minPrice', 'Minimum price ($)'), num('earningsBlockDays', 'Skip if earnings within (days)')),
      toggle('requireEarningsData', 'Require earnings data', 'Skip trades when earnings can\'t be checked.', st.requireEarningsData)),
    h('details', {}, h('summary', {}, 'Pullback strategy numbers'),
      h('div', { class: 'fields' }, sn('rsiMin', 'RSI min'), sn('rsiMax', 'RSI max'), sn('targetPct', 'Target (%)'), sn('stopPct', 'Stop (%)'), sn('timeStopDays', 'Time stop (days)'))));

  // --- crypto ---
  const cryptoExits = state.strategies.map((x) => h('div', { class: 'fields' }, h('div', { class: 'full', style: 'font-weight:600;font-size:13px' }, x.label), ...['targetPct:Target (%)', 'stopPct:Stop (%)', 'timeStopDays:Time stop (days)'].map((t) => { const [pk, label] = t.split(':'); return field('crypto.' + x.id + '.' + pk, label, x.cryptoParams[pk]); })));
  const cryptoCard = card(
    h('h3', {}, 'Crypto'),
    toggle('cryptoEnabled', 'Trade crypto', 'Runs around the clock. Coins you already hold are left alone.', st.cryptoEnabled),
    h('div', { class: 'fields' },
      h('div', { class: 'full' }, h('label', {}, 'Broker for live mode'), (f.cryptoBroker = brokerSelect(true))),
      field('cryptoWatchlist', 'Watchlist (like BTC-USD)', st.cryptoWatchlist.join(', '), { full: true, text: true })),
    brokerNotes(true), testRow('crypto'),
    h('details', {}, h('summary', {}, st.smartMode ? 'Manual sizes and limits (not used in smart mode)' : 'Manual sizes and limits'),
      h('div', { class: 'fields' }, lim('tradeDollars', 'Per trade ($)'), lim('maxPositions', 'Max positions'), lim('maxPositionPct', 'Max % in one trade'), lim('maxTradesPerDay', 'Max trades per day'), lim('dailyLossLimitPct', 'Daily loss stop (%)'))),
    h('details', {}, h('summary', {}, 'Crypto exit numbers'),
      h('div', { class: 'hint' }, 'Starting guesses, not tested numbers. Backtest them before going live.'), cryptoExits));

  // --- save ---
  const save = () => act(async () => {
    const body = {
      smartMode: f.smartMode.checked, riskLevel: f.riskLevel.value,
      stocksEnabled: f.stocksEnabled.checked, cryptoEnabled: f.cryptoEnabled.checked,
      broker: f.broker.value, cryptoBroker: f.cryptoBroker.value,
      autopilot: f.autopilot.checked, autoRun: f.autoRun.checked || f.autopilot.checked,
      aiReview: f.aiReview.checked, showWarnings: f.showWarnings.checked, useBrackets: f.useBrackets.checked,
      requireEarningsData: f.requireEarningsData.checked,
      watchlist: list(f.watchlist.value), cryptoWatchlist: list(f.cryptoWatchlist.value), blocklist: list(f.blocklist.value),
      strategy: {}, cryptoParams: {}, cryptoLimits: {},
      enabledStrategies: Object.entries(f).filter(([k, el]) => k.startsWith('strat.') && el.checked).map(([, el]) => el.dataset.id),
    };
    if (!body.enabledStrategies.length) throw new Error('Pick at least one strategy.');
    for (const [k, el] of Object.entries(f)) {
      if (el.type !== 'number') continue;
      if (k.startsWith('strategy.')) body.strategy[k.slice(9)] = Number(el.value);
      else if (k.startsWith('limit.')) body.cryptoLimits[k.slice(6)] = Number(el.value);
      else if (k.startsWith('crypto.')) { const [, sid, pk] = k.split('.'); (body.cryptoParams[sid] = body.cryptoParams[sid] || {})[pk] = Number(el.value); }
      else body[k] = Number(el.value);
    }
    if (body.autopilot && !st.autopilot && st.mode === 'live') {
      const typed = prompt('Autopilot in LIVE mode places real orders with nobody watching.\nType ENABLE LIVE TRADING to continue.');
      if (typed !== 'ENABLE LIVE TRADING') return;
      body.confirm = typed;
    }
    const r = await api('/api/settings', { method: 'POST', body });
    if (r.rejected && r.rejected.length) alert('Not saved (invalid): ' + r.rejected.join(', '));
  });

  const root = h('div', {});
  root.append(smartCard, autoCard, stratCard, stockCard, cryptoCard);
  // ---- AI watchlist ideas ----
  const ideaBox = h('div', {});
  const drawIdeas = () => ideaBox.replaceChildren(...(ideas ? ideas.map((i) => h('div', { class: 'idea' }, h('div', {}, h('b', {}, i.symbol), ' ', i.price ? money(i.price) : '', ' ', h('span', { class: 'muted' }, i.ok ? '' : '(no usable data or too cheap)')), h('div', { class: 'muted', style: 'font-size:12px' }, i.reason), i.ok ? h('button', { class: 'sec', onclick: () => act(() => api('/api/settings', { method: 'POST', body: viewCls() === 'crypto' ? { cryptoWatchlist: st.cryptoWatchlist.concat(i.symbol) } : { watchlist: st.watchlist.concat(i.symbol) } })) }, 'Add to watchlist') : null)) : []));
  drawIdeas();
  root.append(h('div', { class: 'card', style: 'margin-top:10px' }, h('h3', {}, 'Watchlist ideas'), h('p', { class: 'muted', style: 'font-size:12px' }, 'Claude suggests tickers to consider. These are ideas, not research: its knowledge can be out of date, and nothing is added until you tap Add.'),
    h('button', { class: 'sec', disabled: busy || !state.aiAvailable, onclick: () => act(async () => { ideas = (await api('/api/suggest', { method: 'POST', body: { assetClass: viewCls() } })).ideas; }) }, state.aiAvailable ? 'Suggest tickers' : 'Needs ANTHROPIC_API_KEY'), ideaBox));

  // ---- Schwab ----
  const sc = state.schwab;
  if (!GH()) root.append(h('div', { class: 'card', style: 'margin-top:10px' }, h('h3', {}, 'Schwab connection'),
    h('p', { class: 'muted', style: 'font-size:12px' }, sc.connected ? (sc.expired ? 'Connected, but the login has expired.' : 'Connected. Login lasts about 7 days; ' + sc.daysLeft + ' left.') : sc.configured ? 'Not connected yet.' : 'Set SCHWAB_APP_KEY, SCHWAB_APP_SECRET and SCHWAB_REDIRECT_URI on the server first.'),
    h('button', { class: 'sec', disabled: !sc.configured, onclick: () => act(async () => { const r = await api('/api/schwab/link', { method: 'POST' }); window.open(r.url, '_blank', 'noopener'); }) }, sc.connected ? 'Reconnect Schwab' : 'Connect Schwab')));

  // ---- two-factor ----
  if (!GH()) root.append(twoFaCard());
  root.append(h('div', { class: 'card muted', style: 'margin-top:10px;font-size:12px' }, (GH() ? 'Runner checks: ' : 'Server checks: ') + 'phone alerts ' + (state.notificationsOn ? 'on' : 'off') + ' · uptime ping ' + (state.healthcheckOn ? 'on' : 'off (set HEALTHCHECK_URL; /healthz is the endpoint to monitor)') + ' · earnings feed ' + (state.earningsAvailable ? 'on' : 'off') + ' · news ' + (state.newsAvailable ? 'on' : 'off') + ' · data ' + state.dataProvider));
  root.append(h('div', { class: 'savebar' }, h('button', { class: 'block', disabled: busy, onclick: save }, 'Save changes')));
  return root;
}

function twoFaCard() {
  const card = h('div', { class: 'card', style: 'margin-top:10px' }, h('h3', {}, 'Two-step login'));
  const code = h('input', { type: 'text', inputmode: 'numeric', maxlength: '6', placeholder: '6-digit code' });
  if (state.twoFactorOn) {
    card.append(h('p', { class: 'muted', style: 'font-size:12px' }, 'On. Signing in needs your password and a code from your authenticator app.'), h('div', { class: 'row' }, code, h('button', { class: 'sec', onclick: () => act(async () => { await api('/api/2fa/disable', { method: 'POST', body: { code: code.value } }); }) }, 'Turn off (enter a fresh code)')));
  } else if (twoFa) {
    card.append(
      h('p', { style: 'font-size:13px' }, 'In your authenticator app (Google Authenticator, 1Password, Authy) add an account manually with this key, then enter the 6-digit code it shows.'),
      h('div', { class: 'secret' }, twoFa.secret),
      h('div', { class: 'row' }, code, h('button', { onclick: () => act(async () => { await api('/api/2fa/enable', { method: 'POST', body: { code: code.value } }); twoFa = null; }) }, 'Turn on')));
  } else {
    card.append(h('p', { class: 'muted', style: 'font-size:12px' }, 'Off. Strongly recommended before you reach the app over the internet or use live mode.'), h('button', { class: 'sec', onclick: () => act(async () => { twoFa = await api('/api/2fa/setup', { method: 'POST' }); }) }, 'Set up'));
  }
  return card;
}

// ---------------- render loop ----------------
async function refresh() {
  if (!token) { state = null; return render(); }
  try { state = await api('/api/status'); loadError = null; } catch (e) { state = null; loadError = e.message; }
  render();
}

function render() {
  if (!token) return $app.replaceChildren(loginView());
  if (!state) return $app.replaceChildren(h('main', {}, h('p', { class: loadError ? 'bad' : 'muted' }, loadError || 'Loading…'), loadError ? h('div', { class: 'row' }, h('button', { class: 'sec', onclick: () => refresh() }, 'Try again'), GH() ? h('button', { class: 'sec', onclick: () => { token = null; GH().signOut(); render(); } }, 'Sign out') : null) : null));
  const view = tab === 'performance' ? performance() : tab === 'backtest' ? backtestView() : tab === 'settings' ? settingsView() : dashboard();
  $app.replaceChildren(shell(view));
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
refresh();
setInterval(() => { if (token && !busy && !document.hidden && tab === 'dashboard') refresh(); }, 60000);
