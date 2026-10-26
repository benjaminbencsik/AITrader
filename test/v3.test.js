'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../server/store');
const { Engine } = require('../server/engine');
const { createBroker } = require('../server/brokers');
const { OrderSizeError } = require('../server/brokers/crypto');
const { isMarketOpen, marketHoliday } = require('../server/indicators');
const { tradesToCsv } = require('../server/csv');
const { testBroker } = require('../server/brokers/check');
const { pullbackCloses, FakeData } = require('./helpers');

function mockFetch(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    const u = new URL(url);
    const key = `${opts.method || 'GET'} ${u.pathname}`;
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ key, url: String(url), body, headers: opts.headers || {} });
    const hit = Object.entries(routes).find(([k]) => key === k || key.startsWith(k));
    if (!hit) return { ok: false, status: 404, text: async () => `no mock for ${key}`, json: async () => ({}) };
    const out = typeof hit[1] === 'function' ? hit[1](body, u) : hit[1];
    return { ok: true, status: 200, text: async () => JSON.stringify(out), json: async () => out };
  };
  fn.calls = calls;
  return fn;
}
const priced = (map) => ({ name: 'fake', getQuote: async (s) => map[s] });
const OKX_ENV = { OKX_API_KEY: 'k', OKX_API_SECRET: 's', OKX_PASSPHRASE: 'p' };

// ---------------------------------------------------------------- holiday calendar
test('market calendar: holidays closed, early closes end at 1pm, normal days unchanged', () => {
  const at = (iso) => new Date(iso);
  assert.equal(isMarketOpen(at('2026-11-26T15:00:00Z')), false, 'Thanksgiving');
  assert.equal(marketHoliday(at('2026-11-26T15:00:00Z')), 'Thanksgiving');
  assert.equal(isMarketOpen(at('2026-11-27T17:00:00Z')), true, 'day after Thanksgiving, 12:00 ET');
  assert.equal(isMarketOpen(at('2026-11-27T19:00:00Z')), false, 'day after Thanksgiving closes at 1pm ET');
  assert.equal(isMarketOpen(at('2026-04-03T15:00:00Z')), false, 'Good Friday 2026');
  assert.equal(isMarketOpen(at('2026-07-03T15:00:00Z')), false, 'July 4 falls on Saturday: observed Friday');
  assert.equal(isMarketOpen(at('2026-06-19T15:00:00Z')), false, 'Juneteenth');
  assert.equal(isMarketOpen(at('2027-12-24T15:00:00Z')), false, 'Christmas on Saturday: observed Friday Dec 24');
  assert.equal(isMarketOpen(at('2026-12-24T17:00:00Z')), true);
  assert.equal(isMarketOpen(at('2026-12-24T19:00:00Z')), false, 'Christmas Eve closes at 1pm');
  assert.equal(isMarketOpen(at('2026-10-27T15:00:00Z')), true, 'ordinary Tuesday');
  assert.equal(isMarketOpen(at('2026-10-27T13:00:00Z')), false, 'before 9:30 ET');
  assert.equal(isMarketOpen(at('2027-12-31T15:00:00Z')), true, "New Year's on Saturday is NOT observed on Dec 31");
  assert.equal(marketHoliday(at('2026-10-27T15:00:00Z')), null);
});

// ---------------------------------------------------------------- OKX order limits and ids
const instruments = { 'GET /api/v5/public/instruments': { code: '0', data: [{ minSz: '0.01', lotSz: '0.001' }] } };

test('OKX: an order under the minimum size is skipped before it is sent, with a plain message', async () => {
  const f = mockFetch({ ...instruments, 'POST /api/v5/trade/order': { code: '0', data: [{ ordId: '1' }] } });
  const b = createBroker('okx', { env: OKX_ENV, data: priced({ 'BTC-USD': 50000 }), fetchImpl: f });
  await assert.rejects(() => b.placeOrder({ symbol: 'BTC-USD', side: 'buy', notional: 5 }), (e) => e instanceof OrderSizeError && e.code === 'size' && /needs at least 0\.01/.test(e.message) && /\$500\.00/.test(e.message));
  assert.ok(!f.calls.some((c) => c.key === 'POST /api/v5/trade/order'), 'nothing was sent to the exchange');
});

test('OKX: sell sizes round down to the lot size; order ids carry the instrument so a restart can still look them up', async () => {
  const f = mockFetch({
    ...instruments,
    'POST /api/v5/trade/order': { code: '0', data: [{ ordId: '77' }] },
    'GET /api/v5/trade/order': { code: '0', data: [{ state: 'filled', accFillSz: '0.0123', avgPx: '50000', fee: '-0.0000123', feeCcy: 'BTC' }] },
    'GET /api/v5/account/balance': { code: '0', data: [{ details: [{ ccy: 'BTC', availBal: '0.01239', eq: '0.01239' }] }] },
  });
  const b = createBroker('okx', { env: OKX_ENV, data: priced({ 'BTC-USD': 50000 }), fetchImpl: f });
  b.pollMs = 1;
  const r = await b.placeOrder({ symbol: 'BTC-USD', side: 'sell', qty: 0.012399 });
  assert.equal(f.calls.find((c) => c.key === 'POST /api/v5/trade/order').body.sz, '0.012');
  assert.equal(r.id, 'BTC-USDT:77');
  const fresh = createBroker('okx', { env: OKX_ENV, data: priced({}), fetchImpl: f }); // a new process knows nothing
  const o = await fresh.getOrder('BTC-USDT:77');
  assert.equal(o.status, 'filled');
  assert.ok(Math.abs(o.filledQty - (0.0123 - 0.0000123)) < 1e-12, 'a fee paid in coins is taken off the quantity received');
  assert.ok(Math.abs(o.fee - 0.0000123 * 50000) < 1e-9, 'fee reported in dollars');
});

test('OKX: exchange-held target and stop (one-cancels-other) can be placed, read and cancelled', async () => {
  const f = mockFetch({
    ...instruments,
    'POST /api/v5/trade/order-algo': { code: '0', data: [{ algoId: 'A1' }] },
    'POST /api/v5/trade/cancel-algos': { code: '0', data: [{ algoId: 'A1' }] },
    'GET /api/v5/trade/order-algo': { code: '0', data: [{ state: 'effective', ordId: '55', actualPx: '' }] },
    'GET /api/v5/trade/order': { code: '0', data: [{ state: 'filled', accFillSz: '0.02', avgPx: '53000', fee: '-1.06', feeCcy: 'USDT' }] },
  });
  const b = createBroker('okx', { env: OKX_ENV, data: priced({ 'BTC-USD': 50000 }), fetchImpl: f });
  const p = await b.placeProtection({ symbol: 'BTC-USD', qty: 0.0205, takeProfit: 53000, stopLoss: 47500 });
  assert.equal(p.id, 'BTC-USDT:A1');
  const body = f.calls.find((c) => c.key === 'POST /api/v5/trade/order-algo').body;
  assert.deepEqual([body.ordType, body.side, body.sz, body.tpTriggerPx, body.slTriggerPx, body.tpOrdPx, body.slOrdPx], ['oco', 'sell', '0.02', '53000', '47500', '-1', '-1']);
  const r = await b.protectionResult(p.id, 53000, 47500);
  assert.deepEqual([r.state, r.price, r.fee], ['target', 53000, 1.06]);
  await b.cancelProtection(p.id);
  assert.deepEqual(f.calls.find((c) => c.key === 'POST /api/v5/trade/cancel-algos').body, [{ algoId: 'A1', instId: 'BTC-USDT' }]);
});

test('Kraken, Coinbase and Robinhood size checks use each exchange\'s own limits', async () => {
  const kf = mockFetch({ 'GET /0/public/AssetPairs': { error: [], result: { XXBTZUSD: { ordermin: '0.0001', lot_decimals: 8, costmin: '0.5' } } }, 'POST /0/private/AddOrder': { error: [], result: { txid: ['T'] } } });
  const k = createBroker('kraken', { env: { KRAKEN_API_KEY: 'k', KRAKEN_API_SECRET: Buffer.from('x').toString('base64') }, data: priced({ 'BTC-USD': 50000 }), fetchImpl: kf });
  await assert.rejects(() => k.placeOrder({ symbol: 'BTC-USD', side: 'buy', notional: 2 }), /needs at least 0\.0001/);
  const cf = mockFetch({ 'GET /api/v3/brokerage/products/BTC-USD': { base_min_size: '0.00001', base_increment: '0.00000001', quote_min_size: '1' } });
  const pem = require('crypto').generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'sec1', format: 'pem' });
  const c = createBroker('coinbase', { env: { COINBASE_API_KEY_NAME: 'k', COINBASE_API_PRIVATE_KEY: pem }, data: priced({ 'BTC-USD': 50000 }), fetchImpl: cf });
  await assert.rejects(() => c.placeOrder({ symbol: 'BTC-USD', side: 'buy', notional: 0.5 }), /under Coinbase|under coinbase/i);
  const seed = Buffer.alloc(32, 7).toString('base64');
  const rf = mockFetch({ 'GET /api/v1/crypto/trading/trading_pairs/': { results: [{ min_order_size: '0.001', asset_increment: '0.0001' }] }, 'GET /api/v1/crypto/marketdata/best_bid_ask/': { results: [{ ask_inclusive_of_buy_spread: '50000' }] } });
  const r = createBroker('robinhood-crypto', { env: { ROBINHOOD_API_KEY: 'k', ROBINHOOD_PRIVATE_KEY: seed }, data: priced({ 'BTC-USD': 50000 }), fetchImpl: rf });
  await assert.rejects(() => r.placeOrder({ symbol: 'BTC-USD', side: 'buy', notional: 5 }), /under robinhood-crypto's minimum of 0\.001/);
});

// ---------------------------------------------------------------- engine: fees, exchange stops, manual close
class FakeLive {
  constructor() {
    this.name = 'okx';
    this.held = {};
    this.protect = null;
    this.cancelled = [];
    this.sizeError = false;
    this.nextOrder = { fee: 0.02 };
  }
  async account() { return { cash: 100, equity: 100, buyingPower: 100 }; }
  async positions() { return Object.entries(this.held).map(([symbol, qty]) => ({ symbol, qty, avgCost: 1, price: 1, marketValue: 5 })); }
  async placeOrder({ symbol, side, notional, qty }) {
    if (this.sizeError) throw new OrderSizeError(`${symbol}: too small (test)`);
    if (side === 'buy') {
      const px = 100.5; // filled a little above the signal price
      this.held[symbol] = notional / px;
      return { id: 'o1', status: 'filled', filledQty: notional / px, filledAvgPrice: px, fee: this.nextOrder.fee };
    }
    delete this.held[symbol];
    return { id: 'o2', status: 'filled', filledQty: qty, filledAvgPrice: this.sellAt || 90, fee: 0.03 };
  }
  async getOrder() { return { status: 'filled' }; }
  async placeProtection(args) { this.protect = args; return { id: 'BTC-USDT:A9' }; }
  async cancelProtection(id) { this.cancelled.push(id); }
  async protectionResult() { return this.result || { state: 'active' }; }
}

function liveEngine(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitrader-v3-'));
  const store = new Store(path.join(dir, 'state.json'));
  Object.assign(store.state.settings, { mode: 'live', stocksEnabled: false, cryptoEnabled: true, cryptoWatchlist: ['ETH-USD'], aiReview: false, useBrackets: true, cryptoLimits: { tradeDollars: 5, minTradeDollars: 1, maxPositions: 3, maxPositionPct: 100, maxTradesPerDay: 6, dailyLossLimitPct: 50 }, ...extra });
  const cryptoData = new FakeData({ 'ETH-USD': pullbackCloses() });
  const engine = new Engine({ store, data: new FakeData({}), cryptoData, env: { MAX_LIVE_TRADE_DOLLARS: '25' }, calendar: null });
  const broker = new FakeLive();
  engine.brokerFor = async () => broker;
  return { store, engine, broker, cryptoData };
}

test('live crypto buy: real fill price, fee and slippage are recorded; target/stop are handed to the exchange', async () => {
  const { store, engine, broker } = liveEngine();
  const r = await engine.tick({ force: true });
  assert.equal(r.entries.length, 1);
  const t = store.state.trades[0];
  assert.equal(t.entryPrice, 100.5);
  assert.equal(t.entryFee, 0.02);
  assert.ok(Math.abs(t.entrySlipPct - ((100.5 - t.signalPrice) / t.signalPrice) * 100) < 1e-9);
  assert.equal(t.protectId, 'BTC-USDT:A9');
  assert.deepEqual([broker.protect.takeProfit, broker.protect.stopLoss], [t.target, t.stop]);
  assert.ok(Math.abs(broker.protect.qty - t.qty) < 1e-12);
});

test('when the exchange fires the target or stop while the app is off, the next run books it with real fee and price', async () => {
  const { store, engine, broker, cryptoData } = liveEngine();
  await engine.tick({ force: true });
  const t = store.state.trades[0];
  broker.result = { state: 'target', price: t.target, fee: 0.05 };
  cryptoData.setPrice('ETH-USD', t.entryPrice); // the app's own price check would not have sold
  await engine.exitCheck({ force: true });
  assert.equal(t.status, 'closed');
  assert.equal(t.exitReason, 'target (exchange)');
  assert.equal(t.exitPrice, t.target);
  assert.ok(Math.abs(t.fees - 0.07) < 1e-9);
  assert.ok(Math.abs(t.pnl - ((t.target - t.entryPrice) * t.qty - 0.07)) < 1e-9, 'P&L is net of both fees');
});

test('when the app sells by itself (time stop / flatten), it takes the exchange order down first', async () => {
  const { store, engine, broker } = liveEngine();
  await engine.tick({ force: true });
  const out = await engine.flatten();
  assert.equal(out.sold.length, 1);
  assert.deepEqual(broker.cancelled, ['BTC-USDT:A9']);
  const t = store.state.trades[0];
  assert.equal(t.exitReason, 'manual flatten');
  assert.ok(t.fees > 0.04, 'entry and exit fees both counted');
});

test('a coin sold somewhere else is detected: the trade is closed as an estimate, nothing is sold twice', async () => {
  const { store, engine, broker } = liveEngine({ useBrackets: false });
  await engine.tick({ force: true });
  const t = store.state.trades[0];
  assert.ok(!t.protectId);
  delete broker.held['ETH-USD']; // you sold it in the exchange's own app
  let sells = 0;
  const orig = broker.placeOrder.bind(broker);
  broker.placeOrder = async (o) => { if (o.side === 'sell') sells++; return orig(o); };
  await engine.exitCheck({ force: true });
  assert.equal(t.status, 'closed');
  assert.equal(t.exitReason, 'closed outside the app');
  assert.equal(t.estimated, true);
  assert.equal(sells, 0);
});

test('an order the exchange would refuse for size is logged as a skip, not an error', async () => {
  const { store, engine, broker } = liveEngine();
  broker.sizeError = true;
  const r = await engine.tick({ force: true });
  assert.equal(r.errors.length, 0);
  assert.equal(r.entries.length, 0);
  const sig = store.state.signals.find((x) => x.symbol === 'ETH-USD');
  assert.equal(sig.status, 'blocked');
  assert.match(sig.reason, /too small/);
});

// ---------------------------------------------------------------- csv and connection test
test('trades CSV: one row per trade, quotes handled, estimates flagged', () => {
  const csv = tradesToCsv([
    { symbol: 'ETH-USD', assetClass: 'crypto', mode: 'live', broker: 'okx', strategy: 'pullback', status: 'closed', qty: 0.5, signalPrice: 100, entryPrice: 100.5, entrySlipPct: 0.5, exitPrice: 106, fees: 0.07, pnl: 2.68, pnlPct: 5.3, exitReason: 'target, (exchange)', entryAt: '2026-10-01T00:00:00Z', exitAt: '2026-10-03T00:00:00Z' },
    { symbol: 'AAA', mode: 'paper', status: 'closed', qty: 1, entryPrice: 10, exitPrice: 9, pnl: -1, pnlPct: -10, exitReason: 'closed outside the app', estimated: true },
  ]);
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^opened,closed,symbol,class,mode,broker/);
  assert.match(lines[1], /"target, \(exchange\)"/);
  assert.match(lines[2], /,yes$/);
});

test('Test connection: shows keys, balance, price and order limits; the demo order only runs on OKX demo', async () => {
  const f = mockFetch({
    ...instruments,
    'GET /api/v5/account/balance': { code: '0', data: [{ details: [{ ccy: 'USDT', availBal: '1000', eq: '1000' }] }] },
    'POST /api/v5/trade/order': { code: '0', data: [{ ordId: '5' }] },
    'GET /api/v5/trade/order': { code: '0', data: [{ state: 'filled', accFillSz: '0.02', avgPx: '50000', fee: '-0.01', feeCcy: 'USDT' }] },
  });
  const b = createBroker('okx', { env: OKX_ENV, data: priced({ 'BTC-USD': 50000 }), fetchImpl: f });
  b.pollMs = 1;
  b.positions = async () => [{ symbol: 'BTC-USD', qty: 0.02, marketValue: 1000 }];
  const feed = { getQuote: async () => 50000 };
  const ok = await testBroker(async () => b, { feed, sampleSymbol: 'BTC-USD', tradeDollars: 5 });
  assert.deepEqual(ok.checks.map((c) => [c.name, c.ok]), [['Keys', true], ['Account', true], ['Holdings', true], ['Price feed', true], ['Order limits', true], ['Your trade size', false]]);
  assert.match(ok.checks.find((c) => c.name === 'Your trade size').detail, /needs at least 0\.01/);
  assert.equal(ok.ok, false);
  const rt = await testBroker(async () => b, { feed, sampleSymbol: 'BTC-USD', tradeDollars: 5000, orderTest: true });
  assert.ok(rt.checks.find((c) => c.name === 'Demo order').ok);
  const realMoney = createBroker('okx', { env: { ...OKX_ENV, OKX_DEMO: 'false' }, data: priced({ 'BTC-USD': 50000 }), fetchImpl: f });
  const refused = await testBroker(async () => realMoney, { feed, sampleSymbol: 'BTC-USD', tradeDollars: 5000, orderTest: true });
  assert.match(refused.checks.find((c) => c.name === 'Demo order').detail, /never with real money/);
  const noKeys = await testBroker(async () => { throw new Error('OKX_API_KEY, OKX_API_SECRET and OKX_PASSPHRASE are not set'); }, { feed, sampleSymbol: 'BTC-USD' });
  assert.equal(noKeys.ok, false);
  assert.equal(noKeys.checks.length, 1);
});

// ---------------------------------------------------------------- API
const { createApp } = require('../server/index');
test('API: trades CSV download and the Test connection endpoint', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitrader-api3-'));
  const app = createApp({ env: { APP_PASSWORD: 'correct horse battery', DATA_DIR: dir, DATA_PROVIDER: 'demo' } });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const login = await (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery' }) })).json();
    const H = { 'content-type': 'application/json', authorization: `Bearer ${login.token}` };
    app.store.state.trades.push({ symbol: 'AAA', mode: 'paper', status: 'closed', qty: 1, entryPrice: 10, exitPrice: 11, pnl: 1, pnlPct: 10, exitReason: 'target' });
    const csv = await fetch(base + '/api/trades.csv', { headers: H });
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.match(await csv.text(), /symbol,class[\s\S]*AAA,stocks,paper/);
    assert.equal((await fetch(base + '/api/trades.csv')).status, 401, 'needs sign-in');
    const t = await (await fetch(base + '/api/broker/test', { method: 'POST', headers: H, body: JSON.stringify({ assetClass: 'crypto' }) })).json();
    assert.equal(t.ok, false);
    assert.equal(t.checks[0].name, 'Keys');
    assert.match(t.checks[0].detail, /OKX|ROBINHOOD|not set/i);
    const st = await (await fetch(base + '/api/status', { headers: H })).json();
    assert.ok('holiday' in st.classes.stocks);
  } finally {
    app.server.close();
  }
});
