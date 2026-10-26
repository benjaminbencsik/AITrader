'use strict';
const { sma, rsiSeries } = require('./indicators');
const pullback = require('./strategy');

// Every strategy has the same shape so the live engine and the backtester can run any of them:
//   evaluate(bars, params) -> { pass, reasons, metrics, entry, target, stop, timeStopDays }
const round = (x) => Math.round(x * 10000) / 10000;

function exits(close, p) {
  return { entry: close, target: round(close * (1 + p.targetPct / 100)), stop: round(close * (1 - p.stopPct / 100)), timeStopDays: p.timeStopDays };
}

// 2) Breakout: close above the prior 20-day high while in an uptrend, not already overheated.
const BREAKOUT = { lookback: 20, rsiMax: 80, targetPct: 6, stopPct: 3, timeStopDays: 10 };
function breakout(bars, cfg = {}) {
  const p = { ...BREAKOUT, ...cfg };
  if (bars.length < 205) return { pass: false, reasons: [`needs 205+ daily bars, have ${bars.length}`], metrics: null };
  const closes = bars.map((b) => b.c);
  const close = closes[closes.length - 1];
  const priorHigh = Math.max(...bars.slice(-1 - p.lookback, -1).map((b) => b.h));
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);
  const rsiNow = rsiSeries(closes, 14).slice(-1)[0];
  const reasons = [];
  if (!(close > priorHigh)) reasons.push(`close not above prior ${p.lookback}-day high`);
  if (!(sma50 > sma200)) reasons.push('50-day SMA is not above 200-day SMA');
  if (!(close > sma50)) reasons.push('price is not above 50-day SMA');
  if (!(rsiNow < p.rsiMax)) reasons.push(`RSI ${rsiNow && rsiNow.toFixed(1)} too hot (max ${p.rsiMax})`);
  return { pass: reasons.length === 0, reasons, metrics: { close, sma20: sma(closes, 20), sma50, sma200, rsi: rsiNow, rsiPrev: null, rsiPrev2: null, priorHigh }, ...exits(close, p) };
}

// 3) Mean reversion (Connors-style): very short-term oversold inside a long-term uptrend.
const MEANREV = { rsiPeriod: 2, rsiMax: 10, targetPct: 2.5, stopPct: 4, timeStopDays: 4 };
function meanrev(bars, cfg = {}) {
  const p = { ...MEANREV, ...cfg };
  if (bars.length < 205) return { pass: false, reasons: [`needs 205+ daily bars, have ${bars.length}`], metrics: null };
  const closes = bars.map((b) => b.c);
  const close = closes[closes.length - 1];
  const sma5 = sma(closes, 5);
  const sma200 = sma(closes, 200);
  const rsiNow = rsiSeries(closes, p.rsiPeriod).slice(-1)[0];
  const reasons = [];
  if (!(close > sma200)) reasons.push('price is not above 200-day SMA');
  if (!(rsiNow < p.rsiMax)) reasons.push(`RSI(${p.rsiPeriod}) ${rsiNow && rsiNow.toFixed(1)} not below ${p.rsiMax}`);
  if (!(close < sma5)) reasons.push('price is not below 5-day SMA');
  return { pass: reasons.length === 0, reasons, metrics: { close, sma20: sma(closes, 20), sma50: sma(closes, 50), sma200, rsi: rsiNow, rsiPrev: null, rsiPrev2: null }, ...exits(close, p) };
}

const STRATEGIES = {
  pullback: { id: 'pullback', label: 'Uptrend pullback', defaults: pullback.DEFAULTS, evaluate: pullback.evaluate },
  breakout: { id: 'breakout', label: '20-day breakout', defaults: BREAKOUT, evaluate: breakout },
  meanrev: { id: 'meanrev', label: 'Short-term mean reversion', defaults: MEANREV, evaluate: meanrev },
};

// Parameters for a strategy given the settings object (pullback params live in settings.strategy for backward compatibility).
function paramsFor(id, settings, assetClass = 'stocks') {
  if (assetClass === 'crypto') return { ...STRATEGIES[id].defaults, ...((settings.cryptoParams || {})[id] || {}) };
  if (id === 'pullback') return { ...STRATEGIES.pullback.defaults, ...(settings.strategy || {}) };
  return { ...STRATEGIES[id].defaults, ...((settings.strategyParams || {})[id] || {}) };
}

module.exports = { STRATEGIES, paramsFor };
