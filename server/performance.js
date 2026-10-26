'use strict';
// Numbers behind the Performance screen: equity curve vs buy-and-hold SPY, and results grouped by strategy / symbol / exit reason.

function group(trades, keyFn) {
  const out = {};
  for (const t of trades) {
    const k = keyFn(t) || 'unknown';
    const g = (out[k] = out[k] || { trades: 0, wins: 0, pnl: 0, pctSum: 0 });
    g.trades += 1;
    if (t.pnl > 0) g.wins += 1;
    g.pnl += t.pnl || 0;
    g.pctSum += t.pnlPct || 0;
  }
  return Object.entries(out)
    .map(([key, g]) => ({ key, trades: g.trades, winRate: g.wins / g.trades, pnl: g.pnl, avgPct: g.pctSum / g.trades }))
    .sort((a, b) => b.pnl - a.pnl);
}

async function buildPerformance({ store, data, mode, benchmark = 'SPY', assetClass = 'stocks' }) {
  const mine = (x) => (x.assetClass || 'stocks') === assetClass;
  const closed = store.state.trades.filter((t) => t.mode === mode && t.status === 'closed' && mine(t));
  const snaps = store.state.equity.filter((e) => e.mode === mode && mine(e));
  const step = Math.max(1, Math.ceil(snaps.length / 300));
  const curve = snaps.filter((_, i) => i % step === 0 || i === snaps.length - 1).map((e) => ({ t: e.t, equity: e.equity }));

  let spy = null;
  if (curve.length >= 2 && data.getHistory) {
    try {
      const bars = await data.getHistory(benchmark, 1);
      const day = (iso) => iso.slice(0, 10);
      const at = (iso) => {
        let last = null;
        for (const b of bars) {
          if (day(b.t) <= day(iso)) last = b;
          else break;
        }
        return last && last.c;
      };
      const base = at(curve[0].t);
      if (base) spy = curve.map((p) => ({ t: p.t, equity: curve[0].equity * (at(p.t) / base) }));
    } catch {
      spy = null;
    }
  }

  return {
    mode,
    assetClass,
    benchmark,
    curve,
    spy,
    note: mode === 'live' ? 'Live equity includes any money you deposit or withdraw, so a deposit looks like a gain here.' : null,
    totals: {
      closed: closed.length,
      pnl: closed.reduce((a, t) => a + (t.pnl || 0), 0),
      winRate: closed.length ? closed.filter((t) => t.pnl > 0).length / closed.length : null,
    },
    byStrategy: group(closed, (t) => t.strategy || 'pullback'),
    bySymbol: group(closed, (t) => t.symbol),
    byReason: group(closed, (t) => t.exitReason),
  };
}

module.exports = { buildPerformance };
