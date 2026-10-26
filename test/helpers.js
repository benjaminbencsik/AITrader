'use strict';
// Builds synthetic daily bars for tests.
function barsFromCloses(closes) {
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  return closes.map((c, i) => ({ t: new Date(end.getTime() - (closes.length - i) * 86400e3).toISOString(), o: c, h: c, l: c, c, v: 1e6 }));
}

// Long steady uptrend, a short pullback, then two small up days: should satisfy the setup.
function pullbackCloses({ n = 240, down = 8, up = 2 } = {}) {
  const c = [];
  let p = 50;
  for (let i = 0; i < n; i++) {
    p *= 1 + 0.0035 + (i % 2 ? 0.004 : -0.003); // up with a little chop
    c.push(p);
  }
  for (let i = 0; i < down; i++) {
    p *= 0.992;
    c.push(p);
  }
  for (let i = 0; i < up; i++) {
    p *= 1.006;
    c.push(p);
  }
  return c;
}

function downtrendCloses(n = 260) {
  const c = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    p *= 0.998;
    c.push(p);
  }
  return c;
}

class FakeData {
  constructor(map) {
    this.name = 'fake';
    this.map = map; // symbol -> closes
  }
  async getBars(symbol, count = 260) {
    if (!this.map[symbol]) throw new Error('no data for ' + symbol);
    return barsFromCloses(this.map[symbol]).slice(-count);
  }
  async getQuote(symbol) {
    const c = this.map[symbol];
    return c[c.length - 1];
  }
  setPrice(symbol, price) {
    this.map[symbol] = [...this.map[symbol].slice(0, -1), price];
  }
}

module.exports = { barsFromCloses, pullbackCloses, downtrendCloses, FakeData };
