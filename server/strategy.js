'use strict';
const { sma, rsiSeries } = require('./indicators');

// Rules-based "uptrend pullback" setup. Deterministic; the AI layer can only veto what passes here.
//   1. Trend:    50-day SMA above 200-day SMA, and price above the 200-day SMA
//   2. Pullback: RSI(14) between rsiMin and rsiMax and rising two sessions in a row
//   3. Not broken: price no more than 3% below the 20-day SMA
// Exits (target / stop / time stop) are attached to the signal and enforced by the engine.
const DEFAULTS = { rsiMin: 35, rsiMax: 52, targetPct: 3, stopPct: 3, timeStopDays: 5 };

function evaluate(bars, cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const closes = bars.map((b) => b.c);
  const reasons = [];
  if (closes.length < 205) {
    return { pass: false, reasons: [`needs 205+ daily bars, have ${closes.length}`], metrics: null };
  }
  const close = closes[closes.length - 1];
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);
  const rsi = rsiSeries(closes, 14);
  const r0 = rsi[rsi.length - 1];
  const r1 = rsi[rsi.length - 2];
  const r2 = rsi[rsi.length - 3];
  const metrics = { close, sma20, sma50, sma200, rsi: r0, rsiPrev: r1, rsiPrev2: r2 };

  if (!(sma50 > sma200)) reasons.push('50-day SMA is not above 200-day SMA');
  if (!(close > sma200)) reasons.push('price is not above 200-day SMA');
  if (!(r0 >= c.rsiMin && r0 <= c.rsiMax)) reasons.push(`RSI ${r0 && r0.toFixed(1)} outside ${c.rsiMin}-${c.rsiMax}`);
  if (!(r0 > r1 && r1 > r2)) reasons.push('RSI is not rising two sessions in a row');
  if (!(close >= sma20 * 0.97)) reasons.push('price more than 3% below 20-day SMA');

  const pass = reasons.length === 0;
  return {
    pass,
    reasons,
    metrics,
    entry: close,
    target: round(close * (1 + c.targetPct / 100)),
    stop: round(close * (1 - c.stopPct / 100)),
    timeStopDays: c.timeStopDays,
  };
}

function round(x) {
  return Math.round(x * 10000) / 10000;
}

module.exports = { evaluate, DEFAULTS };
