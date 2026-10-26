#!/usr/bin/env node
'use strict';
// Usage:
//   node scripts/backtest.js --csv ./prices --symbols SPY,QQQ,KO --strategy all
//   node scripts/backtest.js --years 5 --symbols SPY,QQQ,IWM      (uses Alpaca keys from .env or the environment)
//   node scripts/backtest.js --demo                                  (synthetic data, just to see the output)
const fs = require('fs');
const path = require('path');
const { backtestAll } = require('../server/backtest');
const { STRATEGIES } = require('../server/strategies');
const { CsvData, createData, DemoData } = require('../server/data');
const { DEFAULT_SETTINGS } = require('../server/store');

function loadDotEnv() {
  try {
    for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*([^#\r\n]*?)\s*(?:#.*)?$/);
      if (m && m[2] !== '' && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch { /* no .env */ }
}

function args() {
  const a = {};
  const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i++) {
    if (v[i].startsWith('--')) a[v[i].slice(2)] = v[i + 1] && !v[i + 1].startsWith('--') ? v[++i] : true;
  }
  return a;
}

const pct = (x, d = 1) => (x == null ? '-' : `${x.toFixed(d)}%`);

(async () => {
  loadDotEnv();
  const a = args();
  const years = Number(a.years || 5);
  let data;
  if (a.csv) data = new CsvData(a.csv);
  else if (a.demo) data = new DemoData();
  else data = createData(process.env);
  const symbols = String(a.symbols || DEFAULT_SETTINGS.watchlist.join(',')).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const strategies = !a.strategy || a.strategy === 'all' ? Object.keys(STRATEGIES) : String(a.strategy).split(',');
  const opts = { startingCash: Number(a.cash || 100), tradeDollars: Number(a.trade || 5), maxPositions: Number(a.positions || 4), slippagePct: Number(a.slippage ?? 0.05) };

  const { results, skipped } = await backtestAll({ data, symbols, years, strategies, benchmark: a.benchmark || 'SPY', opts });
  for (const [s, why] of Object.entries(skipped)) console.log(`skipped ${s}: ${why}`);
  for (const r of results) {
    console.log(`\n=== ${STRATEGIES[r.strategy].label} (${r.strategy}) ${r.period.from} to ${r.period.to} (${r.period.years}y), ${r.symbols.length} symbols ===`);
    console.log(`trades ${r.trades}   win rate ${r.winRate == null ? '-' : (r.winRate * 100).toFixed(0) + '%'}   avg trade ${pct(r.avgPct, 2)}   avg win ${pct(r.avgWinPct, 2)}   avg loss ${pct(r.avgLossPct, 2)}   profit factor ${r.profitFactor == null ? '-' : r.profitFactor.toFixed(2)}`);
    console.log(`account return ${pct(r.totalReturnPct)} (${pct(r.annualizedPct)}/yr)   max drawdown ${pct(r.maxDrawdownPct)}   avg capital deployed ${pct(r.avgCapitalDeployedPct, 0)}   worst losing streak ${r.worstLosingStreak}`);
    if (r.benchmark) console.log(`buy & hold ${a.benchmark || 'SPY'} same period: ${pct(r.benchmark.returnPct)}, max drawdown ${pct(r.benchmark.maxDrawdownPct)}`);
    const h = (x) => (x.trades ? `${x.trades} trades, avg ${pct(x.avgPct, 2)}, win ${(x.winRate * 100).toFixed(0)}%` : 'no trades');
    console.log(`first half: ${h(r.halves.firstHalf)}   |   second half: ${h(r.halves.secondHalf)}`);
    console.log('exits:', Object.entries(r.byReason).map(([k, v]) => `${k} ${v.trades}`).join(', ') || 'none');
  }
  if (a.json) fs.writeFileSync(a.json, JSON.stringify({ results, skipped }, null, 2));
  console.log('\nBacktests use only the symbols you gave them and past data. They flatter strategies more often than they hurt them.');
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
