'use strict';
// Charles Schwab Trader API (the successor to TD Ameritrade's API).
// STATUS: written from Schwab's public documentation and NOT tested against a real account.
// Test with the smallest possible order before trusting it.
//
// Setup requires: a Schwab developer app (approval takes days), then an OAuth login you do once in a browser.
// Schwab refresh tokens expire after 7 days, so you must re-authorize about weekly.
// Whole shares only (no fractional orders through this API), so each order must cost at least one share.
//
// Env: SCHWAB_APP_KEY, SCHWAB_APP_SECRET, SCHWAB_REDIRECT_URI (the https callback you registered, ending in /oauth/schwab/callback)
// Connect from the app's Settings screen ("Connect Schwab"); the refresh token is stored on the server. SCHWAB_REFRESH_TOKEN in
// the environment still works as a fallback.

const BASE = 'https://api.schwabapi.com';

class SchwabBroker {
  constructor(env = process.env, data, store, fetchImpl = fetch) {
    this.name = 'schwab';
    this.fetch = fetchImpl;
    this.appKey = env.SCHWAB_APP_KEY;
    this.appSecret = env.SCHWAB_APP_SECRET;
    this.store = store;
    this.data = data;
    const saved = store && store.state.tokens && store.state.tokens.schwab;
    this.refreshToken = (saved && saved.refreshToken) || env.SCHWAB_REFRESH_TOKEN;
    if (!this.appKey || !this.appSecret) throw new Error('SCHWAB_APP_KEY and SCHWAB_APP_SECRET are not set');
    if (!this.refreshToken) throw new Error('Schwab is not connected yet: use "Connect Schwab" in Settings');
    this.accessToken = null;
    this.expiresAt = 0;
    this.hash = null;
  }

  async _token() {
    if (this.accessToken && Date.now() < this.expiresAt - 30000) return this.accessToken;
    const basic = Buffer.from(`${this.appKey}:${this.appSecret}`).toString('base64');
    const r = await this.fetch(`${BASE}/v1/oauth/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.refreshToken }),
    });
    if (!r.ok) throw new Error(`Schwab token refresh failed (${r.status}); the refresh token may have expired, re-authorize`);
    const j = await r.json();
    this.accessToken = j.access_token;
    this.expiresAt = Date.now() + j.expires_in * 1000;
    return this.accessToken;
  }

  async _req(method, path, body) {
    const token = await this._token();
    const r = await this.fetch(BASE + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`Schwab ${r.status}: ${text.slice(0, 300)}`);
    return { json: text ? JSON.parse(text) : {}, headers: r.headers };
  }

  async _accountHash() {
    if (this.hash) return this.hash;
    const { json } = await this._req('GET', '/trader/v1/accounts/accountNumbers');
    if (!json.length) throw new Error('Schwab: no accounts returned');
    this.hash = json[0].hashValue;
    return this.hash;
  }

  async account() {
    const h = await this._accountHash();
    const { json } = await this._req('GET', `/trader/v1/accounts/${h}`);
    const b = json.securitiesAccount.currentBalances;
    return { cash: Number(b.cashBalance ?? b.availableFunds), equity: Number(b.liquidationValue), buyingPower: Number(b.buyingPower ?? b.availableFunds) };
  }

  async positions() {
    const h = await this._accountHash();
    const { json } = await this._req('GET', `/trader/v1/accounts/${h}?fields=positions`);
    return (json.securitiesAccount.positions || []).map((p) => ({
      symbol: p.instrument.symbol,
      qty: Number(p.longQuantity) - Number(p.shortQuantity || 0),
      avgCost: Number(p.averagePrice),
      marketValue: Number(p.marketValue),
      price: Number(p.marketValue) / (Number(p.longQuantity) || 1),
    }));
  }

  async placeOrder({ symbol, side, notional, qty }) {
    let shares = qty;
    if (shares == null) {
      const price = await this.data.getQuote(symbol);
      shares = Math.floor(notional / price);
      if (shares < 1) throw new Error(`Schwab trades whole shares only; $${notional} buys less than one share of ${symbol}`);
    }
    const h = await this._accountHash();
    const { headers } = await this._req('POST', `/trader/v1/accounts/${h}/orders`, {
      orderType: 'MARKET',
      session: 'NORMAL',
      duration: 'DAY',
      orderStrategyType: 'SINGLE',
      orderLegCollection: [
        { instruction: side === 'buy' ? 'BUY' : 'SELL', quantity: Math.floor(shares), instrument: { symbol, assetType: 'EQUITY' } },
      ],
    });
    const loc = headers.get('location') || '';
    const id = loc.split('/').pop();
    return { id, status: 'pending', filledQty: Math.floor(shares) };
  }

  async getOrder(id) {
    const h = await this._accountHash();
    const { json } = await this._req('GET', `/trader/v1/accounts/${h}/orders/${id}`);
    const fill = (json.orderActivityCollection || [])[0];
    const leg = fill && (fill.executionLegs || [])[0];
    return {
      id,
      status: String(json.status || '').toLowerCase() === 'filled' ? 'filled' : String(json.status || '').toLowerCase(),
      filledQty: json.filledQuantity,
      filledAvgPrice: leg ? leg.price : undefined,
    };
  }
}

// ---- one-time browser login ----
function authorizeUrl(env, state) {
  const q = new URLSearchParams({ client_id: env.SCHWAB_APP_KEY, redirect_uri: env.SCHWAB_REDIRECT_URI, response_type: 'code', state });
  return `${BASE}/v1/oauth/authorize?${q}`;
}

// Trades the one-time code from the redirect for tokens. Schwab refresh tokens last 7 days from this moment.
async function exchangeCode(env, code, fetchImpl = fetch) {
  const basic = Buffer.from(`${env.SCHWAB_APP_KEY}:${env.SCHWAB_APP_SECRET}`).toString('base64');
  const r = await fetchImpl(`${BASE}/v1/oauth/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: env.SCHWAB_REDIRECT_URI }),
  });
  if (!r.ok) throw new Error(`Schwab code exchange failed (${r.status})`);
  const j = await r.json();
  if (!j.refresh_token) throw new Error('Schwab did not return a refresh token');
  return { refreshToken: j.refresh_token, obtainedAt: new Date().toISOString() };
}

module.exports = { SchwabBroker, authorizeUrl, exchangeCode };
