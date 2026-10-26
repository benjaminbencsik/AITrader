'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../server/store');
const { Engine } = require('../server/engine');
const { createApp } = require('../server/index');
const { CryptoData } = require('../server/cryptodata');
const { createBroker, brokerCatalog } = require('../server/brokers');
const { robinhoodSignature, krakenSignature, coinbaseJwt, okxSignature, krakenAsset } = require('../server/brokers/crypto');
const { pullbackCloses, FakeData } = require('./helpers');

// Mock fetch: routes are [ 'METHOD path-prefix', handler(body, url, headers) -> object | {__status, body} ].
function mockFetch(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    const u = new URL(url);
    const key = `${opts.method || 'GET'} ${u.pathname}`;
    const body = opts.body ? (String(opts.headers && opts.headers['content-type']).includes('json') ? JSON.parse(opts.body) : Object.fromEntries(new URLSearchParams(opts.body))) : undefined;
    calls.push({ key, url: String(url), body, headers: opts.headers || {} });
    const hit = Object.entries(routes).find(([k]) => key === k || key.startsWith(k));
    if (!hit) return { ok: false, status: 404, text: async () => `no mock for ${key}` };
    const out = typeof hit[1] === 'function' ? hit[1](body, u, opts.headers) : hit[1];
    const status = out && out.__status ? out.__status : 200;
    const payload = out && out.__status ? out.body : out;
    return { ok: status < 400, status, text: async () => JSON.stringify(payload), json: async () => payload };
  };
  fn.calls = calls;
  return fn;
}
const priced = (map) => ({ name: 'fake', getQuote: async (s) => map[s] });

// ---------------------------------------------------------------- data
test('CryptoData: parses Coinbase candles (newest first), sorts them and drops today\'s forming candle', async () => {
  const day = 86400;
  const t0 = Math.floor(Date.now() / 1000 / day) * day; // today 00:00 UTC (still forming)
  const rows = [[t0, 1, 2, 1.5, 1.8, 10], [t0 - day, 1, 2, 1.4, 1.6, 10], [t0 - 2 * day, 1, 2, 1.3, 1.5, 10]];
  const f = mockFetch({ 'GET /products/BTC-USD/candles': () => rows });
  const d = new CryptoData({}, f);
  const bars = await d.getBars('BTC-USD', 10);
  assert.equal(bars.length, 2);
  assert.ok(bars[0].t < bars[1].t);
  assert.deepEqual([bars[1].o, bars[1].h, bars[1].l, bars[1].c], [1.4, 2, 1, 1.6]);
  const q = new CryptoData({}, mockFetch({ 'GET /products/BTC-USD/ticker': () => ({ price: '67123.5' }) }));
  assert.equal(await q.getQuote('BTC-USD'), 67123.5);
});

// ---------------------------------------------------------------- signing
test('Kraken signature matches the published example', () => {
  const sig = krakenSignature({
    path: '/0/private/AddOrder', nonce: 1616492376594,
    postData: 'nonce=1616492376594&ordertype=limit&pair=XBTUSD&price=37500&type=buy&volume=1.25',
    secretB64: 'kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg==',
  });
  assert.equal(sig, '4/dpxb3iT4tp/ZCVEwSnEsLxx0bqyhLpdfOpc6fn7OR8+UClSV5n9E6aSS8MPtnRfp32bAb0nmbRn6H8ndwLUQ==');
  assert.equal(krakenAsset('XXBT'), 'BTC');
  assert.equal(krakenAsset('ZUSD'), 'USD');
  assert.equal(krakenAsset('SOL'), 'SOL');
  assert.equal(krakenAsset('ETH.S'), null);
});

test('Robinhood Crypto signature verifies with the matching public key', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const sig = robinhoodSignature({ apiKey: 'rh-key', timestamp: '1700000000', path: '/api/v1/crypto/trading/orders/', method: 'POST', body: '{"a":1}', privateKeyB64: seed.toString('base64') });
  const msg = Buffer.from('rh-key1700000000/api/v1/crypto/trading/orders/POST{"a":1}');
  assert.equal(crypto.verify(null, msg, publicKey, Buffer.from(sig, 'base64')), true);
  assert.throws(() => robinhoodSignature({ apiKey: 'k', timestamp: '1', path: '/', method: 'GET', privateKeyB64: Buffer.alloc(5).toString('base64') }), /32 bytes/);
});

test('Coinbase JWT is a valid ES256 token over the request URI', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
  const jwt = coinbaseJwt({ keyName: 'organizations/o/apiKeys/k', privateKeyPem: pem, method: 'POST', host: 'api.coinbase.com', path: '/api/v3/brokerage/orders', now: 1700000000, nonce: 'abc' });
  const [h, p, s] = jwt.split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url'));
  const claims = JSON.parse(Buffer.from(p, 'base64url'));
  assert.equal(header.alg, 'ES256');
  assert.equal(header.kid, 'organizations/o/apiKeys/k');
  assert.equal(claims.uri, 'POST api.coinbase.com/api/v3/brokerage/orders');
  assert.equal(claims.iss, 'cdp');
  assert.equal(claims.exp - claims.nbf, 120);
  assert.equal(crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')), true);
});

test('OKX signature is base64 HMAC-SHA256 of timestamp+method+path+body', () => {
  const sig = okxSignature({ timestamp: '2026-10-26T10:00:00.000Z', method: 'POST', path: '/api/v5/trade/order', body: '{"x":1}', secret: 's3cret' });
  const want = crypto.createHmac('sha256', 's3cret').update('2026-10-26T10:00:00.000ZPOST/api/v5/trade/order{"x":1}').digest('base64');
  assert.equal(sig, want);
});

// ---------------------------------------------------------------- crypto brokers (mocked network)
test('Robinhood Crypto: converts dollars to a coin quantity at the ask, signs every call, sells only what it holds', async () => {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('base64');
  let held = 0;
  const f = mockFetch({
    'GET /api/v1/crypto/trading/accounts/': { account_number: '1', buying_power: '50.00', status: 'active' },
    'GET /api/v1/crypto/trading/trading_pairs/': { results: [{ symbol: 'BTC-USD', asset_increment: '0.00000001' }] },
    'GET /api/v1/crypto/marketdata/best_bid_ask/': { results: [{ symbol: 'BTC-USD', ask_price: '50000' }] },
    'GET /api/v1/crypto/trading/holdings/': () => ({ results: held ? [{ asset_code: 'BTC', total_quantity: String(held) }] : [] }),
    'POST /api/v1/crypto/trading/orders/': (b) => { held = Number(b.market_order_config.asset_quantity); return { id: 'ord1', state: 'open' }; },
    'GET /api/v1/crypto/trading/orders/ord1/': { id: 'ord1', state: 'filled', filled_asset_quantity: '0.0001', average_price: '50010' },
  });
  const b = createBroker('robinhood-crypto', { env: { ROBINHOOD_API_KEY: 'k', ROBINHOOD_PRIVATE_KEY: seed }, data: priced({ 'BTC-USD': 50000 }), fetchImpl: f });
  b.pollMs = 1;
  const buy = await b.placeOrder({ symbol: 'BTC-USD', side: 'buy', notional: 5 });
  assert.equal(buy.status, 'filled');
  const post = f.calls.find((c) => c.key === 'POST /api/v1/crypto/trading/orders/');
  assert.equal(post.body.market_order_config.asset_quantity, '0.0001');
  assert.equal(post.body.type, 'market');
  assert.ok(post.headers['x-signature'] && post.headers['x-timestamp'] && post.headers['x-api-key'] === 'k');
  assert.equal((await b.account()).cash, 50);
  // sell asks for MORE than held (fees): it sells only what is there
  await b.placeOrder({ symbol: 'BTC-USD', side: 'sell', qty: 0.5 });
  const sells = f.calls.filter((c) => c.key === 'POST /api/v1/crypto/trading/orders/' && c.body.side === 'sell');
  assert.equal(sells[0].body.market_order_config.asset_quantity, '0.0001');
});

test('Kraken: buys by dollar amount (viqc), maps BTC to XBT, signs with nonce', async () => {
  const secret = Buffer.from('a-fake-kraken-secret-for-tests-only').toString('base64');
  const f = mockFetch({
    'POST /0/private/AddOrder': { error: [], result: { txid: ['OABC-123'], descr: { order: 'buy' } } },
    'POST /0/private/QueryOrders': { error: [], result: { 'OABC-123': { status: 'closed', vol_exec: '0.0001', price: '50020.0' } } },
    'POST /0/private/Balance': { error: [], result: { ZUSD: '40.5', XXBT: '0.0001', 'ETH.S': '3' } },
  });
  const b = createBroker('kraken', { env: { KRAKEN_API_KEY: 'k', KRAKEN_API_SECRET: secret }, data: priced({ 'BTC-USD': 50000 }), fetchImpl: f });
  b.pollMs = 1;
  const r = await b.placeOrder({ symbol: 'BTC-USD', side: 'buy', notional: 5 });
  assert.equal(r.filledAvgPrice, 50020);
  const add = f.calls.find((c) => c.key === 'POST /0/private/AddOrder');
  assert.equal(add.body.pair, 'XBTUSD');
  assert.equal(add.body.oflags, 'viqc');
  assert.equal(add.body.volume, '5.00');
  assert.ok(add.headers['API-Sign'] && add.headers['API-Key'] === 'k' && add.body.nonce);
  const acct = await b.account();
  assert.equal(acct.cash, 40.5);
  assert.equal(acct.equity, 45.5); // 40.5 cash + 0.0001 BTC at 50000; staked ETH ignored
  // an API error is surfaced, not swallowed
  const bad = createBroker('kraken', { env: { KRAKEN_API_KEY: 'k', KRAKEN_API_SECRET: secret }, data: priced({}), fetchImpl: mockFetch({ 'POST /0/private/AddOrder': { error: ['EOrder:Insufficient funds'], result: {} } }) });
  await assert.rejects(() => bad.placeOrder({ symbol: 'BTC-USD', side: 'buy', notional: 5 }), /Insufficient funds/);
});

test('Coinbase: market buy by quote_size with a signed bearer token', async () => {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).replace(/\n/g, '\\n');
  const f = mockFetch({
    'POST /api/v3/brokerage/orders': { success: true, success_response: { order_id: 'cb1' } },
    'GET /api/v3/brokerage/orders/historical/cb1': { order: { status: 'FILLED', filled_size: '0.0001', average_filled_price: '50030' } },
    'GET /api/v3/brokerage/accounts': { accounts: [{ currency: 'USD', available_balance: { value: '25' }, hold: { value: '0' } }, { currency: 'BTC', available_balance: { value: '0.0002' }, hold: { value: '0' } }] },
  });
  const b = createBroker('coinbase', { env: { COINBASE_API_KEY_NAME: 'organizations/o/apiKeys/k', COINBASE_API_PRIVATE_KEY: pem }, data: priced({ 'BTC-USD': 50000 }), fetchImpl: f });
  b.pollMs = 1;
  const r = await b.placeOrder({ symbol: 'BTC-USD', side: 'buy', notional: 5 });
  assert.equal(r.filledQty, 0.0001);
  const post = f.calls.find((c) => c.key === 'POST /api/v3/brokerage/orders');
  assert.equal(post.body.side, 'BUY');
  assert.equal(post.body.order_configuration.market_market_ioc.quote_size, '5.00');
  assert.match(post.headers.authorization, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  assert.equal((await b.account()).equity, 35); // 25 USD + 0.0002 BTC
  const fail = createBroker('coinbase', { env: { COINBASE_API_KEY_NAME: 'k', COINBASE_API_PRIVATE_KEY: pem }, data: priced({}), fetchImpl: mockFetch({ 'POST /api/v3/brokerage/orders': { success: false, error_response: { message: 'INSUFFICIENT_FUND' } } }) });
  await assert.rejects(() => fail.placeOrder({ symbol: 'BTC-USD', side: 'buy', notional: 5 }), /INSUFFICIENT_FUND/);
});

test('OKX: market buy by quote amount, demo header on by default, error codes surfaced', async () => {
  const f = mockFetch({
    'POST /api/v5/trade/order': { code: '0', data: [{ ordId: '99', sCode: '0' }] },
    'GET /api/v5/trade/order': { code: '0', data: [{ state: 'filled', accFillSz: '0.0001', avgPx: '50040' }] },
    'GET /api/v5/account/balance': { code: '0', data: [{ details: [{ ccy: 'USDT', availBal: '30', eq: '30' }, { ccy: 'BTC', availBal: '0.0001', eq: '0.0001' }] }] },
  });
  const env = { OKX_API_KEY: 'k', OKX_API_SECRET: 's', OKX_PASSPHRASE: 'p' };
  const b = createBroker('okx', { env, data: priced({ 'BTC-USD': 50000 }), fetchImpl: f });
  b.pollMs = 1;
  const r = await b.placeOrder({ symbol: 'BTC-USD', side: 'buy', notional: 5 });
  assert.equal(r.filledAvgPrice, 50040);
  const post = f.calls.find((c) => c.key === 'POST /api/v5/trade/order');
  assert.deepEqual([post.body.instId, post.body.tdMode, post.body.ordType, post.body.sz, post.body.tgtCcy], ['BTC-USDT', 'cash', 'market', '5.00', 'quote_ccy']);
  assert.equal(post.headers['x-simulated-trading'], '1');
  assert.equal((await b.account()).cash, 30);
  const live = createBroker('okx', { env: { ...env, OKX_DEMO: 'false' }, data: priced({}), fetchImpl: mockFetch({ 'GET /api/v5/account/balance': { code: '0', data: [{ details: [] }] } }) });
  await live.account();
  const err = createBroker('okx', { env, data: priced({}), fetchImpl: mockFetch({ 'POST /api/v5/trade/order': { code: '1', msg: 'All operations failed', data: [{ sMsg: 'Insufficient balance' }] } }) });
  await assert.rejects(() => err.placeOrder({ symbol: 'BTC-USD', side: 'buy', notional: 5 }), /Insufficient balance/);
});

// ---------------------------------------------------------------- stock brokers (mocked network)
test('Tradier: whole-share market order, form body, sandbox by default', async () => {
  const f = mockFetch({
    'POST /v1/accounts/ACC1/orders': { order: { id: 123, status: 'ok' } },
    'GET /v1/accounts/ACC1/orders/123': { order: { status: 'filled', exec_quantity: 2, avg_fill_price: 25.1 } },
    'GET /v1/accounts/ACC1/balances': { balances: { total_equity: 100, total_cash: 60, buying_power: 60 } },
    'GET /v1/accounts/ACC1/positions': { positions: { position: { symbol: 'KO', quantity: 2, cost_basis: 100 } } },
  });
  const b = createBroker('tradier', { env: { TRADIER_ACCESS_TOKEN: 't', TRADIER_ACCOUNT_ID: 'ACC1' }, data: priced({ KO: 60, AAA: 25 }), fetchImpl: f });
  b.pollMs = 1;
  const r = await b.placeOrder({ symbol: 'AAA', side: 'buy', notional: 55 });
  assert.equal(r.filledAvgPrice, 25.1);
  const post = f.calls.find((c) => c.key === 'POST /v1/accounts/ACC1/orders');
  assert.match(post.url, /^https:\/\/sandbox\.tradier\.com/);
  assert.deepEqual([post.body.class, post.body.side, post.body.quantity, post.body.type, post.body.duration], ['equity', 'buy', '2', 'market', 'day']);
  assert.equal(post.headers.authorization, 'Bearer t');
  assert.equal((await b.account()).equity, 100);
  assert.equal((await b.positions())[0].avgCost, 50); // a single position comes back as an object, not a list
  await assert.rejects(() => b.placeOrder({ symbol: 'AAA', side: 'buy', notional: 5 }), /whole shares/);
});

test('Tastytrade: OAuth refresh, market order legs, fill average from the fills', async () => {
  const f = mockFetch({
    'POST /oauth/token': { access_token: 'AT', expires_in: 900 },
    'POST /accounts/5W/orders': { data: { order: { id: 777, status: 'Received' } } },
    'GET /accounts/5W/orders/777': { data: { status: 'Filled', legs: [{ fills: [{ quantity: 1, 'fill-price': '20.0' }, { quantity: 1, 'fill-price': '22.0' }] }] } },
  });
  const b = createBroker('tastytrade', { env: { TASTYTRADE_CLIENT_SECRET: 's', TASTYTRADE_REFRESH_TOKEN: 'r', TASTYTRADE_ACCOUNT: '5W' }, data: priced({ AAA: 20 }), fetchImpl: f });
  b.pollMs = 1;
  const r = await b.placeOrder({ symbol: 'AAA', side: 'buy', notional: 45 });
  assert.equal(r.filledQty, 2);
  assert.equal(r.filledAvgPrice, 21);
  const post = f.calls.find((c) => c.key === 'POST /accounts/5W/orders');
  assert.match(post.url, /api\.cert\.tastyworks\.com/);
  assert.deepEqual([post.body['order-type'], post.body.legs[0].action, post.body.legs[0].quantity, post.body.legs[0].symbol], ['Market', 'Buy to Open', 2, 'AAA']);
  assert.equal(post.headers.authorization, 'Bearer AT');
  assert.equal(f.calls.filter((c) => c.key === 'POST /oauth/token').length, 1); // token reused
});

test('Public: exchanges the secret for a token, buys by dollar amount', async () => {
  const f = mockFetch({
    'POST /userapiauthservice/personal/access-tokens': { accessToken: 'PT' },
    'POST /userapigateway/trading/PA1/order': (b) => ({ orderId: b.orderId }),
    'GET /userapigateway/trading/PA1/order/': { status: 'FILLED', filledQuantity: '0.2', averageFillPrice: '25' },
  });
  const b = createBroker('public', { env: { PUBLIC_API_SECRET: 's', PUBLIC_ACCOUNT_ID: 'PA1' }, data: priced({ AAA: 25 }), fetchImpl: f });
  b.pollMs = 1;
  const r = await b.placeOrder({ symbol: 'AAA', side: 'buy', notional: 5 });
  assert.equal(r.filledAvgPrice, 25);
  const post = f.calls.find((c) => c.key === 'POST /userapigateway/trading/PA1/order');
  assert.deepEqual([post.body.orderSide, post.body.orderType, post.body.amount, post.body.instrument.symbol], ['BUY', 'MARKET', '5.00', 'AAA']);
  assert.equal(post.headers.authorization, 'Bearer PT');
});

test('IBKR: looks up the contract, confirms the warning prompt, reads the fill', async () => {
  const f = mockFetch({
    'GET /v1/api/portfolio/accounts': [{ accountId: 'U1' }],
    'GET /v1/api/iserver/secdef/search': [{ conid: 265598, symbol: 'AAA' }],
    'POST /v1/api/iserver/account/U1/orders': [{ id: 'reply-1', message: ['Are you sure?'] }],
    'POST /v1/api/iserver/reply/reply-1': [{ order_id: '555', order_status: 'Submitted' }],
    'GET /v1/api/iserver/account/orders': { orders: [{ orderId: 555, status: 'Filled', filledQuantity: 2, avgPrice: 25 }] },
  });
  const b = createBroker('ibkr', { env: { IBKR_GATEWAY_URL: 'https://gw.local:5000/v1/api' }, data: priced({ AAA: 25 }), fetchImpl: f });
  b.pollMs = 1;
  const r = await b.placeOrder({ symbol: 'AAA', side: 'buy', notional: 55 });
  assert.equal(r.status, 'filled');
  const post = f.calls.find((c) => c.key === 'POST /v1/api/iserver/account/U1/orders');
  assert.deepEqual([post.body.orders[0].conid, post.body.orders[0].side, post.body.orders[0].quantity], [265598, 'BUY', 2]);
});

test('every broker refuses to start without its keys, and the catalog is split by asset class', () => {
  for (const name of ['tradier', 'tastytrade', 'public', 'robinhood-crypto', 'coinbase', 'kraken', 'okx']) {
    assert.throws(() => createBroker(name, { env: {}, data: priced({}) }), /not set/, name);
  }
  const cat = brokerCatalog({});
  assert.ok(cat.filter((c) => c.assetClass === 'crypto').map((c) => c.id).sort().join() === 'coinbase,kraken,okx,robinhood-crypto');
  assert.ok(cat.some((c) => c.id === 'tradier' && c.assetClass === 'stocks'));
});

// ---------------------------------------------------------------- engine: stocks and crypto side by side
function lanes({ stocks = true, crypto = true, now, settings = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitrader-lanes-'));
  const store = new Store(path.join(dir, 'state.json'));
  Object.assign(store.state.settings, { stocksEnabled: stocks, cryptoEnabled: crypto, watchlist: ['AAA'], cryptoWatchlist: ['ETH-USD', 'SOL-USD'], aiReview: false, ...settings });
  store.state.paper.cash = 100;
  store.state.paperCrypto.cash = 100;
  const stockData = new FakeData({ AAA: pullbackCloses() });
  const cryptoData = new FakeData({ 'ETH-USD': pullbackCloses(), 'SOL-USD': pullbackCloses() });
  const engine = new Engine({ store, data: stockData, cryptoData, env: {}, now });
  return { store, engine, stockData, cryptoData };
}

test('both on: each side trades from its own paper account and budget', async () => {
  const { store, engine } = lanes({ settings: { tradeDollars: 7, cryptoLimits: { tradeDollars: 3, minTradeDollars: 1, maxPositions: 3, maxPositionPct: 40, maxTradesPerDay: 6, dailyLossLimitPct: 10 } } });
  const r = await engine.tick({ force: true });
  assert.equal(r.entries.length, 3); // AAA plus ETH and SOL
  const by = (cls) => store.state.trades.filter((t) => (t.assetClass || 'stocks') === cls);
  assert.equal(by('stocks').length, 1);
  assert.equal(by('crypto').length, 2);
  assert.ok(Math.abs(store.state.paper.cash - 93) < 1e-9, 'stocks spent $7 of its own $100');
  assert.ok(Math.abs(store.state.paperCrypto.cash - 94) < 1e-9, 'crypto spent 2 x $3 of its own $100');
  assert.deepEqual(Object.keys(store.state.paper.positions), ['AAA']);
  assert.deepEqual(Object.keys(store.state.paperCrypto.positions).sort(), ['ETH-USD', 'SOL-USD']);
});

test('both on: position and trade-count limits are counted separately', async () => {
  const { store, engine } = lanes({ settings: { maxPositions: 1, cryptoLimits: { tradeDollars: 5, minTradeDollars: 1, maxPositions: 2, maxPositionPct: 40, maxTradesPerDay: 6, dailyLossLimitPct: 10 } } });
  await engine.tick({ force: true });
  assert.equal(store.state.trades.filter((t) => t.assetClass === 'crypto').length, 2);
  assert.equal(store.state.trades.filter((t) => (t.assetClass || 'stocks') === 'stocks').length, 1);
  // a third crypto coin would be blocked by the crypto cap of 2, regardless of the stock side
  const { store: s2, engine: e2 } = lanes({ settings: { cryptoLimits: { tradeDollars: 5, minTradeDollars: 1, maxPositions: 1, maxPositionPct: 40, maxTradesPerDay: 6, dailyLossLimitPct: 10 } } });
  await e2.tick({ force: true });
  assert.equal(s2.state.trades.filter((t) => t.assetClass === 'crypto').length, 1);
});

test('a crypto loss does not trip the stock side\'s daily loss limit, and vice versa', async () => {
  const { store, engine, stockData, cryptoData } = lanes({ settings: { dailyLossLimitPct: 0.5, cryptoLimits: { tradeDollars: 5, minTradeDollars: 1, maxPositions: 3, maxPositionPct: 40, maxTradesPerDay: 6, dailyLossLimitPct: 50 } } });
  await engine.tick({ force: true });
  const eth = store.state.trades.find((t) => t.symbol === 'ETH-USD');
  cryptoData.setPrice('ETH-USD', eth.stop - 1); // crypto stops out at a loss
  await engine.exitCheck({ force: true });
  assert.equal(store.state.trades.find((t) => t.symbol === 'ETH-USD').status, 'closed');
  assert.ok(store.state.trades.find((t) => t.symbol === 'ETH-USD').pnl < 0);
  // stocks side: the crypto loss isn't in its books, so a fresh stock signal is still allowed
  const aaa = store.state.trades.find((t) => t.symbol === 'AAA');
  stockData.setPrice('AAA', aaa.target + 1);
  await engine.exitCheck({ force: true });
  store.state.settings.watchlist = ['AAA'];
  const r = await engine.tick({ force: true });
  assert.ok(!r.signals.some((x) => x.symbol === 'AAA' && /daily loss/.test(x.reason)));
});

test('market closed: stocks wait, crypto keeps trading, in the same scan', async () => {
  const sunday = new Date('2026-10-25T07:00:00Z');
  const { store, engine } = lanes({ now: () => sunday });
  const r = await engine.tick();
  assert.equal(r.skipped, undefined);
  assert.equal(store.state.trades.filter((t) => t.assetClass === 'crypto').length, 2);
  assert.equal(store.state.trades.filter((t) => (t.assetClass || 'stocks') === 'stocks').length, 0);
  const only = lanes({ crypto: false, now: () => sunday });
  assert.equal((await only.engine.tick()).skipped, 'market closed');
  const none = lanes({ stocks: false, crypto: false });
  assert.equal((await none.engine.tick()).skipped, 'nothing enabled');
});

test('crypto side: own exits (+6/-5), earnings not applicable, calendar-day time stop, cheap coins allowed', async () => {
  let clock = new Date('2026-10-23T15:00:00Z'); // Friday
  const { store, engine, cryptoData } = lanes({ stocks: false, now: () => clock, settings: { minPrice: 5 } });
  cryptoData.map['ETH-USD'] = pullbackCloses().map((x) => x / 1000); // price far under $5
  await engine.tick({ force: true });
  const t = store.state.trades.find((x) => x.symbol === 'ETH-USD');
  assert.equal(t.assetClass, 'crypto');
  assert.ok(Math.abs(t.target / t.entryPrice - 1.06) < 0.002);
  assert.ok(Math.abs(t.stop / t.entryPrice - 0.95) < 0.002);
  assert.equal(store.state.signals.find((x) => x.symbol === 'ETH-USD').earnings, 'not applicable (crypto)');
  clock = new Date('2026-10-28T15:00:00Z'); // 5 calendar days, only 3 business days
  const r = await engine.exitCheck({ force: true });
  assert.ok(r.exits.some((x) => x.symbol === 'ETH-USD' && x.reason === 'time stop'));
});

test('Sell everything closes both sides', async () => {
  const { store, engine } = lanes();
  await engine.tick({ force: true });
  const out = await engine.flatten();
  assert.equal(out.sold.length, 3);
  assert.equal(store.state.trades.filter((t) => t.status === 'open').length, 0);
  assert.equal(store.state.settings.paused, true);
});

test('old saves with the single asset-class switch are migrated', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitrader-mig-'));
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, JSON.stringify({ settings: { assetClass: 'crypto' }, paper: { cash: 55, positions: {} } }));
  const st = new Store(file);
  assert.equal(st.state.settings.cryptoEnabled, true);
  assert.equal(st.state.settings.stocksEnabled, false);
  assert.equal(st.state.settings.assetClass, undefined);
  assert.equal(st.state.paper.cash, 55);
  assert.equal(st.state.paperCrypto.cash, 100);
});

// ---------------------------------------------------------------- API
async function boot(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitrader-api-'));
  const app = createApp({ env: { APP_PASSWORD: 'correct horse battery', DATA_DIR: dir, DATA_PROVIDER: 'demo', ...env } });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (p, { method = 'GET', body, token } = {}) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const login = await call('/api/login', { method: 'POST', body: { password: 'correct horse battery' } });
  return { app, call, token: login.body.token, close: () => app.server.close() };
}

test('API: both sides in status, separate crypto limits validated, live needs keys for each enabled side', async () => {
  const { call, token, close } = await boot();
  try {
    const bad = await call('/api/settings', { method: 'POST', token, body: { cryptoWatchlist: ['btc'], cryptoBroker: 'nope', cryptoEnabled: 'yes', cryptoLimits: { tradeDollars: -1, bogus: 1 } } });
    assert.deepEqual(bad.body.rejected.sort(), ['cryptoBroker', 'cryptoEnabled', 'cryptoLimits.bogus', 'cryptoLimits.tradeDollars', 'cryptoWatchlist']);

    const on = await call('/api/settings', { method: 'POST', token, body: { cryptoEnabled: true, cryptoWatchlist: ['BTC-USD', 'DOGE-USD'], cryptoLimits: { tradeDollars: 3 }, cryptoParams: { pullback: { targetPct: 7 } } } });
    assert.equal(on.status, 200);
    assert.equal(on.body.settings.cryptoLimits.tradeDollars, 3);
    assert.equal(on.body.settings.tradeDollars, 5, 'stock budget untouched');
    const st = await call('/api/status', { token });
    assert.equal(st.body.classes.stocks.enabled, true);
    assert.equal(st.body.classes.crypto.enabled, true);
    assert.equal(st.body.classes.crypto.account.equity, 100);
    assert.equal(st.body.classes.stocks.account.equity, 100);
    assert.equal(st.body.account.equity, 100, 'top-level mirrors the first enabled side');
    assert.equal(st.body.strategies.find((x) => x.id === 'pullback').cryptoParams.targetPct, 7);

    const noConfirm = await call('/api/settings', { method: 'POST', token, body: { mode: 'live', broker: 'alpaca', cryptoBroker: 'okx' } });
    assert.match(noConfirm.body.error, /ENABLE LIVE TRADING/);
    const noStockKeys = await call('/api/settings', { method: 'POST', token, body: { mode: 'live', broker: 'alpaca', cryptoBroker: 'okx', confirm: 'ENABLE LIVE TRADING' } });
    assert.match(noStockKeys.body.error, /stocks: .*ALPACA_KEY_ID/);
    await call('/api/settings', { method: 'POST', token, body: { stocksEnabled: false } });
    const noCryptoKeys = await call('/api/settings', { method: 'POST', token, body: { mode: 'live', cryptoBroker: 'okx', confirm: 'ENABLE LIVE TRADING' } });
    assert.match(noCryptoKeys.body.error, /crypto: .*OKX_API_KEY/);
    assert.equal((await call('/api/settings', { method: 'POST', token, body: { stocksEnabled: false, cryptoEnabled: false } })).status, 400);
  } finally {
    close();
  }
});

test('API: cannot turn a side off while it has open trades; crypto backtest and performance run', async () => {
  const { app, call, token, close } = await boot();
  try {
    await call('/api/settings', { method: 'POST', token, body: { cryptoEnabled: true } });
    app.store.state.trades.push({ id: 'x', symbol: 'AAA', status: 'open', mode: 'paper', broker: 'paper', assetClass: 'stocks', qty: 1, entryPrice: 1 });
    const r = await call('/api/settings', { method: 'POST', token, body: { stocksEnabled: false } });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /Close your open stocks trades/);
    app.store.state.trades.length = 0;
    assert.equal((await call('/api/settings', { method: 'POST', token, body: { stocksEnabled: false } })).status, 200);
    const bt = await call('/api/backtest', { method: 'POST', token, body: { assetClass: 'crypto', strategy: 'pullback', years: 2, symbols: ['BTC-USD', 'ETH-USD'] } });
    assert.equal(bt.status, 200);
    assert.equal(bt.body.assetClass, 'crypto');
    const perf = await call('/api/performance?class=crypto', { token });
    assert.equal(perf.body.assetClass, 'crypto');
    assert.equal(perf.body.benchmark, 'BTC-USD');
  } finally {
    close();
  }
});

// ---------------------------------------------------------------- autopilot and warnings
test('autopilot: pauses new buys after repeated failed scans, with a phone alert; a good scan resets the count', async () => {
  const alerts = [];
  const { store, engine } = lanes({ crypto: false, settings: { autopilot: true, autoRun: true, autopilotFailLimit: 3, mode: 'live', broker: 'alpaca' } });
  engine.notify = Object.assign(async (t, m) => alerts.push(t), { enabled: true });
  await engine.tick({ force: true });
  await engine.tick({ force: true });
  assert.equal(store.state.settings.paused, false);
  await engine.tick({ force: true });
  assert.equal(store.state.settings.paused, true);
  assert.ok(alerts.includes('Autopilot paused'));

  const ok = lanes({ crypto: false, settings: { autopilot: true, autopilotFailLimit: 2 } });
  ok.engine.failStreak = 1;
  await ok.engine.tick({ force: true });
  assert.equal(ok.engine.failStreak, 0);
  assert.equal(ok.store.state.settings.paused, false);

  // the same failures without autopilot never pause anything
  const manual = lanes({ crypto: false, settings: { autopilot: false, mode: 'live', broker: 'alpaca' } });
  for (let i = 0; i < 4; i++) await manual.engine.tick({ force: true });
  assert.equal(manual.store.state.settings.paused, false);
});

test('autopilot: pauses new buys when an account falls too far from its peak, but exits still run', async () => {
  let clock = new Date('2026-10-26T15:00:00Z');
  const { store, engine, stockData } = lanes({ crypto: false, now: () => clock, settings: { autopilot: true, autopilotDrawdownPct: 10 } });
  await engine.tick({ force: true });
  assert.equal(store.state.settings.paused, false);
  const t = store.state.trades[0];
  store.state.paper.cash = 60; // pretend the account lost value: 60 + position vs. a $100 peak
  stockData.setPrice('AAA', t.stop - 0.01);
  clock = new Date(clock.getTime() + 20 * 60000); // snapshots are taken at most every 10 minutes
  const r = await engine.tick({ force: true });
  assert.equal(r.exits.length, 1, 'the stop still fired');
  assert.equal(store.state.settings.paused, true);
});

test('API: autopilot turns scanning on, live autopilot needs confirmation, warnings can be hidden', async () => {
  const { call, token, close } = await boot();
  try {
    const on = await call('/api/settings', { method: 'POST', token, body: { autopilot: true, autopilotFailLimit: 2, showWarnings: false } });
    assert.equal(on.body.settings.autopilot, true);
    assert.equal(on.body.settings.autoRun, true);
    assert.equal(on.body.settings.showWarnings, false);
    assert.equal(on.body.settings.autopilotFailLimit, 2);
    const bad = await call('/api/settings', { method: 'POST', token, body: { autopilotDrawdownPct: 500, showWarnings: 'no' } });
    assert.deepEqual(bad.body.rejected.sort(), ['autopilotDrawdownPct', 'showWarnings']);
    await call('/api/settings', { method: 'POST', token, body: { autopilot: false, autoRun: false } });
    const live = await call('/api/settings', { method: 'POST', token, body: { mode: 'live', broker: 'alpaca', stocksEnabled: true, autopilot: true } });
    assert.equal(live.status, 400); // live itself is refused first (no confirmation / keys)
  } finally {
    close();
  }
});

// ---------------------------------------------------------------- smart mode
const smart = require('../server/smart');

test('smart sizing: risk slice divided by stop distance, capped by position share, floored to cents', () => {
  const l = smart.smartLimits({ riskLevel: 'balanced' }, 'stocks', 1000);
  assert.equal(l.riskDollars, 10); // 1% of $1000
  assert.equal(l.maxPositionDollars, 250); // 25%
  assert.equal(smart.smartTradeDollars(l, 100, 97), 250); // $10 / 3% = $333 -> capped at $250
  assert.equal(smart.smartTradeDollars(l, 100, 90), 100); // wider 10% stop -> $10 / 10% = $100
  assert.equal(smart.smartTradeDollars(l, 100, 90, { cash: 60 }), 60); // limited by cash
  assert.equal(smart.smartTradeDollars(l, 100, 90, { liveCap: 25 }), 25); // limited by the live cap
  assert.equal(smart.smartTradeDollars(smart.smartLimits({ riskLevel: 'cautious' }, 'stocks', 5), 100, 97, { minTrade: 1 }), 0); // $5 account: 15% is $0.75, under the $1 minimum
  // crypto risks half as much; budget limits what is managed
  assert.equal(smart.smartLimits({ riskLevel: 'balanced' }, 'crypto', 1000).riskDollars, 5);
  assert.equal(smart.smartLimits({ riskLevel: 'balanced', smartBudgetStocks: 200 }, 'stocks', 1000).managed, 200);
  assert.equal(smart.smartLimits({ riskLevel: 'balanced', smartBudgetStocks: 5000 }, 'stocks', 1000).managed, 1000);
  assert.ok(smart.smartPlan({ riskLevel: 'aggressive' }, 'stocks', 500).typicalTradeDollars > 0);
});

test('smart mode: trade size follows the account balance and the risk level', async () => {
  const small = lanes({ crypto: false, settings: { smartMode: true, riskLevel: 'aggressive', tradeDollars: 1 } });
  small.store.state.paper.cash = 1000;
  await small.engine.tick({ force: true });
  const t = small.store.state.trades[0];
  assert.ok(t, 'took the trade');
  // aggressive: 2% of $1000 = $20 risk; stop is ~3% away -> ~$667, capped at 35% = $350
  assert.ok(Math.abs(t.qty * t.entryPrice - 350) < 1, `spent ${t.qty * t.entryPrice}`);
  assert.ok(small.store.state.settings.tradeDollars === 1, 'manual size setting is left as it was');

  const tiny = lanes({ crypto: false, settings: { smartMode: true, riskLevel: 'cautious' } });
  tiny.store.state.paper.cash = 5; // 15% of $5 = $0.75, under the $1 minimum trade
  const r = await tiny.engine.tick({ force: true });
  assert.equal(tiny.store.state.trades.length, 0);
  assert.match(r.signals[0].reason, /smart mode: no room/);
});

test('smart mode: a budget caps how much of the account the app may use in total', async () => {
  const { store, engine } = lanes({ crypto: false, settings: { smartMode: true, riskLevel: 'aggressive', smartBudgetStocks: 100, watchlist: ['AAA', 'BBB'] } });
  store.state.paper.cash = 1000;
  engine.data.map.BBB = pullbackCloses();
  await engine.tick({ force: true });
  const spent = store.state.trades.reduce((a, t) => a + t.qty * t.entryPrice, 0);
  assert.ok(spent <= 100 + 0.01, `spent ${spent} of a $100 budget`);
  assert.ok(spent > 0);
});

test('smart mode: holdings the app did not open do not use up its position slots', async () => {
  const { store, engine } = lanes({ crypto: false, settings: { smartMode: true, riskLevel: 'cautious' } }); // cautious allows 3
  store.state.paper.cash = 1000;
  store.state.paper.positions = { VOO: { qty: 1, avgCost: 100 }, SCHD: { qty: 1, avgCost: 20 }, WTRG: { qty: 1, avgCost: 30 } };
  engine.data.map.VOO = engine.data.map.SCHD = engine.data.map.WTRG = [100, 100];
  const r = await engine.tick({ force: true });
  assert.equal(r.entries.length, 1, 'still opened AAA with three other holdings present');
});

test('smart mode: pauses new buys on a drawdown even without autopilot', async () => {
  let clock = new Date('2026-10-26T15:00:00Z');
  const { store, engine } = lanes({ crypto: false, now: () => clock, settings: { smartMode: true, riskLevel: 'cautious' } }); // pauses at -10%
  store.state.paper.cash = 1000;
  await engine.tick({ force: true });
  store.state.paper.cash = 700; // account value falls well past 10%
  clock = new Date(clock.getTime() + 20 * 60000);
  await engine.tick({ force: true });
  assert.equal(store.state.settings.paused, true);
});

test('API: smart settings validated; status carries the plan and the risk profiles', async () => {
  const { call, token, close } = await boot();
  try {
    const bad = await call('/api/settings', { method: 'POST', token, body: { riskLevel: 'yolo', smartBudgetStocks: -5, smartMode: 'on' } });
    assert.deepEqual(bad.body.rejected.sort(), ['riskLevel', 'smartBudgetStocks', 'smartMode']);
    await call('/api/settings', { method: 'POST', token, body: { smartMode: true, riskLevel: 'aggressive', smartBudgetStocks: 50 } });
    const st = await call('/api/status', { token });
    assert.equal(st.body.classes.stocks.smart.managed, 50);
    assert.equal(st.body.classes.stocks.smart.maxPositions, 5);
    assert.ok(st.body.riskProfiles.cautious.label);
  } finally {
    close();
  }
});
