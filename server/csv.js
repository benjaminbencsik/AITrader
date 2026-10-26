'use strict';
// Parses daily price CSVs (Yahoo Finance "Historical Data" download, Stooq, or any file with date/open/high/low/close columns).
// If an "Adj Close" column exists, open/high/low are scaled by adjClose/close so splits and dividends don't create fake gaps.

function splitLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === ',' && !q) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function parseBarsCsv(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) throw new Error('CSV has no data rows');
  const head = splitLine(lines[0]).map((h) => h.toLowerCase());
  const col = (...names) => head.findIndex((h) => names.includes(h));
  const iDate = col('date', 'time', 'timestamp');
  const iO = col('open');
  const iH = col('high');
  const iL = col('low');
  const iC = col('close', 'close/last');
  const iAdj = col('adj close', 'adj_close', 'adjusted close');
  const iV = col('volume');
  if ([iDate, iO, iH, iL, iC].some((i) => i < 0)) throw new Error('CSV needs Date, Open, High, Low and Close columns');
  const num = (s) => Number(String(s).replace(/[$,]/g, ''));

  const bars = [];
  for (let i = 1; i < lines.length; i++) {
    const f = splitLine(lines[i]);
    const t = new Date(f[iDate]);
    const o = num(f[iO]);
    const h = num(f[iH]);
    const l = num(f[iL]);
    const c = num(f[iC]);
    if (isNaN(t) || [o, h, l, c].some((x) => !(x > 0))) continue; // skips "null" rows and junk
    let k = 1;
    if (iAdj >= 0) {
      const adj = num(f[iAdj]);
      if (adj > 0) k = adj / c;
    }
    bars.push({ t: t.toISOString(), o: o * k, h: h * k, l: l * k, c: c * k, v: iV >= 0 ? num(f[iV]) || 0 : 0 });
  }
  bars.sort((a, b) => (a.t < b.t ? -1 : 1));
  const dedup = bars.filter((b, i) => i === 0 || b.t !== bars[i - 1].t);
  if (dedup.length < 2) throw new Error('no usable rows in CSV');
  return dedup;
}

const { tradesToCsv } = require('../public/shared');

module.exports = { parseBarsCsv, tradesToCsv };
