'use strict';
const { STRATEGIES } = require('./strategies');
const { businessDaysBetween, calendarDaysBetween } = require('./indicators');

// Replays a strategy over history with conservative assumptions:
//  - A signal appears at a day's CLOSE; the buy happens at the NEXT day's OPEN (plus slippage).
//  - Exits are checked against each day's high/low. If a day touches both stop and target, the STOP is assumed to hit first.
//  - If a day opens beyond the stop or target (a gap), the fill is at the open, not the level.
//  - Time stop sells at the close. Slippage is charged on both sides. No fees (US stocks/ETFs are commission-free).
// What it can NOT do: it uses only the symbols you give it (survivorship bias), and past results don't predict the future.

const day = (b) => b.t.slice(0, 10);

function runBacktest({ strategyId, params, barsBySymbol, benchmarkBars, opts = {} }) {
  const strat = STRATEGIES[strategyId];
  if (!strat) throw new Error(`unknown strategy ${strategyId}`);
  const o = { startingCash: 100, tradeDollars: 5, maxPositions: 4, slippagePct: 0.05, ...opts };
  const p = { ...strat.defaults, ...(params || {}) };
  const symbols = Object.keys(barsBySymbol).filter((s) => barsBySymbol[s].length >= 210);
  if (!symbols.length) throw new Error('need at least one symbol with 210+ daily bars');

  const idx = {};
  const dateSet = new Set();
  for (const s of symbols) {
    idx[s] = new Map(barsBySymbol[s].map((b, i) => [day(b), i]));
    for (const b of barsBySymbol[s].slice(200)) dateSet.add(day(b));
  }
  const dates = [...dateSet].sort();

  const daysBetween = o.calendarDays ? calendarDaysBetween : businessDaysBetween;
  const slip = o.slippagePct / 100;
  let cash = o.startingCash;
  const open = []; // {symbol, qty, entryPx, entryDate, entryIdx, target, stop, timeStopDays, dollars}
  const closed = [];
  let pending = []; // signals to buy at next open
  const curve = [];
  let deployedSum = 0;

  for (const d of dates) {
    // 1) fill pending entries at today's open
    for (const sig of pending) {
      const i = idx[sig.symbol].get(d);
      if (i == null || open.length >= o.maxPositions || cash < o.tradeDollars) continue;
      if (open.some((x) => x.symbol === sig.symbol)) continue;
      const bar = barsBySymbol[sig.symbol][i];
      const px = bar.o * (1 + slip);
      cash -= o.tradeDollars;
      // exits are re-based on the actual fill so a gap-up open doesn't shrink the reward or risk
      open.push({
        symbol: sig.symbol, qty: o.tradeDollars / px, entryPx: px, entryDate: d, entryIdx: i, dollars: o.tradeDollars,
        target: px * (1 + p.targetPct / 100), stop: px * (1 - p.stopPct / 100), timeStopDays: p.timeStopDays,
      });
    }
    pending = [];

    // 2) exits
    for (let k = open.length - 1; k >= 0; k--) {
      const t = open[k];
      const i = idx[t.symbol].get(d);
      if (i == null) continue;
      const bar = barsBySymbol[t.symbol][i];
      const sameDay = t.entryDate === d;
      let px = null;
      let reason = null;
      if (!sameDay && bar.o <= t.stop) { px = bar.o; reason = 'stop'; }
      else if (bar.l <= t.stop) { px = t.stop; reason = 'stop'; }
      else if (!sameDay && bar.o >= t.target) { px = bar.o; reason = 'target'; }
      else if (bar.h >= t.target) { px = t.target; reason = 'target'; }
      else if (daysBetween(t.entryDate, d) >= t.timeStopDays) { px = bar.c; reason = 'time stop'; }
      if (px == null) continue;
      const exitPx = px * (1 - slip);
      const proceeds = t.qty * exitPx;
      cash += proceeds;
      closed.push({
        symbol: t.symbol, entryDate: t.entryDate, exitDate: d, entryPx: t.entryPx, exitPx, reason,
        pnl: proceeds - t.dollars, pnlPct: (exitPx / t.entryPx - 1) * 100,
        daysHeld: daysBetween(t.entryDate, d),
      });
      open.splice(k, 1);
    }

    // 3) mark to market
    let mv = 0;
    for (const t of open) {
      const i = idx[t.symbol].get(d);
      const bar = i != null ? barsBySymbol[t.symbol][i] : null;
      mv += t.qty * (bar ? bar.c : t.entryPx);
    }
    curve.push({ d, equity: cash + mv });
    deployedSum += mv / (cash + mv);

    // 4) look for signals at today's close, to buy tomorrow
    const room = o.maxPositions - open.length;
    if (room > 0 && cash >= o.tradeDollars) {
      const cands = [];
      for (const s of symbols) {
        const i = idx[s].get(d);
        if (i == null || i < 205 || open.some((x) => x.symbol === s)) continue;
        const ev = strat.evaluate(barsBySymbol[s].slice(Math.max(0, i - 259), i + 1), p);
        if (ev.pass) cands.push({ symbol: s, rsi: ev.metrics.rsi });
      }
      cands.sort((a, b) => Math.abs(a.rsi - 45) - Math.abs(b.rsi - 45));
      pending = cands.slice(0, Math.min(room, Math.floor(cash / o.tradeDollars)));
    }
  }

  return summarize({ strategyId, params: p, opts: o, closed, curve, dates, deployedAvg: deployedSum / dates.length, openLeft: open.length, benchmarkBars, symbols });
}

function drawdown(values) {
  let peak = -Infinity;
  let worst = 0;
  for (const v of values) {
    peak = Math.max(peak, v);
    worst = Math.min(worst, v / peak - 1);
  }
  return worst * 100;
}

function stats(trades) {
  const n = trades.length;
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossW = wins.reduce((a, t) => a + t.pnl, 0);
  const grossL = -losses.reduce((a, t) => a + t.pnl, 0);
  return {
    trades: n,
    winRate: n ? wins.length / n : null,
    avgPct: n ? trades.reduce((a, t) => a + t.pnlPct, 0) / n : null,
    avgWinPct: wins.length ? wins.reduce((a, t) => a + t.pnlPct, 0) / wins.length : null,
    avgLossPct: losses.length ? losses.reduce((a, t) => a + t.pnlPct, 0) / losses.length : null,
    profitFactor: grossL > 0 ? grossW / grossL : n && grossW > 0 ? Infinity : null,
    totalPnl: trades.reduce((a, t) => a + t.pnl, 0),
  };
}

function summarize({ strategyId, params, opts, closed, curve, dates, deployedAvg, openLeft, benchmarkBars, symbols }) {
  const startEq = opts.startingCash;
  const endEq = curve.length ? curve[curve.length - 1].equity : startEq;
  const years = Math.max(0.01, (new Date(dates[dates.length - 1]) - new Date(dates[0])) / (365.25 * 86400e3));

  let streak = 0;
  let worstStreak = 0;
  for (const t of closed.slice().sort((a, b) => (a.exitDate < b.exitDate ? -1 : 1))) {
    streak = t.pnl <= 0 ? streak + 1 : 0;
    worstStreak = Math.max(worstStreak, streak);
  }

  const bySymbol = {};
  const byReason = {};
  for (const t of closed) {
    (bySymbol[t.symbol] = bySymbol[t.symbol] || []).push(t);
    (byReason[t.reason] = byReason[t.reason] || []).push(t);
  }
  const brief = (groups) => Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, { trades: v.length, pnl: v.reduce((a, t) => a + t.pnl, 0), winRate: v.filter((t) => t.pnl > 0).length / v.length }]));

  // Out-of-sample sanity check: do the first and second half of the period tell the same story?
  const mid = dates[Math.floor(dates.length / 2)];
  const halves = { firstHalf: stats(closed.filter((t) => t.exitDate < mid)), secondHalf: stats(closed.filter((t) => t.exitDate >= mid)) };

  let benchmark = null;
  if (benchmarkBars && benchmarkBars.length) {
    const inRange = benchmarkBars.filter((b) => day(b) >= dates[0] && day(b) <= dates[dates.length - 1]);
    if (inRange.length > 1) {
      benchmark = {
        returnPct: (inRange[inRange.length - 1].c / inRange[0].c - 1) * 100,
        maxDrawdownPct: drawdown(inRange.map((b) => b.c)),
      };
    }
  }

  const sampled = curve.length > 300 ? curve.filter((_, i) => i % Math.ceil(curve.length / 300) === 0 || i === curve.length - 1) : curve;
  return {
    strategy: strategyId,
    params,
    settings: opts,
    symbols,
    period: { from: dates[0], to: dates[dates.length - 1], years: Number(years.toFixed(2)) },
    ...stats(closed),
    totalReturnPct: (endEq / startEq - 1) * 100,
    annualizedPct: (Math.pow(endEq / startEq, 1 / years) - 1) * 100,
    maxDrawdownPct: drawdown(curve.map((c) => c.equity)),
    avgCapitalDeployedPct: deployedAvg * 100,
    avgDaysHeld: closed.length ? closed.reduce((a, t) => a + t.daysHeld, 0) / closed.length : null,
    worstLosingStreak: worstStreak,
    stillOpenAtEnd: openLeft,
    byReason: brief(byReason),
    bySymbol: brief(bySymbol),
    halves,
    benchmark,
    curve: sampled,
    tradesList: closed.slice(-200),
  };
}

// Loads history for each symbol (skipping ones that fail) and runs one or all strategies.
async function backtestAll({ data, symbols, years, strategies, benchmark = 'SPY', params = {}, opts = {} }) {
  const barsBySymbol = {};
  const skipped = {};
  for (const s of symbols) {
    try {
      barsBySymbol[s] = await data.getHistory(s, years);
    } catch (e) {
      skipped[s] = e.message;
    }
  }
  let benchmarkBars = null;
  try {
    benchmarkBars = barsBySymbol[benchmark] || (await data.getHistory(benchmark, years));
  } catch {
    /* benchmark is optional */
  }
  const results = strategies.map((id) => runBacktest({ strategyId: id, params: params[id], barsBySymbol, benchmarkBars, opts }));
  return { results, skipped };
}

module.exports = { runBacktest, backtestAll };
