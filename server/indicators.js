'use strict';
// Plain indicator math. No dependencies.

function sma(values, n) {
  if (values.length < n) return null;
  let s = 0;
  for (let i = values.length - n; i < values.length; i++) s += values[i];
  return s / n;
}

// Wilder's RSI. Returns an array the same length as `closes`; early entries are null.
function rsiSeries(closes, n = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= n) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / n;
  let avgLoss = loss / n;
  out[n] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (n - 1) + Math.max(d, 0)) / n;
    avgLoss = (avgLoss * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

// Count weekdays after `from` up to and including `to` (no holiday calendar).
function businessDaysBetween(from, to) {
  const a = new Date(from);
  const b = new Date(to);
  a.setUTCHours(0, 0, 0, 0);
  b.setUTCHours(0, 0, 0, 0);
  let n = 0;
  for (const d = new Date(a); d < b; ) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) n++;
  }
  return n;
}

// NYSE calendar, computed (no table to go stale). Full closures: New Year's, MLK, Presidents, Good Friday,
// Memorial, Juneteenth, Independence, Labor, Thanksgiving, Christmas (weekend holidays move to the nearest weekday,
// except a Saturday New Year's, which NYSE does not observe). Early 1pm closes: day after Thanksgiving, Dec 24, Jul 3.
function nthWeekday(y, m, wd, n) { // m 0-11; n>0 = nth, n=-1 = last
  if (n > 0) {
    const first = new Date(Date.UTC(y, m, 1)).getUTCDay();
    return 1 + ((wd - first + 7) % 7) + (n - 1) * 7;
  }
  const last = new Date(Date.UTC(y, m + 1, 0));
  return last.getUTCDate() - ((last.getUTCDay() - wd + 7) % 7);
}
function easter(y) { // anonymous Gregorian algorithm -> [month0, day]
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mo = Math.floor((h + l - 7 * m + 114) / 31), da = ((h + l - 7 * m + 114) % 31) + 1;
  return [mo - 1, da];
}
const ymd = (d) => d.toISOString().slice(0, 10);
const holidayCache = new Map();
function nyseHolidays(y) {
  if (holidayCache.has(y)) return holidayCache.get(y);
  const set = new Map();
  const U = (m, d) => new Date(Date.UTC(y, m, d));
  const observe = (m, d, name, skipSat) => {
    const dt = U(m, d), wd = dt.getUTCDay();
    if (wd === 6) { if (!skipSat) set.set(ymd(U(m, d - 1)), name); } else if (wd === 0) set.set(ymd(U(m, d + 1)), name);
    else set.set(ymd(dt), name);
  };
  observe(0, 1, "New Year's Day", true);
  set.set(ymd(U(0, nthWeekday(y, 0, 1, 3))), 'Martin Luther King Jr. Day');
  set.set(ymd(U(1, nthWeekday(y, 1, 1, 3))), "Presidents' Day");
  const [em, ed] = easter(y);
  set.set(ymd(U(em, ed - 2)), 'Good Friday');
  set.set(ymd(U(4, nthWeekday(y, 4, 1, -1))), 'Memorial Day');
  if (y >= 2022) observe(5, 19, 'Juneteenth');
  observe(6, 4, 'Independence Day');
  set.set(ymd(U(8, nthWeekday(y, 8, 1, 1))), 'Labor Day');
  set.set(ymd(U(10, nthWeekday(y, 10, 4, 4))), 'Thanksgiving');
  observe(11, 25, 'Christmas');
  holidayCache.set(y, set);
  return set;
}
function earlyCloses(y) {
  const out = new Set();
  const hol = nyseHolidays(y);
  const add = (dt) => { const wd = dt.getUTCDay(); if (wd !== 0 && wd !== 6 && !hol.has(ymd(dt))) out.add(ymd(dt)); };
  add(new Date(Date.UTC(y, 10, nthWeekday(y, 10, 4, 4) + 1)));
  add(new Date(Date.UTC(y, 11, 24)));
  const j4 = new Date(Date.UTC(y, 6, 4)).getUTCDay();
  if (j4 !== 0 && j4 !== 6) add(new Date(Date.UTC(y, 6, 3)));
  return out;
}
function nyParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(date);
  const g = (t) => parts.find((p) => p.type === t).value;
  return { y: Number(g('year')), key: `${g('year')}-${g('month')}-${g('day')}`, wd: g('weekday'), mins: (Number(g('hour')) % 24) * 60 + Number(g('minute')) };
}
// Returns the holiday name when the NY date is a full closure, else null.
function marketHoliday(date = new Date()) {
  const p = nyParts(date);
  return nyseHolidays(p.y).get(p.key) || null;
}
// US regular session: 9:30-16:00 New York time (13:00 on early-close days), weekdays, not a holiday.
function isMarketOpen(date = new Date()) {
  const p = nyParts(date);
  if (p.wd === 'Sat' || p.wd === 'Sun') return false;
  if (nyseHolidays(p.y).has(p.key)) return false;
  const close = earlyCloses(p.y).has(p.key) ? 13 * 60 : 16 * 60;
  return p.mins >= 9 * 60 + 30 && p.mins < close;
}

// Crypto trades every day, so time stops count calendar days.
function calendarDaysBetween(a, b) {
  return Math.floor((new Date(b) - new Date(a)) / 86400e3);
}

module.exports = { sma, rsiSeries, businessDaysBetween, calendarDaysBetween, isMarketOpen, marketHoliday, nyseHolidays };
