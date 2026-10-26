'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULT_SETTINGS = {
  mode: 'paper', // 'paper' | 'live' | 'signals'
  broker: 'alpaca', // used when mode === 'live'
  paused: false, // kill switch
  autoRun: false,
  // Autopilot = scanning runs by itself (also after a restart) with automatic safety stops that pause NEW buys.
  autopilot: false,
  autopilotFailLimit: 3,
  autopilotDrawdownPct: 20,
  showWarnings: true,
  // Smart mode: pick a risk level and the app sizes trades from the account's real balance. Budgets of 0 mean the whole account.
  smartMode: false,
  riskLevel: 'balanced',
  smartBudgetStocks: 0,
  smartBudgetCrypto: 0,
  tickMinutes: 60,
  watchlist: ['SPY', 'QQQ', 'IWM', 'XLF', 'XLE', 'XLV', 'SCHD', 'KO', 'BAC', 'T'],
  blocklist: [],
  tradeDollars: 5,
  minTradeDollars: 1,
  maxPositions: 4,
  maxPositionPct: 40,
  maxTradesPerDay: 6,
  dailyLossLimitPct: 10,
  minPrice: 5,
  paperStartingCash: 100,
  aiReview: true,
  enabledStrategies: ['pullback'],
  strategyParams: {},
  earningsBlockDays: 10,
  requireEarningsData: false,
  useBrackets: true,
  exitCheckMinutes: 5,
  strategy: { rsiMin: 35, rsiMax: 52, targetPct: 3, stopPct: 3, timeStopDays: 5 },
  // Crypto mode: runs around the clock with its own list, broker and wider exits (crypto moves much more than stocks).
  stocksEnabled: true,
  cryptoEnabled: false,
  // Crypto has its own budget and risk limits, kept apart from stocks. Pause and mode are shared.
  cryptoLimits: { tradeDollars: 5, minTradeDollars: 1, maxPositions: 3, maxPositionPct: 40, maxTradesPerDay: 6, dailyLossLimitPct: 10 },
  cryptoBroker: 'robinhood-crypto',
  cryptoWatchlist: ['BTC-USD', 'ETH-USD', 'SOL-USD'],
  cryptoParams: {
    pullback: { targetPct: 6, stopPct: 5, timeStopDays: 5 },
    breakout: { targetPct: 10, stopPct: 6, timeStopDays: 10 },
    meanrev: { targetPct: 4, stopPct: 6, timeStopDays: 4 },
  },
};

class Store {
  constructor(file) {
    this.file = file;
    this.state = {
      settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
      trades: [],
      signals: [],
      log: [],
      paper: { cash: null, positions: {} },
      paperCrypto: { cash: null, positions: {} },
      equity: [],
      meta: { lastTickAt: null, lastSummaryDay: null },
      tokens: {},
      auth: {},
    };
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.state = {
        ...this.state,
        ...raw,
        settings: { ...JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), ...(raw.settings || {}), strategy: { ...DEFAULT_SETTINGS.strategy, ...((raw.settings || {}).strategy || {}) } },
        meta: { ...this.state.meta, ...(raw.meta || {}) },
      };
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    const st = this.state.settings;
    // Older saves had a single asset class switch.
    if (st.assetClass) {
      st.stocksEnabled = st.assetClass !== 'crypto';
      st.cryptoEnabled = st.assetClass === 'crypto';
      delete st.assetClass;
    }
    st.cryptoLimits = { ...DEFAULT_SETTINGS.cryptoLimits, ...(st.cryptoLimits || {}) };
    if (this.state.paper.cash == null) this.state.paper.cash = st.paperStartingCash;
    if (!this.state.paperCrypto) this.state.paperCrypto = { cash: null, positions: {} };
    if (this.state.paperCrypto.cash == null) this.state.paperCrypto.cash = st.paperStartingCash;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  log(level, msg, extra) {
    this.state.log.push({ t: new Date().toISOString(), level, msg, ...(extra ? { extra } : {}) });
    if (this.state.log.length > 500) this.state.log.splice(0, this.state.log.length - 500);
    this.save();
  }

  addSignal(sig) {
    this.state.signals.push(sig);
    if (this.state.signals.length > 300) this.state.signals.splice(0, this.state.signals.length - 300);
    this.save();
  }
}

module.exports = { Store, DEFAULT_SETTINGS };
