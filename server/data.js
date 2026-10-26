'use strict';
// Market data providers. `alpaca` uses Alpaca's data API (free IEX feed works with any Alpaca account).
// `demo` generates synthetic prices so the whole app can be tried with no accounts or keys.

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEMO_SETUP = new Set(['SCHD', 'KO']);

class DemoData {
  constructor() {
    this.name = 'demo';
  }
  // Demo only: these symbols get a clean uptrend-then-pullback shape so a scan finds a setup.
  _setupCloses(symbol) {
    const rnd = mulberry32(hashSeed(symbol));
    let p = 40 + rnd() * 40;
    const c = [];
    for (let i = 0; i < 240; i++) {
      p *= 1 + 0.0035 + (i % 2 ? 0.004 : -0.003);
      c.push(p);
    }
    for (let i = 0; i < 8; i++) c.push((p *= 0.992));
    for (let i = 0; i < 2; i++) c.push((p *= 1.006));
    return c;
  }
  async getBars(symbol, count = 260) {
    if (DEMO_SETUP.has(symbol)) {
      const closes = this._setupCloses(symbol);
      const end = new Date();
      end.setUTCHours(0, 0, 0, 0);
      return closes
        .map((c, i) => ({ t: new Date(end.getTime() - (closes.length - i) * 86400e3).toISOString(), o: c, h: c, l: c, c, v: 1e6 }))
        .slice(-count);
    }
    const rnd = mulberry32(hashSeed(symbol));
    let price = 20 + rnd() * 180;
    const drift = 0.0004 + rnd() * 0.0006;
    const bars = [];
    const end = new Date();
    end.setUTCHours(0, 0, 0, 0);
    const days = [];
    for (let d = new Date(end); days.length < count; d.setUTCDate(d.getUTCDate() - 1)) {
      if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) days.push(new Date(d));
    }
    days.reverse();
    for (const d of days) {
      const ret = drift + (rnd() - 0.5) * 0.024;
      const o = price;
      price = Math.max(1, price * (1 + ret));
      bars.push({ t: d.toISOString(), o, h: Math.max(o, price) * 1.004, l: Math.min(o, price) * 0.996, c: price, v: 1e6 });
    }
    return bars;
  }
  async getQuote(symbol) {
    const bars = await this.getBars(symbol, 5);
    return bars[bars.length - 1].c;
  }
  async getHistory(symbol, years = 5) {
    return this.getBars(symbol, Math.round(years * 252));
  }
  async getNews() {
    return [];
  }
}

class AlpacaData {
  constructor(env = process.env, fetchImpl = fetch) {
    this.name = 'alpaca';
    this.fetch = fetchImpl;
    this.key = env.ALPACA_KEY_ID;
    this.secret = env.ALPACA_SECRET_KEY;
    this.base = env.ALPACA_DATA_URL || 'https://data.alpaca.markets';
    if (!this.key || !this.secret) throw new Error('ALPACA_KEY_ID and ALPACA_SECRET_KEY are required for the alpaca data provider');
  }
  async _get(path) {
    const r = await this.fetch(this.base + path, {
      headers: { 'APCA-API-KEY-ID': this.key, 'APCA-API-SECRET-KEY': this.secret },
    });
    if (!r.ok) throw new Error(`Alpaca data ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  }
  // Daily bars from `startIso` to now, following Alpaca's paging until done.
  async _bars(symbol, startIso) {
    const out = [];
    let token = null;
    for (let page = 0; page < 20; page++) {
      const q = `timeframe=1Day&start=${startIso}&limit=10000&adjustment=all&feed=iex${token ? `&page_token=${encodeURIComponent(token)}` : ''}`;
      const j = await this._get(`/v2/stocks/${encodeURIComponent(symbol)}/bars?${q}`);
      for (const b of j.bars || []) out.push({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
      token = j.next_page_token;
      if (!token) break;
    }
    return out;
  }
  async getBars(symbol, count = 260) {
    const start = new Date(Date.now() - 900 * 86400e3).toISOString().slice(0, 10);
    return (await this._bars(symbol, start)).slice(-count);
  }
  async getHistory(symbol, years = 5) {
    const start = new Date(Date.now() - years * 366 * 86400e3).toISOString().slice(0, 10);
    return this._bars(symbol, start);
  }
  async getQuote(symbol) {
    const j = await this._get(`/v2/stocks/${encodeURIComponent(symbol)}/trades/latest?feed=iex`);
    return j.trade.p;
  }
  // Headlines are untrusted text from the internet. They only ever go to the AI reviewer, which can veto but never buy.
  async getNews(symbol, limit = 5) {
    const j = await this._get(`/v1beta1/news?symbols=${encodeURIComponent(symbol)}&limit=${limit}&sort=desc`);
    return (j.news || []).map((n) => ({ t: n.created_at, source: n.source, headline: String(n.headline || '').slice(0, 200) }));
  }
}

// Reads SYMBOL.csv files from a folder. Used by the backtest CLI so you can test on files you downloaded.
class CsvData {
  constructor(dir) {
    this.name = 'csv';
    this.dir = dir;
    this.cache = new Map();
  }
  _load(symbol) {
    if (!this.cache.has(symbol)) {
      const fs = require('fs');
      const path = require('path');
      const { parseBarsCsv } = require('./csv');
      const file = fs.readdirSync(this.dir).find((f) => f.toLowerCase() === `${symbol.toLowerCase()}.csv`);
      if (!file) throw new Error(`no ${symbol}.csv in ${this.dir}`);
      this.cache.set(symbol, parseBarsCsv(fs.readFileSync(path.join(this.dir, file), 'utf8')));
    }
    return this.cache.get(symbol);
  }
  async getBars(symbol, count = 260) {
    return this._load(symbol).slice(-count);
  }
  async getHistory(symbol) {
    return this._load(symbol);
  }
  async getQuote(symbol) {
    const b = this._load(symbol);
    return b[b.length - 1].c;
  }
  async getNews() {
    return [];
  }
}

function createData(env = process.env) {
  const kind = (env.DATA_PROVIDER || (env.ALPACA_KEY_ID ? 'alpaca' : 'demo')).toLowerCase();
  if (kind === 'alpaca') return new AlpacaData(env);
  return new DemoData();
}

module.exports = { createData, DemoData, AlpacaData, CsvData };
