'use strict';
const { PaperBroker } = require('./paper');
const { AlpacaBroker } = require('./alpaca');
const { SchwabBroker } = require('./schwab');
const { WebullBroker } = require('./webull');
const { RobinhoodBroker } = require('./placeholders');
const { TradierBroker, TastytradeBroker, PublicBroker, IbkrBroker } = require('./stocks');
const { RobinhoodCryptoBroker, KrakenBroker, CoinbaseBroker, OkxBroker } = require('./crypto');

const STOCK_BROKERS = ['alpaca', 'tradier', 'tastytrade', 'public', 'schwab', 'ibkr', 'webull', 'robinhood'];
const CRYPTO_BROKERS = ['robinhood-crypto', 'coinbase', 'kraken', 'okx'];

function createBroker(name, { env = process.env, store, data, fetchImpl = fetch, paperKey = 'paper' }) {
  switch (name) {
    case 'paper':
      return new PaperBroker({ store, data, key: paperKey });
    case 'alpaca':
      return new AlpacaBroker(env);
    case 'schwab':
      return new SchwabBroker(env, data, store);
    case 'webull':
      return new WebullBroker(env, data);
    case 'tradier':
      return new TradierBroker(env, data, fetchImpl);
    case 'tastytrade':
      return new TastytradeBroker(env, data, fetchImpl);
    case 'public':
      return new PublicBroker(env, data, fetchImpl);
    case 'ibkr':
      return new IbkrBroker(env, data, fetchImpl);
    case 'robinhood-crypto':
      return new RobinhoodCryptoBroker(env, data, fetchImpl);
    case 'coinbase':
      return new CoinbaseBroker(env, data, fetchImpl);
    case 'kraken':
      return new KrakenBroker(env, data, fetchImpl);
    case 'okx':
      return new OkxBroker(env, data, fetchImpl);
    case 'robinhood':
      return new RobinhoodBroker();
    default:
      throw new Error(`unknown broker "${name}"`);
  }
}

const has = (env, ...keys) => keys.every((k) => Boolean(env[k]));
const flag = (env, k, dflt = 'true') => String(env[k] || dflt).toLowerCase() !== 'false';

// What the settings screen shows for each broker. assetClass says which list it belongs in.
function brokerCatalog(env = process.env) {
  const ready = (ok) => (ok ? 'experimental' : 'needs-keys');
  return [
    {
      id: 'alpaca', label: 'Alpaca', assetClass: 'stocks',
      status: has(env, 'ALPACA_KEY_ID', 'ALPACA_SECRET_KEY') ? 'ready' : 'needs-keys',
      note: `Fractional shares. ${flag(env, 'ALPACA_PAPER') ? "Alpaca's own paper account" : 'REAL MONEY'}. The best-tested option.`,
    },
    {
      id: 'tradier', label: 'Tradier', assetClass: 'stocks', status: ready(has(env, 'TRADIER_ACCESS_TOKEN', 'TRADIER_ACCOUNT_ID')),
      note: `Untested. Whole shares only. ${flag(env, 'TRADIER_SANDBOX') ? 'Sandbox' : 'REAL MONEY'}.`,
    },
    {
      id: 'tastytrade', label: 'Tastytrade', assetClass: 'stocks', status: ready(has(env, 'TASTYTRADE_CLIENT_SECRET', 'TASTYTRADE_REFRESH_TOKEN', 'TASTYTRADE_ACCOUNT')),
      note: `Untested. Whole shares only. ${flag(env, 'TASTYTRADE_SANDBOX') ? 'Sandbox' : 'REAL MONEY'}.`,
    },
    {
      id: 'public', label: 'Public', assetClass: 'stocks', status: ready(has(env, 'PUBLIC_API_SECRET', 'PUBLIC_ACCOUNT_ID')),
      note: 'Untested. Dollar-amount buys. REAL MONEY (no sandbox).',
    },
    {
      id: 'schwab', label: 'Schwab (ex-TD Ameritrade)', assetClass: 'stocks', status: ready(has(env, 'SCHWAB_APP_KEY', 'SCHWAB_APP_SECRET')),
      note: 'Untested. Whole shares only; reconnect about weekly (button in Settings).',
    },
    {
      id: 'ibkr', label: 'Interactive Brokers', assetClass: 'stocks', status: 'experimental',
      note: 'Untested. Needs the IBKR gateway running and logged in daily, so not great unattended. Whole shares only.',
    },
    {
      id: 'webull', label: 'Webull', assetClass: 'stocks', status: ready(has(env, 'WEBULL_APP_KEY', 'WEBULL_APP_SECRET')),
      note: `Untested. Whole shares only. ${flag(env, 'WEBULL_SANDBOX') ? 'Sandbox' : 'REAL MONEY'}.`,
    },
    {
      id: 'robinhood', label: 'Robinhood (alerts)', assetClass: 'stocks', status: 'alerts-only',
      note: 'Robinhood has no stock API, so use Signals mode: each setup is pushed to your phone (needs NTFY_TOPIC) with the exact buy, target and stop, and you place it in Robinhood yourself.',
    },
    {
      id: 'robinhood-crypto', label: 'Robinhood Crypto', assetClass: 'crypto', status: ready(has(env, 'ROBINHOOD_API_KEY', 'ROBINHOOD_PRIVATE_KEY')),
      note: 'Untested. Official crypto API. REAL MONEY (no sandbox). Orders are sized in coins at the best ask, so expect the spread as a cost.',
    },
    {
      id: 'coinbase', label: 'Coinbase', assetClass: 'crypto', status: ready(has(env, 'COINBASE_API_KEY_NAME', 'COINBASE_API_PRIVATE_KEY')),
      note: 'Untested. Advanced Trade API. REAL MONEY (no sandbox).',
    },
    {
      id: 'kraken', label: 'Kraken', assetClass: 'crypto', status: ready(has(env, 'KRAKEN_API_KEY', 'KRAKEN_API_SECRET')),
      note: 'Untested. REAL MONEY. Check Kraken\'s minimum order size for each coin.',
    },
    {
      id: 'okx', label: 'OKX', assetClass: 'crypto', status: ready(has(env, 'OKX_API_KEY', 'OKX_API_SECRET', 'OKX_PASSPHRASE')),
      note: `Untested. ${flag(env, 'OKX_DEMO') ? 'Demo trading (OKX demo keys)' : 'REAL MONEY'}. Trades against ${(env.OKX_QUOTE || 'USDT').toUpperCase()}.`,
    },
  ];
}

module.exports = { createBroker, brokerCatalog, STOCK_BROKERS, CRYPTO_BROKERS };
