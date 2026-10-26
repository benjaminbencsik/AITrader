'use strict';
// Brokers that can't be wired up yet. They show in the app so the plumbing is visible,
// but every call fails with a clear explanation instead of pretending to work.

class UnavailableBroker {
  constructor(name, reason) {
    this.name = name;
    this.reason = reason;
  }
  _no() {
    throw new Error(`${this.name}: ${this.reason}`);
  }
  async account() {
    return this._no();
  }
  async positions() {
    return this._no();
  }
  async placeOrder() {
    return this._no();
  }
  async getOrder() {
    return this._no();
  }
}

class RobinhoodBroker extends UnavailableBroker {
  constructor() {
    super(
      'robinhood',
      'Robinhood has an official API for crypto only. Stocks and ETFs have no public API, and the unofficial ones break the terms of service ' +
        'and risk the account. Robinhood stock trades keep working through the Claude connection, not through this app.'
    );
  }
}

module.exports = { RobinhoodBroker };
