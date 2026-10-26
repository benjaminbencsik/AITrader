'use strict';
// Crypto exchange adapters: Robinhood Crypto, Kraken, Coinbase (Advanced Trade), OKX.
// STATUS: written from each exchange's published API docs. Signing code is checked in the tests (Kraken against its published
// example; the others against the published construction). NONE has been run against a real account. Start with the smallest
// trade you can, read the order response, and watch the first few fills.
//
// All four trade symbols written as BASE-QUOTE (BTC-USD); each adapter translates to its exchange's naming.
// Positions come from your whole exchange balance, so coins you already hold are visible to the app. It will not buy a coin
// you already hold, and it only ever sells the quantity it bought itself.

const crypto = require('crypto');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const floorTo = (x, dp) => {
  const f = 10 ** dp;
  return Math.floor(x * f + 1e-9) / f;
};
const trimNum = (x, dp = 8) => String(Number(x.toFixed(dp)));
const DUST_USD = 1; // holdings worth less than this are ignored
const dpOf = (step) => Math.max(0, Math.min(12, Math.ceil(-Math.log10(step) - 1e-9)));
const floorStep = (x, step) => (step > 0 ? Number((Math.floor(x / step + 1e-9) * step).toFixed(dpOf(step))) : floorTo(x, 8));

// Raised when an order is too small (or rounds to nothing) for the exchange. The engine treats it as a skip, not a failure.
class OrderSizeError extends Error {
  constructor(msg) {
    super(msg);
    this.code = 'size';
  }
}

class CryptoBase {
  constructor(name, data, fetchImpl, pollMs = 1000) {
    this.name = name;
    this.data = data;
    this.fetch = fetchImpl;
    this.pollMs = pollMs;
  }
  async _price(symbol) {
    return this.data.getQuote(symbol);
  }
  // Turns [{symbol, qty, avgCost?}] into positions with live prices, dropping dust.
  async _valued(holdings) {
    const out = [];
    for (const h of holdings) {
      if (!(h.qty > 0)) continue;
      let price;
      try {
        price = await this._price(h.symbol);
      } catch {
        continue; // a coin we can't price (and so can't trade by signal) is simply left out
      }
      const mv = h.qty * price;
      if (mv < DUST_USD) continue;
      out.push({ symbol: h.symbol, qty: h.qty, avgCost: h.avgCost != null ? h.avgCost : price, price, marketValue: mv });
    }
    return out;
  }
  // Subclasses return { minQty, qtyStep, minNotional } for a symbol (any may be missing), or null when unknown.
  async limits() {
    return null;
  }
  // Checks an order against the exchange's minimum size and size increment BEFORE sending it.
  // Returns the order quantities to use; throws OrderSizeError with a plain-English reason when it can't be placed.
  async _fit(symbol, side, { notional, qty }) {
    let lim = null;
    try {
      lim = await this.limits(symbol);
    } catch { /* limits are advisory; if the lookup fails the exchange will still reject a bad size */ }
    lim = lim || {};
    const price = await this._price(symbol);
    const name = this.name;
    if (side === 'buy' && notional != null) {
      const est = notional / price;
      if (lim.minNotional && notional < lim.minNotional) throw new OrderSizeError(`${symbol}: $${notional.toFixed(2)} is under ${name}'s minimum order of $${lim.minNotional}; skipped`);
      if (lim.minQty && est < lim.minQty) throw new OrderSizeError(`${symbol}: $${notional.toFixed(2)} buys about ${trimNum(est)} but ${name} needs at least ${lim.minQty} (about $${(lim.minQty * price).toFixed(2)}); skipped`);
      return { notional, qty: undefined, limits: lim };
    }
    const q = floorStep(qty, lim.qtyStep);
    if (!(q > 0)) throw new OrderSizeError(`${symbol}: size ${trimNum(qty)} rounds to zero at ${name}'s increment ${lim.qtyStep || '1e-8'}; skipped`);
    if (lim.minQty && q < lim.minQty) throw new OrderSizeError(`${symbol}: ${trimNum(q)} is under ${name}'s minimum of ${lim.minQty}${side === 'sell' ? ' (too small to sell; leave it or sell by hand)' : ''}; skipped`);
    if (lim.minNotional && q * price < lim.minNotional) throw new OrderSizeError(`${symbol}: about $${(q * price).toFixed(2)} is under ${name}'s minimum order of $${lim.minNotional}; skipped`);
    return { qty: q, notional: undefined, limits: lim };
  }
  async account() {
    const cash = await this._cash();
    const pos = await this.positions();
    return { cash, equity: cash + pos.reduce((a, p) => a + p.marketValue, 0), buyingPower: cash };
  }
  async _waitFilled(id) {
    for (let i = 0; i < 8; i++) {
      await sleep(i === 0 ? Math.min(300, this.pollMs) : this.pollMs);
      const o = await this.getOrder(id);
      if (o.status === 'filled') return o;
      if (o.status === 'failed') throw new Error(`order ${o.rawStatus || 'failed'}`);
    }
    return { id, status: 'pending' };
  }
  // Never sell more than the account holds (fees are sometimes taken in the coin itself).
  async _sellQty(symbol, wanted) {
    const held = (await this.positions()).find((p) => p.symbol === symbol);
    if (!held) throw new Error(`no ${symbol} balance to sell`);
    return Math.min(wanted == null ? held.qty : wanted, held.qty);
  }
}

// ------------------------------------------------------------------ Robinhood Crypto (official API)
// Docs: docs.robinhood.com/crypto/trading. Keys: Robinhood web classic -> Settings -> Crypto -> API trading.
// Env: ROBINHOOD_API_KEY, ROBINHOOD_PRIVATE_KEY (base64 of the 32-byte Ed25519 private key)
// Note: Robinhood Crypto API orders are charged a spread; there is no fractional "dollar" market order, so we convert dollars to a coin quantity at the best ask.
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function robinhoodSignature({ apiKey, timestamp, path, method, body = '', privateKeyB64 }) {
  const seed = Buffer.from(privateKeyB64, 'base64');
  const raw = seed.length === 64 ? seed.subarray(0, 32) : seed; // some tools export seed+public (64 bytes)
  if (raw.length !== 32) throw new Error('ROBINHOOD_PRIVATE_KEY must be the base64 Ed25519 private key (32 bytes)');
  const key = crypto.createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, raw]), format: 'der', type: 'pkcs8' });
  return crypto.sign(null, Buffer.from(`${apiKey}${timestamp}${path}${method}${body}`), key).toString('base64');
}

class RobinhoodCryptoBroker extends CryptoBase {
  constructor(env = process.env, data, fetchImpl = fetch, opts = {}) {
    super('robinhood-crypto', data, fetchImpl, opts.pollMs);
    this.apiKey = env.ROBINHOOD_API_KEY;
    this.priv = env.ROBINHOOD_PRIVATE_KEY;
    if (!this.apiKey || !this.priv) throw new Error('ROBINHOOD_API_KEY and ROBINHOOD_PRIVATE_KEY are not set');
    this.base = env.ROBINHOOD_CRYPTO_URL || 'https://trading.robinhood.com';
    this.now = opts.now || (() => Math.floor(Date.now() / 1000));
  }
  async _req(method, path, body) {
    const bodyStr = body ? JSON.stringify(body) : '';
    const timestamp = String(this.now());
    const r = await this.fetch(this.base + path, {
      method,
      headers: {
        'x-api-key': this.apiKey,
        'x-timestamp': timestamp,
        'x-signature': robinhoodSignature({ apiKey: this.apiKey, timestamp, path, method, body: bodyStr, privateKeyB64: this.priv }),
        'content-type': 'application/json',
      },
      body: bodyStr || undefined,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`Robinhood Crypto ${r.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  }
  async _cash() {
    const a = await this._req('GET', '/api/v1/crypto/trading/accounts/');
    return Number(a.buying_power);
  }
  async positions() {
    const j = await this._req('GET', '/api/v1/crypto/trading/holdings/');
    const hs = (j.results || []).map((h) => ({ symbol: `${h.asset_code}-USD`, qty: Number(h.total_quantity ?? h.quantity), avgCost: undefined }));
    return this._valued(hs);
  }
  async limits(symbol) {
    const j = await this._req('GET', `/api/v1/crypto/trading/trading_pairs/?symbol=${symbol}`);
    const r = j.results && j.results[0];
    if (!r) return null;
    return { minQty: Number(r.min_order_size) || undefined, qtyStep: Number(r.asset_increment) || undefined };
  }
  async placeOrder({ symbol, side, notional, qty }) {
    let want = qty;
    if (side === 'buy') {
      const bba = await this._req('GET', `/api/v1/crypto/marketdata/best_bid_ask/?symbol=${symbol}`);
      const ask = Number(bba.results[0].ask_inclusive_of_buy_spread ?? bba.results[0].price ?? bba.results[0].ask_price);
      if (want == null) want = notional / ask;
    } else {
      want = await this._sellQty(symbol, qty);
    }
    const fit = await this._fit(symbol, side, { qty: want });
    const q = fit.qty;
    const o = await this._req('POST', '/api/v1/crypto/trading/orders/', {
      client_order_id: crypto.randomUUID(),
      side,
      type: 'market',
      symbol,
      market_order_config: { asset_quantity: trimNum(q, dpOf(fit.limits.qtyStep || 1e-8)) },
    });
    return this._waitFilled(o.id);
  }
  async getOrder(id) {
    const o = await this._req('GET', `/api/v1/crypto/trading/orders/${id}/`);
    const st = String(o.state || '').toLowerCase();
    const execs = o.executions || [];
    const filledQty = Number(o.filled_asset_quantity ?? execs.reduce((a, e) => a + Number(e.quantity || 0), 0));
    return {
      id: o.id,
      status: st === 'filled' ? 'filled' : ['canceled', 'rejected', 'failed'].includes(st) ? 'failed' : 'pending',
      rawStatus: st,
      filledQty: filledQty || undefined,
      filledAvgPrice: o.average_price != null ? Number(o.average_price) : undefined,
    };
  }
}

// ------------------------------------------------------------------ Kraken
// Docs: docs.kraken.com. Create a key with "Query funds", "Query open/closed orders" and "Create & modify orders". NO withdraw permission.
// Env: KRAKEN_API_KEY, KRAKEN_API_SECRET (base64)
function krakenSignature({ path, nonce, postData, secretB64 }) {
  const sha = crypto.createHash('sha256').update(String(nonce) + postData).digest();
  return crypto.createHmac('sha512', Buffer.from(secretB64, 'base64')).update(Buffer.concat([Buffer.from(path), sha])).digest('base64');
}
const krakenAsset = (a) => {
  if (a.includes('.')) return null; // staked / opt-in rewards balances are not tradable spot
  let x = a.length === 4 && /^[XZ]/.test(a) ? a.slice(1) : a;
  if (x === 'XBT') x = 'BTC';
  return x;
};

class KrakenBroker extends CryptoBase {
  constructor(env = process.env, data, fetchImpl = fetch, opts = {}) {
    super('kraken', data, fetchImpl, opts.pollMs);
    this.key = env.KRAKEN_API_KEY;
    this.secret = env.KRAKEN_API_SECRET;
    if (!this.key || !this.secret) throw new Error('KRAKEN_API_KEY and KRAKEN_API_SECRET are not set');
    this.base = env.KRAKEN_URL || 'https://api.kraken.com';
    this._nonce = Date.now();
  }
  async _priv(endpoint, params = {}) {
    const path = `/0/private/${endpoint}`;
    const nonce = Math.max(Date.now(), this._nonce + 1); // must only ever go up
    this._nonce = nonce;
    const postData = new URLSearchParams({ nonce: String(nonce), ...params }).toString();
    const r = await this.fetch(this.base + path, {
      method: 'POST',
      headers: { 'API-Key': this.key, 'API-Sign': krakenSignature({ path, nonce, postData, secretB64: this.secret }), 'content-type': 'application/x-www-form-urlencoded' },
      body: postData,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`Kraken ${r.status}: ${text.slice(0, 300)}`);
    const j = JSON.parse(text);
    if (j.error && j.error.length) throw new Error(`Kraken: ${j.error.join('; ')}`);
    return j.result;
  }
  _pair(symbol) {
    const [b, q] = symbol.split('-');
    return `${b === 'BTC' ? 'XBT' : b}${q}`;
  }
  async _balances() {
    const bal = await this._priv('Balance');
    const out = {};
    for (const [k, v] of Object.entries(bal)) {
      const a = krakenAsset(k);
      if (a) out[a] = (out[a] || 0) + Number(v);
    }
    return out;
  }
  async _cash() {
    return (await this._balances()).USD || 0;
  }
  async positions() {
    const b = await this._balances();
    return this._valued(Object.entries(b).filter(([a]) => !['USD', 'USDT', 'USDC', 'EUR', 'GBP', 'CAD'].includes(a)).map(([a, qty]) => ({ symbol: `${a}-USD`, qty })));
  }
  async limits(symbol) {
    const r = await this.fetch(`${this.base}/0/public/AssetPairs?pair=${this._pair(symbol)}`);
    const j = await r.json();
    if (j.error && j.error.length) throw new Error(j.error.join('; '));
    const info = Object.values(j.result || {})[0];
    if (!info) return null;
    return {
      minQty: Number(info.ordermin) || undefined,
      qtyStep: info.lot_decimals != null ? 10 ** -Number(info.lot_decimals) : undefined,
      minNotional: Number(info.costmin) || undefined,
    };
  }
  async placeOrder({ symbol, side, notional, qty }) {
    const params = { pair: this._pair(symbol), type: side, ordertype: 'market' };
    const fit = await this._fit(symbol, side, { notional, qty: side === 'sell' ? await this._sellQty(symbol, qty) : qty });
    if (fit.notional != null) {
      params.volume = fit.notional.toFixed(2);
      params.oflags = 'viqc'; // volume expressed in the quote currency (USD)
    } else {
      params.volume = trimNum(fit.qty, dpOf(fit.limits.qtyStep || 1e-8));
    }
    const r = await this._priv('AddOrder', params);
    return this._waitFilled(r.txid[0]);
  }
  async getOrder(id) {
    const r = await this._priv('QueryOrders', { txid: id });
    const o = r[id];
    if (!o) return { id, status: 'pending' };
    return {
      id,
      status: o.status === 'closed' ? 'filled' : ['canceled', 'expired'].includes(o.status) ? 'failed' : 'pending',
      rawStatus: o.status,
      filledQty: Number(o.vol_exec) || undefined,
      filledAvgPrice: Number(o.price) || undefined,
      fee: Number(o.fee) || 0, // Kraken charges its fee in the quote currency (USD)
    };
  }
}

// ------------------------------------------------------------------ Coinbase Advanced Trade
// Docs: docs.cdp.coinbase.com. Create a Secret API key (ECDSA) at portal.cdp.coinbase.com with View + Trade permission only.
// Env: COINBASE_API_KEY_NAME (organizations/.../apiKeys/...), COINBASE_API_PRIVATE_KEY (the PEM; newlines may be written as \n)
const b64url = (x) => Buffer.from(x).toString('base64url');

function coinbaseJwt({ keyName, privateKeyPem, method, host, path, now = Math.floor(Date.now() / 1000), nonce = crypto.randomBytes(16).toString('hex') }) {
  const header = { alg: 'ES256', kid: keyName, nonce, typ: 'JWT' };
  const payload = { sub: keyName, iss: 'cdp', nbf: now, exp: now + 120, uri: `${method} ${host}${path}` };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = crypto.sign('sha256', Buffer.from(input), { key: privateKeyPem, dsaEncoding: 'ieee-p1363' });
  return `${input}.${sig.toString('base64url')}`;
}

class CoinbaseBroker extends CryptoBase {
  constructor(env = process.env, data, fetchImpl = fetch, opts = {}) {
    super('coinbase', data, fetchImpl, opts.pollMs);
    this.keyName = env.COINBASE_API_KEY_NAME;
    this.pem = (env.COINBASE_API_PRIVATE_KEY || '').replace(/\\n/g, '\n');
    if (!this.keyName || !this.pem) throw new Error('COINBASE_API_KEY_NAME and COINBASE_API_PRIVATE_KEY are not set');
    this.host = env.COINBASE_HOST || 'api.coinbase.com';
  }
  async _req(method, path, body) {
    const jwtPath = path.split('?')[0]; // the JWT covers the path without the query string
    const token = coinbaseJwt({ keyName: this.keyName, privateKeyPem: this.pem, method, host: this.host, path: jwtPath });
    const r = await this.fetch(`https://${this.host}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`Coinbase ${r.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  }
  async _accounts() {
    const j = await this._req('GET', '/api/v3/brokerage/accounts?limit=250');
    const out = {};
    for (const a of j.accounts || []) out[a.currency] = (out[a.currency] || 0) + Number(a.available_balance && a.available_balance.value) + Number((a.hold && a.hold.value) || 0);
    return out;
  }
  async _cash() {
    const j = await this._req('GET', '/api/v3/brokerage/accounts?limit=250');
    return (j.accounts || []).filter((a) => a.currency === 'USD').reduce((t, a) => t + Number(a.available_balance.value), 0);
  }
  async positions() {
    const b = await this._accounts();
    return this._valued(Object.entries(b).filter(([a]) => !['USD', 'USDC', 'USDT'].includes(a)).map(([a, qty]) => ({ symbol: `${a}-USD`, qty })));
  }
  async limits(symbol) {
    const p = await this._req('GET', `/api/v3/brokerage/products/${symbol}`);
    return {
      minQty: Number(p.base_min_size) || undefined,
      qtyStep: Number(p.base_increment) || undefined,
      minNotional: Number(p.quote_min_size) || undefined,
    };
  }
  async placeOrder({ symbol, side, notional, qty }) {
    const fit = await this._fit(symbol, side, { notional, qty: side === 'sell' ? await this._sellQty(symbol, qty) : qty });
    const cfg = fit.notional != null
      ? { quote_size: fit.notional.toFixed(2) }
      : { base_size: trimNum(fit.qty, dpOf(fit.limits.qtyStep || 1e-8)) };
    const j = await this._req('POST', '/api/v3/brokerage/orders', {
      client_order_id: crypto.randomUUID(),
      product_id: symbol,
      side: side.toUpperCase(),
      order_configuration: { market_market_ioc: cfg },
    });
    if (!j.success) throw new Error(`Coinbase order failed: ${(j.error_response && (j.error_response.message || j.error_response.error_details)) || JSON.stringify(j).slice(0, 200)}`);
    return this._waitFilled(j.success_response.order_id);
  }
  async getOrder(id) {
    const j = await this._req('GET', `/api/v3/brokerage/orders/historical/${id}`);
    const o = j.order || {};
    const st = String(o.status || '').toUpperCase();
    return {
      id,
      status: st === 'FILLED' ? 'filled' : ['CANCELLED', 'EXPIRED', 'FAILED'].includes(st) ? 'failed' : 'pending',
      rawStatus: st,
      filledQty: Number(o.filled_size) || undefined,
      filledAvgPrice: Number(o.average_filled_price) || undefined,
      fee: Number(o.total_fees) || 0, // quote currency (USD)
    };
  }
}

// ------------------------------------------------------------------ OKX (spot)
// Docs: okx.com/docs-v5. Create an API key with Read + Trade only (no withdraw). Demo trading uses separate demo keys from OKX's demo mode.
// Env: OKX_API_KEY, OKX_API_SECRET, OKX_PASSPHRASE, OKX_DEMO (true by default -> sends x-simulated-trading: 1), OKX_QUOTE (USDT by default)
function okxSignature({ timestamp, method, path, body = '', secret }) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}${method}${path}${body}`).digest('base64');
}

class OkxBroker extends CryptoBase {
  constructor(env = process.env, data, fetchImpl = fetch, opts = {}) {
    super('okx', data, fetchImpl, opts.pollMs);
    this.key = env.OKX_API_KEY;
    this.secret = env.OKX_API_SECRET;
    this.pass = env.OKX_PASSPHRASE;
    if (!this.key || !this.secret || !this.pass) throw new Error('OKX_API_KEY, OKX_API_SECRET and OKX_PASSPHRASE are not set');
    this.demo = String(env.OKX_DEMO || 'true').toLowerCase() !== 'false';
    this.quote = (env.OKX_QUOTE || 'USDT').toUpperCase();
    this.base = env.OKX_URL || 'https://www.okx.com';
    this.nowIso = opts.nowIso || (() => new Date().toISOString());
  }
  async _req(method, path, body) {
    const bodyStr = body ? JSON.stringify(body) : '';
    const timestamp = this.nowIso();
    const headers = {
      'OK-ACCESS-KEY': this.key,
      'OK-ACCESS-SIGN': okxSignature({ timestamp, method, path, body: bodyStr, secret: this.secret }),
      'OK-ACCESS-TIMESTAMP': timestamp,
      'OK-ACCESS-PASSPHRASE': this.pass,
      'content-type': 'application/json',
    };
    if (this.demo) headers['x-simulated-trading'] = '1';
    const r = await this.fetch(this.base + path, { method, headers, body: bodyStr || undefined });
    const text = await r.text();
    if (!r.ok) throw new Error(`OKX ${r.status}: ${text.slice(0, 300)}`);
    const j = JSON.parse(text);
    if (j.code !== '0') {
      const detail = (j.data && j.data[0] && j.data[0].sMsg) || j.msg;
      throw new Error(`OKX ${j.code}: ${detail}`);
    }
    return j.data;
  }
  _inst(symbol) {
    return `${symbol.split('-')[0]}-${this.quote}`;
  }
  async _details() {
    const d = await this._req('GET', '/api/v5/account/balance');
    return (d[0] && d[0].details) || [];
  }
  async _cash() {
    const q = (await this._details()).find((x) => x.ccy === this.quote);
    return q ? Number(q.availBal) : 0;
  }
  async positions() {
    const hs = (await this._details()).filter((x) => x.ccy !== this.quote && !['USD', 'USDC', 'USDT'].includes(x.ccy)).map((x) => ({ symbol: `${x.ccy}-USD`, qty: Number(x.eq) }));
    return this._valued(hs);
  }
  async limits(symbol) {
    const d = await this._req('GET', `/api/v5/public/instruments?instType=SPOT&instId=${this._inst(symbol)}`);
    const i = d[0];
    if (!i) return null;
    return { minQty: Number(i.minSz) || undefined, qtyStep: Number(i.lotSz) || undefined };
  }
  // Order ids carry the instrument ("BTC-USDT:123") so a later run, or a restart, can look the order up with no memory.
  async placeOrder({ symbol, side, notional, qty }) {
    const o = { instId: this._inst(symbol), tdMode: 'cash', side, ordType: 'market', clOrdId: crypto.randomBytes(12).toString('hex') };
    const fit = await this._fit(symbol, side, { notional, qty: side === 'sell' ? await this._sellQty(symbol, qty) : qty });
    if (fit.notional != null) {
      o.sz = fit.notional.toFixed(2);
      o.tgtCcy = 'quote_ccy';
    } else {
      o.sz = trimNum(fit.qty, dpOf(fit.limits.qtyStep || 1e-8));
      o.tgtCcy = 'base_ccy';
    }
    const d = await this._req('POST', '/api/v5/trade/order', o);
    return this._waitFilled(`${o.instId}:${d[0].ordId}`);
  }
  async getOrder(id) {
    const [instId, ordId] = String(id).split(':');
    if (!ordId) throw new Error('OKX: order id has no instrument; check the order on OKX');
    const d = await this._req('GET', `/api/v5/trade/order?instId=${instId}&ordId=${ordId}`);
    const o = d[0] || {};
    const px = Number(o.avgPx) || undefined;
    const fee = Math.abs(Number(o.fee)) || 0;
    const base = instId.split('-')[0];
    const feeInBase = o.feeCcy === base; // buys: OKX takes the fee out of the coins you receive
    let qty = Number(o.accFillSz) || undefined;
    if (qty && feeInBase) qty -= fee;
    return {
      id,
      status: o.state === 'filled' ? 'filled' : ['canceled', 'mmp_canceled'].includes(o.state) ? 'failed' : 'pending',
      rawStatus: o.state,
      filledQty: qty,
      filledAvgPrice: px,
      fee: feeInBase ? fee * (px || 0) : fee,
    };
  }

  // Demo accounts only: buy the smallest allowed amount and sell it straight back, to prove keys, sizing and fills work.
  async demoRoundTrip(symbol = 'BTC-USD') {
    if (!this.demo) throw new Error('the order test only runs on OKX demo trading (OKX_DEMO=true), never with real money');
    const lim = (await this.limits(symbol)) || {};
    const px = await this._price(symbol);
    const notional = Math.max(1, Math.ceil((lim.minQty || 0) * px * 1.3 * 100) / 100);
    const buy = await this.placeOrder({ symbol, side: 'buy', notional });
    const sell = await this.placeOrder({ symbol, side: 'sell', qty: buy.filledQty });
    return { notional, bought: buy.filledQty, boughtAt: buy.filledAvgPrice, soldAt: sell.filledAvgPrice, fees: (buy.fee || 0) + (sell.fee || 0) };
  }

  // ---- exchange-held target and stop (OKX one-cancels-other order). It sits on OKX, so it works while the app is off.
  async placeProtection({ symbol, qty, takeProfit, stopLoss }) {
    const fit = await this._fit(symbol, 'sell', { qty });
    const instId = this._inst(symbol);
    const d = await this._req('POST', '/api/v5/trade/order-algo', {
      instId, tdMode: 'cash', side: 'sell', ordType: 'oco', sz: trimNum(fit.qty, dpOf(fit.limits.qtyStep || 1e-8)),
      tpTriggerPx: String(takeProfit), tpOrdPx: '-1', slTriggerPx: String(stopLoss), slOrdPx: '-1',
    });
    return { id: `${instId}:${d[0].algoId}` };
  }
  async cancelProtection(id) {
    const [instId, algoId] = String(id).split(':');
    try {
      await this._req('POST', '/api/v5/trade/cancel-algos', [{ algoId, instId }]);
    } catch (e) {
      if (!/51400|51401|51402|already|not exist/i.test(e.message)) throw e; // already triggered or gone: nothing to cancel
    }
  }
  // 'active' (still waiting), 'target' / 'stop' (it fired; price is the average fill) or 'canceled'.
  async protectionResult(id, target, stop) {
    const [instId, algoId] = String(id).split(':');
    const d = await this._req('GET', `/api/v5/trade/order-algo?algoId=${algoId}`);
    const o = d[0];
    if (!o) return { state: 'unknown' };
    if (o.state === 'live' || o.state === 'partially_effective') return { state: 'active' };
    if (o.state === 'canceled' || o.state === 'order_failed') return { state: 'canceled' };
    if (o.state === 'effective') {
      let fill = Number(o.actualPx) || undefined;
      let fee = 0;
      if (o.ordId) {
        try {
          const f = await this.getOrder(`${instId}:${o.ordId}`);
          fill = f.filledAvgPrice || fill;
          fee = f.fee || 0;
        } catch { /* use the trigger price below */ }
      }
      const px = fill || Number(o.tpTriggerPx);
      return { state: px >= target * 0.999 ? 'target' : 'stop', price: px, fee };
    }
    return { state: 'unknown' };
  }
}

module.exports = {
  RobinhoodCryptoBroker, KrakenBroker, CoinbaseBroker, OkxBroker, OrderSizeError,
  robinhoodSignature, krakenSignature, coinbaseJwt, okxSignature, krakenAsset,
};
