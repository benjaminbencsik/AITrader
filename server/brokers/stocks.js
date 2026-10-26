'use strict';
// Extra US stock brokers: Tradier, Tastytrade, Public, Interactive Brokers.
// STATUS: written from each broker's published API docs. NONE has been run against a real account, and response field names
// are read defensively where the public docs don't show them. Use each one's sandbox/paper option first where it exists.
// Whole shares only except Public, which accepts a dollar amount.

const crypto = require('crypto');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// First numeric value under any of the candidate names, searching nested objects.
function pickNum(obj, names) {
  if (obj == null || typeof obj !== 'object') return undefined;
  for (const n of names) if (obj[n] != null && obj[n] !== '' && !isNaN(Number(obj[n]))) return Number(obj[n]);
  for (const v of Object.values(obj)) {
    const r = pickNum(v, names);
    if (r !== undefined) return r;
  }
  return undefined;
}
const asArray = (x) => (x == null || x === 'null' ? [] : Array.isArray(x) ? x : [x]);

class StockBase {
  constructor(name, data, fetchImpl, pollMs = 1000) {
    this.name = name;
    this.data = data;
    this.fetch = fetchImpl;
    this.pollMs = pollMs;
  }
  async _shares(symbol, notional, qty) {
    if (qty != null) return Math.floor(qty);
    const price = await this.data.getQuote(symbol);
    const n = Math.floor(notional / price);
    if (n < 1) throw new Error(`${this.name} trades whole shares only; $${notional} buys less than one share of ${symbol}`);
    return n;
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
}

// ------------------------------------------------------------------ Tradier
// Docs: docs.tradier.com. Env: TRADIER_ACCESS_TOKEN, TRADIER_ACCOUNT_ID, TRADIER_SANDBOX (true by default -> sandbox.tradier.com)
class TradierBroker extends StockBase {
  constructor(env = process.env, data, fetchImpl = fetch, opts = {}) {
    super('tradier', data, fetchImpl, opts.pollMs);
    this.token = env.TRADIER_ACCESS_TOKEN;
    this.acct = env.TRADIER_ACCOUNT_ID;
    if (!this.token || !this.acct) throw new Error('TRADIER_ACCESS_TOKEN and TRADIER_ACCOUNT_ID are not set');
    this.sandbox = String(env.TRADIER_SANDBOX || 'true').toLowerCase() !== 'false';
    this.base = env.TRADIER_URL || (this.sandbox ? 'https://sandbox.tradier.com/v1' : 'https://api.tradier.com/v1');
  }
  async _req(method, path, form) {
    const r = await this.fetch(this.base + path, {
      method,
      headers: { authorization: `Bearer ${this.token}`, accept: 'application/json', ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`Tradier ${r.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  }
  async account() {
    const b = (await this._req('GET', `/accounts/${this.acct}/balances`)).balances || {};
    const cash = pickNum(b.cash || {}, ['cash_available']) ?? pickNum(b, ['total_cash', 'cash_available']) ?? 0;
    return { cash, equity: Number(b.total_equity), buyingPower: Number(b.buying_power ?? cash) };
  }
  async positions() {
    const j = await this._req('GET', `/accounts/${this.acct}/positions`);
    const list = asArray(j.positions && j.positions.position);
    const out = [];
    for (const p of list) {
      const qty = Number(p.quantity);
      const price = await this.data.getQuote(p.symbol);
      out.push({ symbol: p.symbol, qty, avgCost: Number(p.cost_basis) / qty, price, marketValue: qty * price });
    }
    return out;
  }
  async placeOrder({ symbol, side, notional, qty }) {
    const shares = await this._shares(symbol, notional, qty);
    const j = await this._req('POST', `/accounts/${this.acct}/orders`, { class: 'equity', symbol, side, quantity: String(shares), type: 'market', duration: 'day' });
    if (!j.order || j.order.id == null) throw new Error(`Tradier: no order id in reply ${JSON.stringify(j).slice(0, 200)}`);
    return this._waitFilled(String(j.order.id));
  }
  async getOrder(id) {
    const o = (await this._req('GET', `/accounts/${this.acct}/orders/${id}`)).order || {};
    return {
      id,
      status: o.status === 'filled' ? 'filled' : ['canceled', 'rejected', 'expired'].includes(o.status) ? 'failed' : 'pending',
      rawStatus: o.status,
      filledQty: Number(o.exec_quantity) || undefined,
      filledAvgPrice: Number(o.avg_fill_price) || undefined,
    };
  }
}

// ------------------------------------------------------------------ Tastytrade
// Docs: developer.tastytrade.com. Create an OAuth application and a personal refresh token (scopes: read, trade).
// Env: TASTYTRADE_CLIENT_SECRET, TASTYTRADE_REFRESH_TOKEN, TASTYTRADE_ACCOUNT, TASTYTRADE_SANDBOX (true by default -> api.cert.tastyworks.com)
class TastytradeBroker extends StockBase {
  constructor(env = process.env, data, fetchImpl = fetch, opts = {}) {
    super('tastytrade', data, fetchImpl, opts.pollMs);
    this.secret = env.TASTYTRADE_CLIENT_SECRET;
    this.refresh = env.TASTYTRADE_REFRESH_TOKEN;
    this.acct = env.TASTYTRADE_ACCOUNT;
    if (!this.secret || !this.refresh || !this.acct) throw new Error('TASTYTRADE_CLIENT_SECRET, TASTYTRADE_REFRESH_TOKEN and TASTYTRADE_ACCOUNT are not set');
    this.sandbox = String(env.TASTYTRADE_SANDBOX || 'true').toLowerCase() !== 'false';
    this.base = env.TASTYTRADE_URL || (this.sandbox ? 'https://api.cert.tastyworks.com' : 'https://api.tastyworks.com');
    this.access = null;
    this.accessUntil = 0;
  }
  async _token() {
    if (this.access && Date.now() < this.accessUntil) return this.access;
    const r = await this.fetch(`${this.base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'aitrader/1.0' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: this.refresh, client_secret: this.secret }),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`Tastytrade login ${r.status}: ${text.slice(0, 200)}`);
    const j = JSON.parse(text);
    this.access = j.access_token;
    this.accessUntil = Date.now() + ((Number(j.expires_in) || 900) - 60) * 1000;
    return this.access;
  }
  async _req(method, path, body) {
    const r = await this.fetch(this.base + path, {
      method,
      headers: { authorization: `Bearer ${await this._token()}`, 'content-type': 'application/json', 'user-agent': 'aitrader/1.0' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`Tastytrade ${r.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  }
  async account() {
    const b = (await this._req('GET', `/accounts/${this.acct}/balances`)).data || {};
    const cash = pickNum(b, ['cash-balance', 'cash-available-to-withdraw']) ?? 0;
    return { cash, equity: pickNum(b, ['net-liquidation-value']) ?? cash, buyingPower: pickNum(b, ['equity-buying-power', 'cash-balance']) ?? cash };
  }
  async positions() {
    const j = (await this._req('GET', `/accounts/${this.acct}/positions`)).data || {};
    const out = [];
    for (const p of j.items || []) {
      if (p['instrument-type'] !== 'Equity') continue;
      const qty = Number(p.quantity) * (p['quantity-direction'] === 'Short' ? -1 : 1);
      const price = await this.data.getQuote(p.symbol);
      out.push({ symbol: p.symbol, qty, avgCost: Number(p['average-open-price']), price, marketValue: qty * price });
    }
    return out;
  }
  async placeOrder({ symbol, side, notional, qty }) {
    const shares = await this._shares(symbol, notional, qty);
    const j = await this._req('POST', `/accounts/${this.acct}/orders`, {
      'time-in-force': 'Day',
      'order-type': 'Market',
      source: 'aitrader',
      'external-identifier': crypto.randomBytes(12).toString('hex'),
      legs: [{ 'instrument-type': 'Equity', symbol, quantity: shares, action: side === 'buy' ? 'Buy to Open' : 'Sell to Close' }],
    });
    const id = j.data && j.data.order && j.data.order.id;
    if (id == null) throw new Error(`Tastytrade: no order id in reply ${JSON.stringify(j).slice(0, 200)}`);
    return this._waitFilled(String(id));
  }
  async getOrder(id) {
    const o = (await this._req('GET', `/accounts/${this.acct}/orders/${id}`)).data || {};
    const fills = (o.legs || []).flatMap((l) => l.fills || []);
    const qty = fills.reduce((a, f) => a + Number(f.quantity || 0), 0);
    const avg = qty ? fills.reduce((a, f) => a + Number(f['fill-price']) * Number(f.quantity), 0) / qty : undefined;
    const st = String(o.status || '');
    return {
      id,
      status: st === 'Filled' ? 'filled' : ['Cancelled', 'Rejected', 'Expired'].includes(st) ? 'failed' : 'pending',
      rawStatus: st,
      filledQty: qty || undefined,
      filledAvgPrice: avg,
    };
  }
}

// ------------------------------------------------------------------ Public.com
// Docs: public.com/api/docs. Create a secret key at public.com/settings/security/api. Fractional dollar orders are supported.
// Env: PUBLIC_API_SECRET, PUBLIC_ACCOUNT_ID
class PublicBroker extends StockBase {
  constructor(env = process.env, data, fetchImpl = fetch, opts = {}) {
    super('public', data, fetchImpl, opts.pollMs);
    this.secret = env.PUBLIC_API_SECRET;
    this.acct = env.PUBLIC_ACCOUNT_ID;
    if (!this.secret || !this.acct) throw new Error('PUBLIC_API_SECRET and PUBLIC_ACCOUNT_ID are not set');
    this.base = env.PUBLIC_URL || 'https://api.public.com';
    this.access = null;
    this.accessUntil = 0;
  }
  async _token() {
    if (this.access && Date.now() < this.accessUntil) return this.access;
    const r = await this.fetch(`${this.base}/userapiauthservice/personal/access-tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ validityInMinutes: 60, secret: this.secret }),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`Public login ${r.status}: ${text.slice(0, 200)}`);
    this.access = JSON.parse(text).accessToken;
    this.accessUntil = Date.now() + 55 * 60000;
    return this.access;
  }
  async _req(method, path, body) {
    const r = await this.fetch(this.base + path, {
      method,
      headers: { authorization: `Bearer ${await this._token()}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`Public ${r.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  }
  async _portfolio() {
    return this._req('GET', `/userapigateway/trading/${this.acct}/portfolio/v2`);
  }
  async account() {
    const p = await this._portfolio();
    const cash = pickNum(p.buyingPower || {}, ['cashOnlyBuyingPower', 'buyingPower']) ?? 0;
    const eq = (p.equity || []).reduce((a, e) => a + (Number(e.value) || 0), 0);
    return { cash, equity: eq || cash, buyingPower: pickNum(p.buyingPower || {}, ['buyingPower', 'cashOnlyBuyingPower']) ?? cash };
  }
  async positions() {
    const p = await this._portfolio();
    const out = [];
    for (const x of p.positions || []) {
      const symbol = x.instrument && x.instrument.symbol;
      if (!symbol || (x.instrument.type && x.instrument.type !== 'EQUITY')) continue;
      const qty = Number(x.quantity);
      const price = await this.data.getQuote(symbol);
      out.push({ symbol, qty, avgCost: pickNum(x.costBasis || {}, ['unitCost']) ?? price, price, marketValue: qty * price });
    }
    return out;
  }
  async placeOrder({ symbol, side, notional, qty }) {
    const body = {
      orderId: crypto.randomUUID(),
      instrument: { symbol, type: 'EQUITY' },
      orderSide: side.toUpperCase(),
      orderType: 'MARKET',
      expiration: { timeInForce: 'DAY' },
    };
    if (side === 'buy' && notional != null) body.amount = notional.toFixed(2);
    else body.quantity = String(qty);
    const j = await this._req('POST', `/userapigateway/trading/${this.acct}/order`, body);
    return this._waitFilled(j.orderId || body.orderId);
  }
  async getOrder(id) {
    const o = await this._req('GET', `/userapigateway/trading/${this.acct}/order/${id}`);
    const st = String(o.status || '').toUpperCase();
    return {
      id,
      status: st === 'FILLED' ? 'filled' : ['CANCELLED', 'CANCELED', 'REJECTED', 'EXPIRED'].includes(st) ? 'failed' : 'pending',
      rawStatus: st,
      filledQty: pickNum(o, ['filledQuantity', 'filled_quantity']),
      filledAvgPrice: pickNum(o, ['averageFillPrice', 'avgFillPrice', 'averagePrice']),
    };
  }
}

// ------------------------------------------------------------------ Interactive Brokers (Client Portal Web API)
// Needs the IBKR Client Portal Gateway running somewhere this server can reach, and you must log in to it in a browser
// (it signs you out about once a day), so this is a poor fit for an unattended server. Gateway uses a self-signed
// certificate: point NODE_EXTRA_CA_CERTS at it, or run the gateway behind a proxy with a real certificate.
// Env: IBKR_GATEWAY_URL (default https://localhost:5000/v1/api), IBKR_ACCOUNT_ID (optional)
class IbkrBroker extends StockBase {
  constructor(env = process.env, data, fetchImpl = fetch, opts = {}) {
    super('ibkr', data, fetchImpl, opts.pollMs);
    this.base = (env.IBKR_GATEWAY_URL || 'https://localhost:5000/v1/api').replace(/\/$/, '');
    this.acct = env.IBKR_ACCOUNT_ID || null;
    this.conids = {};
  }
  async _req(method, path, body) {
    const r = await this.fetch(this.base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    if (r.status === 401) throw new Error('IBKR: gateway session expired; log in to the Client Portal Gateway again');
    if (!r.ok) throw new Error(`IBKR ${r.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  }
  async _account() {
    if (this.acct) return this.acct;
    const list = await this._req('GET', '/portfolio/accounts');
    if (!list.length) throw new Error('IBKR: no accounts returned');
    this.acct = list[0].accountId || list[0].id;
    return this.acct;
  }
  async _conid(symbol) {
    if (this.conids[symbol]) return this.conids[symbol];
    const r = await this._req('GET', `/iserver/secdef/search?symbol=${encodeURIComponent(symbol)}&secType=STK`);
    const hit = (Array.isArray(r) ? r : []).find((x) => x.symbol === symbol) || (Array.isArray(r) ? r[0] : null);
    if (!hit || !hit.conid) throw new Error(`IBKR: no contract found for ${symbol}`);
    this.conids[symbol] = Number(hit.conid);
    return this.conids[symbol];
  }
  async account() {
    const a = await this._account();
    const s = await this._req('GET', `/portfolio/${a}/summary`);
    const cash = pickNum(s.totalcashvalue || {}, ['amount']) ?? 0;
    return { cash, equity: pickNum(s.netliquidation || {}, ['amount']) ?? cash, buyingPower: pickNum(s.buyingpower || {}, ['amount']) ?? cash };
  }
  async positions() {
    const a = await this._account();
    const list = await this._req('GET', `/portfolio/${a}/positions/0`);
    return (Array.isArray(list) ? list : [])
      .filter((p) => p.assetClass === 'STK' && Number(p.position) !== 0)
      .map((p) => ({ symbol: p.ticker || p.contractDesc, qty: Number(p.position), avgCost: Number(p.avgCost), price: Number(p.mktPrice), marketValue: Number(p.mktValue) }));
  }
  async placeOrder({ symbol, side, notional, qty }) {
    const shares = await this._shares(symbol, notional, qty);
    const a = await this._account();
    const conid = await this._conid(symbol);
    let r = await this._req('POST', `/iserver/account/${a}/orders`, {
      orders: [{ conid, orderType: 'MKT', side: side.toUpperCase(), quantity: shares, tif: 'DAY', cOID: crypto.randomBytes(8).toString('hex') }],
    });
    // IBKR may answer with warnings that must be confirmed before the order is accepted.
    for (let i = 0; i < 3 && Array.isArray(r) && r[0] && r[0].id && !r[0].order_id; i++) {
      r = await this._req('POST', `/iserver/reply/${r[0].id}`, { confirmed: true });
    }
    const id = Array.isArray(r) && r[0] && (r[0].order_id || r[0].orderId);
    if (!id) throw new Error(`IBKR: order not accepted: ${JSON.stringify(r).slice(0, 200)}`);
    return this._waitFilled(String(id));
  }
  async getOrder(id) {
    const j = await this._req('GET', '/iserver/account/orders');
    const o = (j.orders || []).find((x) => String(x.orderId) === String(id));
    if (!o) return { id, status: 'pending' };
    const st = String(o.status || '');
    return {
      id,
      status: st === 'Filled' ? 'filled' : ['Cancelled', 'Rejected', 'Inactive'].includes(st) ? 'failed' : 'pending',
      rawStatus: st,
      filledQty: Number(o.filledQuantity) || undefined,
      filledAvgPrice: Number(o.avgPrice) || undefined,
    };
  }
}

module.exports = { TradierBroker, TastytradeBroker, PublicBroker, IbkrBroker };
