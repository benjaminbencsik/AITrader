'use strict';
// Daily crypto candles and prices from Coinbase Exchange's PUBLIC market-data API (no key needed).
// https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400  -> [time, low, high, open, close, volume], newest first, max 300 rows.
// Symbols look like BTC-USD. The same data feeds every crypto broker, so signals don't depend on which exchange you trade on.

class CryptoData {
  constructor(env = process.env, fetchImpl = fetch) {
    this.name = 'crypto';
    this.fetch = fetchImpl;
    this.base = env.CRYPTO_DATA_URL || 'https://api.exchange.coinbase.com';
  }

  async _get(path) {
    const r = await this.fetch(this.base + path, { headers: { 'user-agent': 'aitrader', accept: 'application/json' } });
    if (!r.ok) throw new Error(`crypto data ${r.status}: ${(await r.text()).slice(0, 150)}`);
    return r.json();
  }

  async _candles(symbol, startMs, endMs) {
    const out = [];
    const step = 300 * 86400e3;
    for (let from = startMs; from < endMs; from += step) {
      const to = Math.min(from + step, endMs);
      const rows = await this._get(`/products/${encodeURIComponent(symbol)}/candles?granularity=86400&start=${new Date(from).toISOString()}&end=${new Date(to).toISOString()}`);
      for (const [t, l, h, o, c, v] of rows) out.push({ t: new Date(t * 1000).toISOString(), o, h, l, c, v });
    }
    const seen = new Set();
    return out.sort((a, b) => (a.t < b.t ? -1 : 1)).filter((b) => !seen.has(b.t) && seen.add(b.t));
  }

  // Today's candle is still forming; the strategies decide on completed days only.
  _dropForming(bars, now = Date.now()) {
    const last = bars[bars.length - 1];
    return last && new Date(last.t).getTime() + 86400e3 > now ? bars.slice(0, -1) : bars;
  }

  async getBars(symbol, count = 260) {
    const end = Date.now();
    const bars = await this._candles(symbol, end - (count + 5) * 86400e3, end);
    return this._dropForming(bars).slice(-count);
  }

  async getHistory(symbol, years = 5) {
    const end = Date.now();
    return this._dropForming(await this._candles(symbol, end - years * 366 * 86400e3, end));
  }

  async getQuote(symbol) {
    const j = await this._get(`/products/${encodeURIComponent(symbol)}/ticker`);
    return Number(j.price);
  }

  async getNews() {
    return [];
  }
}

module.exports = { CryptoData };
