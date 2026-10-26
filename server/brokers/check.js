'use strict';
// "Test connection": proves a broker's keys work WITHOUT placing an order (except OKX demo, on request, with a round trip
// that only runs against OKX's demo account). Returns plain-English checks the settings screen can show.

async function testBroker(getBroker, { feed, sampleSymbol, tradeDollars = 5, orderTest = false }) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  let broker;
  try {
    broker = await getBroker();
    add('Keys', true, `${broker.name} adapter loaded`);
  } catch (e) {
    add('Keys', false, e.message);
    return { ok: false, checks };
  }
  try {
    const a = await broker.account();
    add('Account', true, `cash $${Number(a.cash).toFixed(2)}, total $${Number(a.equity).toFixed(2)}`);
  } catch (e) {
    add('Account', false, e.message);
    return { ok: false, checks };
  }
  try {
    const pos = await broker.positions();
    add('Holdings', true, pos.length ? `${pos.length} position${pos.length === 1 ? '' : 's'}: ${pos.slice(0, 5).map((p) => p.symbol).join(', ')}` : 'no positions');
  } catch (e) {
    add('Holdings', false, e.message);
  }
  let price = null;
  try {
    price = await feed.getQuote(sampleSymbol);
    add('Price feed', true, `${sampleSymbol} ${price}`);
  } catch (e) {
    add('Price feed', false, e.message);
  }
  if (broker.limits && price) {
    try {
      const lim = await broker.limits(sampleSymbol);
      if (lim) {
        add('Order limits', true, `${sampleSymbol}: minimum ${lim.minQty || '-'}${lim.minNotional ? `, min $${lim.minNotional}` : ''}, step ${lim.qtyStep || '-'}`);
        try {
          const fit = await broker._fit(sampleSymbol, 'buy', { notional: tradeDollars });
          add('Your trade size', true, `$${tradeDollars} is large enough (about ${(tradeDollars / price).toPrecision(3)} ${sampleSymbol.split('-')[0]})`);
          void fit;
        } catch (e) {
          add('Your trade size', false, e.message);
        }
      } else {
        add('Order limits', false, 'the exchange returned nothing for this symbol');
      }
    } catch (e) {
      add('Order limits', false, e.message);
    }
  }
  if (orderTest) {
    if (!broker.demoRoundTrip) add('Demo order', false, 'only available for OKX demo trading');
    else {
      try {
        const r = await broker.demoRoundTrip(sampleSymbol);
        add('Demo order', true, `bought ${r.bought} at ${r.boughtAt}, sold back at ${r.soldAt}${r.fees ? `, fees $${r.fees.toFixed(4)}` : ''}`);
      } catch (e) {
        add('Demo order', false, e.message);
      }
    }
  }
  return { ok: checks.every((c) => c.ok), broker: broker.name, checks };
}

module.exports = { testBroker };
