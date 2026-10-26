'use strict';
// Webull OpenAPI adapter (US). Built from Webull's published signing spec and the paths used by their official
// Python SDK (webull-openapi-python-sdk 3.0.4). The signing code is checked against Webull's worked example in the tests.
// STATUS: NOT tested against a real Webull account. Response field names below are read defensively because the public
// docs don't show them. Start in the SANDBOX (default) and read every order response before going further.
//
// Access: apply under Webull account -> Developer Tool -> OpenAPI Management (individuals: approval takes 1-2 business days;
// sandbox is approved automatically). You get an App Key and App Secret.
// Env: WEBULL_APP_KEY, WEBULL_APP_SECRET, WEBULL_SANDBOX (true by default), WEBULL_ACCOUNT_ID (optional)
// Whole shares only: Webull's documented order examples use quantity-based orders.

const crypto = require('crypto');

const md5Upper = (s) => crypto.createHash('md5').update(s).digest('hex').toUpperCase();

// Webull signature v1.0, HMAC-SHA1:
//   str1 = query params + signing headers, sorted by name, joined as name=value with '&'
//   str2 = uppercase hex MD5 of the exact body string (if any)
//   signed = urlencode(path & str1 [& str2]);  signature = base64(HMAC-SHA1(secret + '&', signed))
function webullSignature({ path, query = {}, signingHeaders, body, secret }) {
  const pairs = Object.entries({ ...query, ...signingHeaders }).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const str1 = pairs.map(([k, v]) => `${k}=${v}`).join('&');
  const str3 = body ? `${path}&${str1}&${md5Upper(body)}` : `${path}&${str1}`;
  const encoded = encodeURIComponent(str3);
  return crypto.createHmac('sha1', `${secret}&`).update(encoded).digest('base64');
}

// Finds the first numeric value under any of the candidate key names, searching nested objects.
function pickNum(obj, names) {
  if (obj == null || typeof obj !== 'object') return undefined;
  for (const n of names) if (obj[n] != null && obj[n] !== '' && !isNaN(Number(obj[n]))) return Number(obj[n]);
  for (const v of Object.values(obj)) {
    const r = pickNum(v, names);
    if (r !== undefined) return r;
  }
  return undefined;
}

const asList = (j) => (Array.isArray(j) ? j : j && (j.data || j.items || j.positions || j.accounts || j.orders)) || [];

class WebullBroker {
  constructor(env = process.env, data, fetchImpl = fetch) {
    this.name = 'webull';
    this.data = data;
    this.fetch = fetchImpl;
    this.appKey = env.WEBULL_APP_KEY;
    this.appSecret = env.WEBULL_APP_SECRET;
    if (!this.appKey || !this.appSecret) throw new Error('WEBULL_APP_KEY and WEBULL_APP_SECRET are not set');
    this.sandbox = String(env.WEBULL_SANDBOX || 'true').toLowerCase() !== 'false';
    this.host = env.WEBULL_API_HOST || (this.sandbox ? 'api.sandbox.webull.com' : 'api.webull.com');
    this.accountId = env.WEBULL_ACCOUNT_ID || null;
  }

  async _req(method, path, { query = {}, body, extraHeaders = {} } = {}) {
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const signingHeaders = {
      'x-app-key': this.appKey,
      'x-signature-algorithm': 'HMAC-SHA1',
      'x-signature-version': '1.0',
      'x-signature-nonce': crypto.randomBytes(16).toString('hex'),
      'x-timestamp': new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      host: this.host,
    };
    const signature = webullSignature({ path, query, signingHeaders, body: bodyStr, secret: this.appSecret });
    const { host, ...sendHeaders } = signingHeaders; // host is signed but the HTTP client sets it
    const qs = Object.keys(query).length ? '?' + Object.entries(query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&') : '';
    const r = await this.fetch(`https://${this.host}${path}${qs}`, {
      method,
      headers: { ...sendHeaders, 'x-signature': signature, 'x-version': 'v3', 'content-type': 'application/json', ...extraHeaders },
      body: bodyStr,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`Webull ${r.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  }

  async _account() {
    if (this.accountId) return this.accountId;
    const list = asList(await this._req('GET', '/trading/accounts/list'));
    const a = list[0];
    const id = a && (a.account_id || a.accountId);
    if (!id) throw new Error('Webull: no account returned');
    this.accountId = id;
    return id;
  }

  async account() {
    const id = await this._account();
    const j = await this._req('GET', '/trading/assets/balances/get', { query: { account_id: id } });
    const equity = pickNum(j, ['total_net_liquidation_value', 'net_liquidation_value', 'total_asset', 'total_assets', 'net_liquidation']);
    const cash = pickNum(j, ['cash_balance', 'total_cash_balance', 'cash', 'settled_cash', 'cash_power']);
    const bp = pickNum(j, ['buying_power', 'day_buying_power', 'cash_power']);
    if (equity === undefined && cash === undefined) throw new Error('Webull: could not find balance fields in the response; check the raw reply');
    return { cash: cash ?? bp ?? 0, equity: equity ?? cash, buyingPower: bp ?? cash ?? 0 };
  }

  async positions() {
    const id = await this._account();
    const j = await this._req('GET', '/trading/assets/positions/list', { query: { account_id: id } });
    return asList(j).map((p) => ({
      symbol: p.symbol || p.ticker,
      qty: pickNum(p, ['quantity', 'qty', 'position']) ?? 0,
      avgCost: pickNum(p, ['cost_price', 'avg_cost', 'unit_cost', 'average_price']) ?? 0,
      price: pickNum(p, ['last_price', 'market_price', 'price']) ?? 0,
      marketValue: pickNum(p, ['market_value', 'marketValue']) ?? 0,
    }));
  }

  async placeOrder({ symbol, side, notional, qty }) {
    let shares = qty;
    if (shares == null) {
      const price = await this.data.getQuote(symbol);
      shares = Math.floor(notional / price);
      if (shares < 1) throw new Error(`Webull trades whole shares only; $${notional} buys less than one share of ${symbol}`);
    }
    shares = Math.floor(shares);
    const accountId = await this._account();
    const clientOrderId = crypto.randomUUID().replace(/-/g, '');
    await this._req('POST', '/trading/orders/place', {
      body: {
        account_id: accountId,
        new_orders: [
          {
            combo_type: 'NORMAL',
            client_order_id: clientOrderId,
            symbol,
            instrument_type: 'EQUITY',
            market: 'US',
            order_type: 'MARKET',
            quantity: String(shares),
            support_trading_session: 'CORE',
            side: side === 'buy' ? 'BUY' : 'SELL',
            time_in_force: 'DAY',
            entrust_type: 'QTY',
          },
        ],
      },
      extraHeaders: { category: 'US_STOCK' },
    });
    return { id: clientOrderId, status: 'pending', filledQty: shares };
  }

  async getOrder(clientOrderId) {
    const accountId = await this._account();
    const j = await this._req('GET', '/trading/orders/get', { query: { account_id: accountId, client_order_id: clientOrderId } });
    const text = JSON.stringify(j).toUpperCase();
    const filled = /"STATUS":"FILLED"/.test(text);
    return {
      id: clientOrderId,
      status: filled ? 'filled' : /CANCEL|REJECT|FAIL/.test(text) ? 'canceled' : 'pending',
      filledQty: pickNum(j, ['filled_quantity', 'filled_qty']),
      filledAvgPrice: pickNum(j, ['filled_price', 'avg_filled_price', 'filled_avg_price', 'avg_price']),
    };
  }
}

module.exports = { WebullBroker, webullSignature, pickNum };
