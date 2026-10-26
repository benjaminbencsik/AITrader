'use strict';
// Alpaca Trading API (https://docs.alpaca.markets). Supports fractional shares via `notional` orders.
// ALPACA_PAPER=true (default) points at Alpaca's own paper-trading account; set ALPACA_PAPER=false for real money.
//
// Broker-side protection: Alpaca can hold a stop and a target as a "bracket" order, but only for WHOLE shares
// (no fractional/notional brackets). So brackets help when a trade is big enough to buy at least one share.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const px2 = (x) => (Math.round(x * 100) / 100).toFixed(2);

class AlpacaBroker {
  constructor(env = process.env, fetchImpl = fetch, { pollMs = 1000 } = {}) {
    this.name = 'alpaca';
    this.supportsBracket = true;
    this.fetch = fetchImpl;
    this.pollMs = pollMs;
    this.key = env.ALPACA_KEY_ID;
    this.secret = env.ALPACA_SECRET_KEY;
    const paper = String(env.ALPACA_PAPER || 'true').toLowerCase() !== 'false';
    this.paper = paper;
    this.base = env.ALPACA_TRADING_URL || (paper ? 'https://paper-api.alpaca.markets' : 'https://api.alpaca.markets');
    if (!this.key || !this.secret) throw new Error('ALPACA_KEY_ID and ALPACA_SECRET_KEY are not set');
  }

  async _req(method, path, body) {
    const r = await this.fetch(this.base + path, {
      method,
      headers: {
        'APCA-API-KEY-ID': this.key,
        'APCA-API-SECRET-KEY': this.secret,
        'content-type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`Alpaca ${r.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  }

  async account() {
    const a = await this._req('GET', '/v2/account');
    return { cash: Number(a.cash), equity: Number(a.equity), buyingPower: Number(a.buying_power) };
  }

  async positions() {
    const list = await this._req('GET', '/v2/positions');
    return list.map((p) => ({
      symbol: p.symbol,
      qty: Number(p.qty),
      avgCost: Number(p.avg_entry_price),
      price: Number(p.current_price),
      marketValue: Number(p.market_value),
    }));
  }

  async _waitFilled(orderId) {
    for (let i = 0; i < 8; i++) {
      await sleep(i === 0 ? Math.min(300, this.pollMs) : this.pollMs);
      const cur = await this.getOrder(orderId);
      if (cur.status === 'filled') return cur;
      if (['canceled', 'rejected', 'expired'].includes(cur.status)) throw new Error(`order ${cur.status}`);
    }
    return { id: orderId, status: 'pending' };
  }

  async placeOrder({ symbol, side, notional, qty }) {
    const body = { symbol, side, type: 'market', time_in_force: 'day' };
    if (notional != null) body.notional = String(Math.round(notional * 100) / 100);
    else body.qty = String(qty);
    const o = await this._req('POST', '/v2/orders', body);
    return this._waitFilled(o.id);
  }

  // Market buy of whole shares with a take-profit and a stop-loss held at Alpaca (one cancels the other).
  async placeBracketBuy({ symbol, qty, takeProfit, stopLoss }) {
    if (!Number.isInteger(qty) || qty < 1) throw new Error('bracket orders need whole shares');
    const o = await this._req('POST', '/v2/orders', {
      symbol,
      qty: String(qty),
      side: 'buy',
      type: 'market',
      time_in_force: 'gtc',
      order_class: 'bracket',
      take_profit: { limit_price: px2(takeProfit) },
      stop_loss: { stop_price: px2(stopLoss) },
    });
    return this._waitFilled(o.id);
  }

  // Cancels every open order for a symbol (including bracket legs) so the shares are free to sell.
  async cancelOpenOrders(symbol) {
    const open = await this._req('GET', `/v2/orders?status=open&symbols=${encodeURIComponent(symbol)}&nested=true`);
    const ids = [];
    for (const o of open) {
      ids.push(o.id);
      for (const leg of o.legs || []) ids.push(leg.id);
    }
    for (const oid of ids) {
      try {
        await this._req('DELETE', `/v2/orders/${oid}`);
      } catch (e) {
        if (!/42210000|422|404/.test(e.message)) throw e; // already filled or cancelled is fine
      }
    }
    if (ids.length) await sleep(Math.min(500, this.pollMs));
    return ids.length;
  }

  // Latest filled SELL for a symbol since a time: used to notice that a bracket leg already closed the trade.
  async recentFilledSell(symbol, sinceIso) {
    const list = await this._req('GET', `/v2/orders?status=closed&symbols=${encodeURIComponent(symbol)}&after=${encodeURIComponent(sinceIso)}&direction=desc&limit=20`);
    const o = list.find((x) => x.side === 'sell' && x.status === 'filled' && x.filled_avg_price);
    return o ? { price: Number(o.filled_avg_price), qty: Number(o.filled_qty), at: o.filled_at } : null;
  }

  async getOrder(id) {
    const o = await this._req('GET', `/v2/orders/${id}`);
    return {
      id: o.id,
      status: o.status,
      filledQty: o.filled_qty != null ? Number(o.filled_qty) : undefined,
      filledAvgPrice: o.filled_avg_price != null ? Number(o.filled_avg_price) : undefined,
    };
  }
}

module.exports = { AlpacaBroker };
