'use strict';
// Earnings calendar (Finnhub free tier: https://finnhub.io). Returns the next report date inside a window, or null.
// If the lookup FAILS it throws; the engine then refuses the trade rather than guessing.

function ymd(d) {
  return d.toISOString().slice(0, 10);
}

class FinnhubCalendar {
  constructor(env = process.env, fetchImpl = fetch) {
    this.key = env.FINNHUB_API_KEY;
    this.fetch = fetchImpl;
    this.cache = new Map();
    if (!this.key) throw new Error('FINNHUB_API_KEY not set');
  }

  async earningsWithin(symbol, days, now = new Date()) {
    const ck = `${symbol}|${ymd(now)}|${days}`;
    if (this.cache.has(ck)) return this.cache.get(ck);
    const to = new Date(now.getTime() + days * 86400e3);
    const url = `https://finnhub.io/api/v1/calendar/earnings?from=${ymd(now)}&to=${ymd(to)}&symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(this.key)}`;
    const r = await this.fetch(url);
    if (!r.ok) throw new Error(`Finnhub ${r.status}`);
    const j = await r.json();
    if (!j || !Array.isArray(j.earningsCalendar)) throw new Error('Finnhub: unexpected reply');
    const next = j.earningsCalendar.map((e) => e.date).filter(Boolean).sort()[0] || null;
    this.cache.set(ck, next);
    return next;
  }
}

function createCalendar(env = process.env, fetchImpl = fetch) {
  return env.FINNHUB_API_KEY ? new FinnhubCalendar(env, fetchImpl) : null;
}

module.exports = { createCalendar, FinnhubCalendar };
