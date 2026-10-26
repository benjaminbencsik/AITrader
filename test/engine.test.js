'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../server/store');
const { Engine } = require('../server/engine');
const { createApp } = require('../server/index');
const { pullbackCloses, downtrendCloses, FakeData } = require('./helpers');

function setup({ aiReview, env = {}, settings = {}, now } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitrader-'));
  const store = new Store(path.join(dir, 'state.json'));
  Object.assign(store.state.settings, { watchlist: ['AAA', 'BBB'], ...settings });
  store.state.paper.cash = 100;
  const data = new FakeData({ AAA: pullbackCloses(), BBB: downtrendCloses() });
  const engine = new Engine({ store, data, env, aiReview, now });
  return { store, data, engine, dir };
}

test('paper: buys the setup, ignores the downtrend, then sells at target', async () => {
  const { store, data, engine } = setup();
  const r = await engine.tick({ force: true });
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].symbol, 'AAA');
  const t = store.state.trades[0];
  assert.equal(t.status, 'open');
  assert.ok(Math.abs(store.state.paper.cash - 95) < 1e-9);

  // price jumps past the target
  data.setPrice('AAA', t.target + 0.5);
  const r2 = await engine.tick({ force: true });
  assert.equal(r2.exits.length, 1);
  assert.equal(r2.exits[0].reason, 'target');
  assert.equal(store.state.trades[0].status, 'closed');
  assert.ok(store.state.trades[0].pnl > 0);
  assert.ok(store.state.paper.cash > 95);
  assert.equal(Object.keys(store.state.paper.positions).length, 0);
});

test('paper: stop loss sells at a loss', async () => {
  const { store, data, engine } = setup();
  await engine.tick({ force: true });
  const t = store.state.trades[0];
  data.setPrice('AAA', t.stop - 0.5);
  const r = await engine.tick({ force: true });
  assert.equal(r.exits[0].reason, 'stop');
  assert.ok(store.state.trades[0].pnl < 0);
});

test('paper: time stop closes a stale position', async () => {
  let clock = new Date();
  const { store, engine } = setup({ now: () => clock });
  await engine.tick({ force: true });
  clock = new Date(Date.now() + 10 * 86400e3);
  const r = await engine.tick({ force: true });
  assert.equal(r.exits[0].reason, 'time stop');
});

test('does not buy the same symbol twice or exceed max positions', async () => {
  const { store, engine } = setup();
  await engine.tick({ force: true });
  const r = await engine.tick({ force: true });
  assert.equal(r.entries.length, 0);
  assert.equal(store.state.trades.length, 1);
});

test('AI veto blocks the trade and is recorded', async () => {
  const aiReview = async () => ({ decision: 'reject', confidence: 0.8, reasoning: 'looks fragile', risks: [] });
  const { store, engine } = setup({ aiReview, env: { ANTHROPIC_API_KEY: 'x' } });
  const r = await engine.tick({ force: true });
  assert.equal(r.entries.length, 0);
  assert.equal(store.state.signals[0].status, 'vetoed');
  assert.equal(store.state.trades.length, 0);
});

test('AI failure fails closed (no unreviewed trade)', async () => {
  const aiReview = async () => {
    throw new Error('API down');
  };
  const { store, engine } = setup({ aiReview, env: { ANTHROPIC_API_KEY: 'x' } });
  const r = await engine.tick({ force: true });
  assert.equal(r.entries.length, 0);
  assert.equal(store.state.signals[0].status, 'blocked');
  assert.match(store.state.signals[0].reason, /AI review failed/);
});

test('AI approval lets the trade through and is stored on the trade', async () => {
  const aiReview = async () => ({ decision: 'approve', confidence: 0.7, reasoning: 'fine', risks: ['earnings unknown'] });
  const { store, engine } = setup({ aiReview, env: { ANTHROPIC_API_KEY: 'x' } });
  await engine.tick({ force: true });
  assert.equal(store.state.trades[0].ai.decision, 'approve');
});

test('signals mode records the signal but places no order', async () => {
  const { store, engine } = setup({ settings: { mode: 'signals' } });
  const r = await engine.tick({ force: true });
  assert.equal(r.entries.length, 0);
  assert.equal(store.state.signals[0].status, 'signal');
  assert.equal(store.state.trades.length, 0);
  assert.equal(store.state.paper.cash, 100);
});

test('pause stops new entries but still manages exits', async () => {
  const { store, data, engine } = setup();
  await engine.tick({ force: true });
  store.state.settings.paused = true;
  data.setPrice('AAA', store.state.trades[0].target + 1);
  const r = await engine.tick({ force: true });
  assert.equal(r.exits.length, 1);
  assert.equal(r.entries.length, 0);
});

test('market-closed ticks are skipped for real data providers', async () => {
  const { engine } = setup({ now: () => new Date('2026-10-24T15:00:00Z') }); // Saturday
  const r = await engine.tick();
  assert.equal(r.skipped, 'market closed');
});

test('a broken symbol does not stop the scan', async () => {
  const { store, engine } = setup({ settings: { watchlist: ['NOPE', 'AAA'] } });
  const r = await engine.tick({ force: true });
  assert.equal(r.entries.length, 1);
  assert.ok(r.errors.some((e) => e.startsWith('NOPE')));
});

// ---- HTTP API ----
async function boot(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitrader-api-'));
  const e = { APP_PASSWORD: 'correct horse battery', DATA_DIR: dir, DATA_PROVIDER: 'demo', ...env };
  const app = createApp({ env: e });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (p, { method = 'GET', body, token } = {}) => {
    const r = await fetch(base + p, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { app, call, close: () => app.server.close() };
}

test('API: refuses to start without a password', () => {
  assert.throws(() => createApp({ env: {} }), /APP_PASSWORD/);
});

test('API: auth required, wrong password rejected, login works', async () => {
  const { call, close } = await boot();
  try {
    assert.equal((await call('/api/status')).status, 401);
    assert.equal((await call('/api/login', { method: 'POST', body: { password: 'nope' } })).status, 401);
    const ok = await call('/api/login', { method: 'POST', body: { password: 'correct horse battery' } });
    assert.equal(ok.status, 200);
    const st = await call('/api/status', { token: ok.body.token });
    assert.equal(st.status, 200);
    assert.equal(st.body.settings.mode, 'paper');
    assert.equal(st.body.account.equity, 100);
    assert.equal((await call('/api/status', { token: ok.body.token + 'x' })).status, 401);
  } finally {
    close();
  }
});

test('API: login is rate limited after repeated failures', async () => {
  const { call, close } = await boot();
  try {
    for (let i = 0; i < 5; i++) await call('/api/login', { method: 'POST', body: { password: 'bad' + i } });
    const r = await call('/api/login', { method: 'POST', body: { password: 'correct horse battery' } });
    assert.equal(r.status, 429);
  } finally {
    close();
  }
});

test('API: settings are validated and live mode needs confirmation and keys', async () => {
  const { call, close } = await boot();
  try {
    const { body } = await call('/api/login', { method: 'POST', body: { password: 'correct horse battery' } });
    const token = body.token;
    const bad = await call('/api/settings', { method: 'POST', token, body: { tradeDollars: -5, watchlist: ['<script>'], mode: 'yolo' } });
    assert.deepEqual(bad.body.rejected.sort(), ['mode', 'tradeDollars', 'watchlist']);
    assert.equal(bad.body.settings.mode, 'paper');

    const noConfirm = await call('/api/settings', { method: 'POST', token, body: { mode: 'live', broker: 'alpaca' } });
    assert.equal(noConfirm.status, 400);
    assert.match(noConfirm.body.error, /ENABLE LIVE TRADING/);

    const noKeys = await call('/api/settings', { method: 'POST', token, body: { mode: 'live', broker: 'alpaca', confirm: 'ENABLE LIVE TRADING' } });
    assert.equal(noKeys.status, 400);
    assert.match(noKeys.body.error, /ALPACA_KEY_ID/);

    const unavailable = await call('/api/settings', { method: 'POST', token, body: { mode: 'live', broker: 'robinhood', confirm: 'ENABLE LIVE TRADING' } });
    assert.equal(unavailable.status, 400);

    const good = await call('/api/settings', { method: 'POST', token, body: { tradeDollars: 7, strategy: { targetPct: 4 } } });
    assert.equal(good.body.settings.tradeDollars, 7);
    assert.equal(good.body.settings.strategy.targetPct, 4);
    assert.equal(good.body.settings.strategy.stopPct, 3);
  } finally {
    close();
  }
});

test('API: demo scan, pause, and paper reset', async () => {
  const { call, close } = await boot();
  try {
    const { body } = await call('/api/login', { method: 'POST', body: { password: 'correct horse battery' } });
    const token = body.token;
    const tick = await call('/api/tick', { method: 'POST', token, body: { force: true } });
    assert.equal(tick.status, 200);
    assert.ok(Array.isArray(tick.body.signals));
    assert.equal((await call('/api/kill', { method: 'POST', token })).body.paused, true);
    assert.equal((await call('/api/status', { token })).body.settings.paused, true);
    assert.equal((await call('/api/paper/reset', { method: 'POST', token })).status, 200);
    assert.equal((await call('/api/log', { token })).status, 200);
  } finally {
    close();
  }
});

test('API: static files are served and path traversal is blocked', async () => {
  const { app, close } = await boot();
  try {
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const bad = await fetch(base + '/..%2f..%2fpackage.json');
    assert.ok([403, 404].includes(bad.status));
  } finally {
    close();
  }
});
