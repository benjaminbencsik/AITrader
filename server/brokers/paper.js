'use strict';
// Simulated account. Fills at the current quote, fractional shares, no fees, no slippage.
// Slippage and spreads are real in live trading, so expect live results to be a bit worse.

class PaperBroker {
  constructor({ store, data, key = 'paper' }) {
    this.name = key === 'paper' ? 'paper' : 'paper-crypto';
    this.key = key;
    this.store = store;
    this.data = data;
  }

  get p() {
    return this.store.state[this.key];
  }

  async account() {
    const positions = await this.positions();
    const mv = positions.reduce((a, x) => a + x.marketValue, 0);
    return { cash: this.p.cash, equity: this.p.cash + mv, buyingPower: this.p.cash };
  }

  async positions() {
    const out = [];
    for (const [symbol, pos] of Object.entries(this.p.positions)) {
      const price = await this.data.getQuote(symbol);
      out.push({ symbol, qty: pos.qty, avgCost: pos.avgCost, price, marketValue: pos.qty * price });
    }
    return out;
  }

  async placeOrder({ symbol, side, notional, qty }) {
    const price = await this.data.getQuote(symbol);
    if (side === 'buy') {
      const dollars = notional != null ? notional : qty * price;
      if (dollars > this.p.cash + 1e-9) throw new Error('paper: insufficient cash');
      const q = dollars / price;
      const cur = this.p.positions[symbol] || { qty: 0, avgCost: 0 };
      const newQty = cur.qty + q;
      this.p.positions[symbol] = { qty: newQty, avgCost: (cur.qty * cur.avgCost + dollars) / newQty };
      this.p.cash -= dollars;
      this.store.save();
      return { id: `paper-${Date.now()}`, status: 'filled', filledQty: q, filledAvgPrice: price };
    }
    const cur = this.p.positions[symbol];
    if (!cur) throw new Error(`paper: no position in ${symbol}`);
    const q = qty != null ? Math.min(qty, cur.qty) : cur.qty;
    this.p.cash += q * price;
    cur.qty -= q;
    if (cur.qty < 1e-9) delete this.p.positions[symbol];
    this.store.save();
    return { id: `paper-${Date.now()}`, status: 'filled', filledQty: q, filledAvgPrice: price };
  }

  async getOrder(id) {
    return { id, status: 'filled' };
  }
}

module.exports = { PaperBroker };
