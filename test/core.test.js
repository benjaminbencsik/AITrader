'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sma, rsiSeries, businessDaysBetween, isMarketOpen } = require('../server/indicators');
const { evaluate } = require('../server/strategy');
const { checkOrder } = require('../server/risk');
const { parseDecision } = require('../server/ai');
const { DEFAULT_SETTINGS } = require('../server/store');
const { barsFromCloses, pullbackCloses, downtrendCloses } = require('./helpers');

test('sma averages the last n values', () => {
  assert.equal(sma([1, 2, 3, 4, 5], 3), 4);
  assert.equal(sma([1, 2], 3), null);
});

test('RSI matches the known Wilder reference series', () => {
  // Classic textbook series (Wilder / StockCharts RSI worked example); first RSI(14) is about 70.46.
  const closes = [
    44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4245, 45.8433, 46.0826, 45.8931, 46.0328, 45.614, 46.282, 46.282,
    46.0028, 46.0328, 46.4116, 46.2222, 45.6439, 46.2122, 46.2521, 45.7137, 46.4515, 45.7835, 45.3548, 44.0288, 44.1783, 44.2181, 44.5672,
  ];
  const r = rsiSeries(closes, 14);
  assert.ok(Math.abs(r[14] - 70.46) < 0.1, `got ${r[14]}`);
  assert.ok(Math.abs(r[15] - 66.25) < 0.2, `got ${r[15]}`);
  assert.equal(r[3], null);
});

test('RSI is 100 when price only rises', () => {
  const r = rsiSeries(Array.from({ length: 30 }, (_, i) => 10 + i), 14);
  assert.equal(r[29], 100);
});

test('businessDaysBetween skips weekends', () => {
  // Mon 2026-10-19 -> Mon 2026-10-26 is 5 business days
  assert.equal(businessDaysBetween('2026-10-19T15:00:00Z', '2026-10-26T15:00:00Z'), 5);
  // Fri -> Mon is 1
  assert.equal(businessDaysBetween('2026-10-23T15:00:00Z', '2026-10-26T15:00:00Z'), 1);
});

test('market hours are New York 9:30-16:00 on weekdays', () => {
  assert.equal(isMarketOpen(new Date('2026-10-26T14:00:00Z')), true); // Mon 10:00 ET
  assert.equal(isMarketOpen(new Date('2026-10-26T13:00:00Z')), false); // 9:00 ET
  assert.equal(isMarketOpen(new Date('2026-10-26T20:30:00Z')), false); // 16:30 ET
  assert.equal(isMarketOpen(new Date('2026-10-24T15:00:00Z')), false); // Saturday
});

test('strategy passes an uptrend pullback and sets exits', () => {
  const ev = evaluate(barsFromCloses(pullbackCloses()));
  assert.equal(ev.pass, true, ev.reasons.join('; ') + JSON.stringify(ev.metrics));
  assert.ok(ev.target > ev.entry && ev.stop < ev.entry);
  assert.ok(Math.abs(ev.target / ev.entry - 1.03) < 1e-3);
});

test('strategy rejects a downtrend and short history', () => {
  assert.equal(evaluate(barsFromCloses(downtrendCloses())).pass, false);
  const short = evaluate(barsFromCloses(pullbackCloses().slice(-100)));
  assert.equal(short.pass, false);
  assert.match(short.reasons[0], /205/);
});

const baseCtx = (over = {}) => ({
  settings: { ...DEFAULT_SETTINGS },
  account: { cash: 20, equity: 20 },
  positions: [],
  trades: [],
  mode: 'paper',
  now: new Date('2026-10-26T15:00:00Z'),
  ...over,
});
const buy = (over = {}) => ({ symbol: 'SPY', side: 'buy', dollars: 5, price: 100, ...over });

test('risk: allows a normal small buy', () => {
  assert.equal(checkOrder(buy(), baseCtx()).ok, true);
});

test('risk: blocks when paused, penny price, no cash, too big, duplicates, max positions', () => {
  const ctx = baseCtx();
  assert.equal(checkOrder(buy(), baseCtx({ settings: { ...ctx.settings, paused: true } })).ok, false);
  assert.equal(checkOrder(buy({ price: 2 }), ctx).ok, false);
  assert.equal(checkOrder(buy({ dollars: 5 }), baseCtx({ account: { cash: 3, equity: 20 } })).ok, false);
  assert.equal(checkOrder(buy({ dollars: 6 }), ctx).ok, false); // above tradeDollars (5)
  assert.equal(checkOrder(buy(), baseCtx({ positions: [{ symbol: 'SPY', marketValue: 5 }] })).ok, false);
  const four = ['A', 'B', 'C', 'D'].map((symbol) => ({ symbol, marketValue: 5 }));
  assert.equal(checkOrder(buy(), baseCtx({ positions: four })).ok, false);
});

test('risk: concentration, trades per day, and daily loss limit', () => {
  const s = { ...DEFAULT_SETTINGS, tradeDollars: 50, maxPositionPct: 40 };
  assert.equal(checkOrder(buy({ dollars: 20 }), baseCtx({ settings: s, account: { cash: 100, equity: 100 } })).ok, true);
  assert.equal(checkOrder(buy({ dollars: 50 }), baseCtx({ settings: s, account: { cash: 100, equity: 100 } })).ok, false);

  const today = '2026-10-26T14:00:00Z';
  const many = Array.from({ length: 6 }, (_, i) => ({ mode: 'paper', entryAt: today, status: 'open', symbol: 'X' + i }));
  assert.equal(checkOrder(buy(), baseCtx({ trades: many })).ok, false);

  const loss = [{ mode: 'paper', status: 'closed', entryAt: '2026-10-22T14:00:00Z', exitAt: today, pnl: -3 }];
  const r = checkOrder(buy(), baseCtx({ trades: loss, account: { cash: 20, equity: 20 } }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /daily loss/);
});

test('risk: sells are always allowed, even when paused', () => {
  const ctx = baseCtx({ settings: { ...DEFAULT_SETTINGS, paused: true } });
  assert.equal(checkOrder({ symbol: 'SPY', side: 'sell', dollars: 5, price: 100 }, ctx).ok, true);
});

test('AI reply parsing accepts JSON and rejects junk', () => {
  const ok = parseDecision('Sure: {"decision":"reject","confidence":0.7,"reasoning":"weak","risks":["a"]}');
  assert.equal(ok.decision, 'reject');
  assert.throws(() => parseDecision('no json here'));
  assert.throws(() => parseDecision('{"decision":"maybe"}'));
});
