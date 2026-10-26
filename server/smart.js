'use strict';
// Smart mode: you choose how much risk you accept; the app turns that into position sizes and limits from what the account actually holds.
//
// Sizing is risk-based. Each trade risks a fixed slice of the managed money: dollars = (equity x risk%) / (distance to the stop),
// capped by a share of the account. A tighter stop therefore allows a bigger position, and a wider stop a smaller one.
// "Managed money" is the whole account, or a budget you set, so the app can leave your long-term holdings alone.

const PROFILES = {
  cautious: {
    label: 'Cautious',
    note: 'Small positions, few at once, stops early on a bad day.',
    riskPerTradePct: 0.5, maxPositionPct: 15, maxPositions: 3, dailyLossLimitPct: 2, drawdownPausePct: 10, strategies: ['pullback'],
  },
  balanced: {
    label: 'Balanced',
    note: 'Moderate positions, a few at once, two strategies.',
    riskPerTradePct: 1, maxPositionPct: 25, maxPositions: 4, dailyLossLimitPct: 4, drawdownPausePct: 15, strategies: ['pullback', 'meanrev'],
  },
  aggressive: {
    label: 'Aggressive',
    note: 'Bigger positions, more at once, all strategies. Expect bigger swings.',
    riskPerTradePct: 2, maxPositionPct: 35, maxPositions: 5, dailyLossLimitPct: 8, drawdownPausePct: 25, strategies: ['pullback', 'meanrev', 'breakout'],
  },
};
const CRYPTO_RISK_SCALE = 0.5; // crypto swings harder, so it risks half as much per trade at the same level

function profileFor(level) {
  return PROFILES[level] || PROFILES.balanced;
}

// What smart mode manages: the whole account, or the budget if one is set (0 = whole account).
function managedMoney(settings, cls, equity) {
  const budget = Number(cls === 'crypto' ? settings.smartBudgetCrypto : settings.smartBudgetStocks) || 0;
  return budget > 0 ? Math.min(equity, budget) : equity;
}

// Effective limits for one asset class. The result replaces the manual size and limit settings while smart mode is on.
function smartLimits(settings, cls, equity) {
  const p = profileFor(settings.riskLevel);
  const managed = managedMoney(settings, cls, equity);
  const riskPct = p.riskPerTradePct * (cls === 'crypto' ? CRYPTO_RISK_SCALE : 1);
  return {
    managed,
    riskPct,
    riskDollars: (managed * riskPct) / 100,
    maxPositionDollars: (managed * p.maxPositionPct) / 100,
    maxPositionPct: p.maxPositionPct,
    maxPositions: p.maxPositions,
    dailyLossLimitPct: p.dailyLossLimitPct,
    drawdownPausePct: p.drawdownPausePct,
    strategies: p.strategies,
  };
}

// Dollars for one trade given how far away its stop is. Returns 0 when the account is too small to take it.
function smartTradeDollars(limits, entry, stop, { cash = Infinity, liveCap = Infinity, minTrade = 1 } = {}) {
  const stopFrac = (entry - stop) / entry;
  if (!(stopFrac > 0)) return 0;
  let d = Math.min(limits.riskDollars / stopFrac, limits.maxPositionDollars, cash, liveCap);
  d = Math.floor(d * 100) / 100;
  return d >= minTrade ? d : 0;
}

// A plain-English summary for the dashboard, using a typical 3% stop.
function smartPlan(settings, cls, equity, { liveCap = Infinity } = {}) {
  const l = smartLimits(settings, cls, equity);
  const typical = smartTradeDollars(l, 100, 97, { liveCap, minTrade: 0 });
  return {
    managed: l.managed,
    riskPerTradeDollars: l.riskDollars,
    typicalTradeDollars: typical,
    maxPositions: l.maxPositions,
    maxPositionPct: l.maxPositionPct,
    dailyLossLimitPct: l.dailyLossLimitPct,
    drawdownPausePct: l.drawdownPausePct,
    strategies: l.strategies,
    cappedByLiveLimit: Number.isFinite(liveCap) && typical >= liveCap,
  };
}

module.exports = { PROFILES, profileFor, managedMoney, smartLimits, smartTradeDollars, smartPlan };
