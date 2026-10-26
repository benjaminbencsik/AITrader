'use strict';
// Hard risk rules. These run in code, before and after any AI opinion, and cannot be overridden by it.

function startOfTodayNY(now = new Date()) {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now);
  return ymd; // YYYY-MM-DD in New York
}

function nyDay(iso) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(iso));
}

// proposal: { symbol, side:'buy'|'sell', dollars, price }
// ctx: { settings, account:{equity,cash}, positions:[{symbol,marketValue}], trades:[...], now }
function checkOrder(proposal, ctx) {
  const s = ctx.settings;
  const now = ctx.now || new Date();
  const today = startOfTodayNY(now);

  if (proposal.side === 'sell') return ok(); // exits are always allowed, even when paused
  if (s.paused) return fail('new trades are paused');

  if ((s.blocklist || []).includes(proposal.symbol)) return fail(`${proposal.symbol} is on the blocklist`);
  if (ctx.assetClass !== 'crypto' && proposal.price < s.minPrice) return fail(`price $${proposal.price} below minimum $${s.minPrice}`);
  if (proposal.dollars < s.minTradeDollars) return fail(`$${proposal.dollars} below minimum trade size`);
  if (proposal.dollars > s.tradeDollars + 1e-9) return fail(`$${proposal.dollars} above per-trade size $${s.tradeDollars}`);
  if (proposal.dollars > ctx.account.cash + 1e-9) return fail(`not enough cash ($${ctx.account.cash.toFixed(2)})`);

  const held = ctx.positions.find((p) => p.symbol === proposal.symbol);
  if (held) return fail(`already holding ${proposal.symbol}`);
  if (ctx.positions.length >= s.maxPositions) return fail(`already at max ${s.maxPositions} positions`);

  const posValue = proposal.dollars;
  if (ctx.account.equity > 0 && (posValue / ctx.account.equity) * 100 > s.maxPositionPct) {
    return fail(`position would be over ${s.maxPositionPct}% of the account`);
  }

  const todays = ctx.trades.filter((t) => t.mode === ctx.mode && nyDay(t.entryAt) === today);
  if (todays.length >= s.maxTradesPerDay) return fail(`already made ${todays.length} trades today`);

  const realizedToday = ctx.trades
    .filter((t) => t.mode === ctx.mode && t.status === 'closed' && t.exitAt && nyDay(t.exitAt) === today)
    .reduce((a, t) => a + (t.pnl || 0), 0);
  if (ctx.account.equity > 0 && realizedToday / ctx.account.equity <= -s.dailyLossLimitPct / 100) {
    return fail(`daily loss limit hit (${((realizedToday / ctx.account.equity) * 100).toFixed(1)}%)`);
  }
  return ok();
}

function ok() {
  return { ok: true };
}
function fail(reason) {
  return { ok: false, reason };
}

module.exports = { checkOrder, nyDay };
