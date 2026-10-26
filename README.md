# AI Trader

Private trading assistant with a website and an Android app. It scans a watchlist for a rules-based setup, lets Claude veto weak trades, enforces hard risk limits, and either simulates the trade, shows it to you, or places it with a broker.

## Three modes

| Mode | What happens |
|---|---|
| **Paper** (default) | Simulated $100 account. Real prices, fake money. Start here. |
| **Signals only** | Finds trades and explains them. You place them yourself. |
| **Live** | Places real orders with the broker you choose. Needs a typed confirmation to switch on, and each order is capped by `MAX_LIVE_TRADE_DOLLARS` on the server. |

## Brokers

| Broker | Status |
|---|---|
| Alpaca | Works. Fractional shares. Free paper account for a dry run with their system too (`ALPACA_PAPER=true`). Also supplies the market data. |
| Schwab (ex-TD Ameritrade) | Written, **untested**. Needs an approved Schwab developer app, whole shares only, re-login about weekly. Test with one tiny order first. |
| Webull | Not written. Webull has an official API (developer.webull.com, sandbox included) that needs request signing and approved keys. The adapter file is where it goes. |
| Robinhood | Alerts only. Robinhood's official API covers crypto only, so the app can't place stock orders there. Pick Robinhood + Signals mode: every setup is pushed to your phone (set `NTFY_TOPIC`) with the entry, target and stop, and you place the order in Robinhood yourself. |

## Run it (demo, 2 minutes)

```
APP_PASSWORD='pick-a-long-passphrase' node server/index.js
```
Open http://127.0.0.1:8080, sign in, tap **Scan now**. With no keys it uses synthetic prices (SCHD and KO are rigged to show a setup), so you can click through everything. Needs Node 20+; there are no dependencies to install.

## Run it for real

1. Copy `.env.example` to `.env`. Add Alpaca keys (free account), and optionally `ANTHROPIC_API_KEY` for the AI review.
2. Keep `ALPACA_PAPER=true` until you trust it.
3. `node server/index.js`, or build the included `Dockerfile`.
4. Turn on **Automatic scanning** in Settings. It scans on your chosen interval during market hours and manages exits (target, stop, time stop) on the same schedule.

## Get it on your phone

The server has to be reachable over **HTTPS** (your login token travels with every request). Easy options: a Cloudflare Tunnel or Tailscale Funnel pointing at `localhost:8080`, or a small VPS behind Caddy.

- **Quickest:** open the HTTPS address in Chrome on your phone, menu, **Add to Home screen**. It installs as an app.
- **APK:** the `mobile/` folder is a Capacitor wrapper that opens your hosted site as a native app. Push this project to a GitHub repo, add a repository variable `APP_URL` (your https address), and run the **Build Android APK** workflow. Download `app-debug.apk` from the run and install it. Because the app just opens your site, UI updates never need a new APK. Not built or installed on a phone yet; the Android project does generate correctly with your URL.

## How a trade is decided

1. **Rules** (`server/strategy.js`): 50-day average above 200-day, price above 200-day, RSI(14) between 35 and 52 and rising two days in a row, price not more than 3% under the 20-day average.
2. **Risk limits** (`server/risk.js`): trade size, max positions, max % of account in one trade, trades per day, daily loss limit, minimum price, blocklist, cash check. Buys only; exits are always allowed.
3. **AI review** (`server/ai.js`): Claude sees the numbers and can only approve or reject. If the AI call fails, the trade is skipped rather than made unreviewed.
4. **Exits**: +3% target, -3% stop, or 5 trading days, checked every scan. Pausing blocks new trades but keeps exits running.

## Know the limits

- **The strategy is unproven.** It's a reasonable textbook setup and has not been backtested here. Paper trade it for weeks and read the closed-trade stats before any real money.
- Stops and targets are checked when the app scans (hourly by default), not by the broker. A price can blow through a stop between scans. Use a shorter interval or accept that gap.
- It can't see earnings dates or news. The AI is told so. Keep earnings names on the blocklist.
- Market hours ignore US holidays; the broker will reject orders on those days and it will be logged.
- Single user, single password, one server. The login has rate limiting, but this is not built for strangers.
- Broker keys live on the server only, never in the browser or APK.

## If you ever release it

Automated trading software for other people brings brokerage, data-licensing and possibly investment-adviser rules. Talk to a lawyer before charging anyone.

## Tests

`npm test` runs 29 tests: indicator math against a published RSI example, strategy, every risk rule, the engine (entries, target, stop, time stop, AI veto and failure, pause, signals mode), and the API (login, rate limit, settings validation, live-mode lock).

## Added features (v2)

- **Strategies**: uptrend pullback (default), 20-day breakout, short-term mean reversion. Enable any mix in Settings.
- **Backtest tab / `node scripts/backtest.js --years 5 --symbols SPY,QQQ,KO --strategy all`** (or `--csv ./prices`). Next-day-open fills, slippage, stop-first on ambiguous days, SPY comparison, first-half vs second-half check. With small trades most cash sits idle, so account return can trail SPY.
- **Exits** checked every scan and every 5 minutes between scans. Optional broker-side stop and target (Alpaca, whole shares only).
- **Earnings and news**: Finnhub earnings gate (fails closed), Alpaca headlines shown to the AI as untrusted data.
- **Performance tab**: equity curve vs SPY, results by strategy, symbol and exit reason.
- **Phone alerts** (ntfy), daily summary at 4:05 pm ET, `/healthz` and `HEALTHCHECK_URL`.
- **Security**: optional authenticator-app 2FA, rate-limited login. **Sell everything** button.
- **AI watchlist ideas** in Settings.
- **Robinhood**: no stock API exists, so choose Robinhood + Signals mode. Each setup is pushed to your phone with entry, target and stop; you place the order in Robinhood.
- Webull and Schwab adapters are written but untested against real accounts. Tests: 51.

## Stocks and crypto together (v3)

Settings -> General: turn on **Trade stocks**, **Trade crypto**, or both. The two sides are fully separate: each has its own broker, watchlist, cash (paper mode keeps two paper accounts), position limits, daily loss limit, open trades and results. A crypto loss never uses up the stock side's daily limit, and vice versa. The Dashboard, Performance and Backtest tabs get a Stocks / Crypto switch when both are on. Pause, mode (paper / signals / live) and Sell everything apply to both. You can't turn a side off while it has open trades.

Crypto scans never pause (stocks follow the market clock), time stops count calendar days, and it has its own exit numbers (pullback +6/-5, breakout +10/-6, mean reversion +4/-6): starting guesses, not tested numbers. Prices come from Coinbase's public market data (no key), whichever exchange you trade on. Backtests charge 0.3% slippage per side for crypto. Crypto brokers: Robinhood Crypto, Coinbase, Kraken, OKX (OKX starts in demo mode). Coins you already hold are never bought again by the app, and it only sells the amount it bought.

## More stock brokers (v3)

Tradier, Tastytrade, Public and Interactive Brokers join Alpaca, Schwab and Webull. All new adapters are written from public docs and tested only with mocked responses. Tradier and Tastytrade start in their sandboxes. IBKR needs its gateway running and logged in daily.

## Robinhood agentic account

Robinhood's agent connection (`agent.robinhood.com/mcp/trading`) is built for AI apps you sign in to, like Claude. This app can't use it: the sign-in method isn't documented for a self-hosted server. The workable setup is Robinhood + Signals mode (phone alerts), then ask Claude to place the trade in the agentic account.

## Autopilot and warnings (v3.2)

Settings -> General -> **Autopilot** keeps scanning and trading by itself (it also restarts scanning when the server restarts) and checks exits between scans. Safety stops pause NEW buys only, exits keep running, and you get a phone alert: scans failing several times in a row (default 3), or an account falling a set % from its peak (default 20%, 0 turns it off). You resume it yourself. Turning autopilot on while in Live mode asks for the live confirmation. The live per-trade cap (`MAX_LIVE_TRADE_DOLLARS`) still applies.

**Warnings** can be hidden in Settings. That hides advice (demo data, setup tips, paused note, Schwab expiring soon). Real problems (account errors, a stalled scanner, an expired Schwab login) always show.

Tests: 77.

## No server: run it free on GitHub (v4)
See **SETUP-GITHUB.md**. A scheduled GitHub Action runs `scripts/run-once.js` every 10 minutes, the website is hosted on GitHub Pages, and the APK is built by an Action. State lives encrypted on a `data` branch, so a public repo is safe. Settings, Scan now, Pause and Sell everything travel as encrypted commands the runner picks up.

## Also in v4
* **Test connection** for each broker (read-only; on OKX demo it can also buy and sell back the smallest amount).
* **Order size checks**: minimum size and increments are looked up per coin (OKX, Kraken, Coinbase, Robinhood Crypto). Too-small orders are skipped with a plain message instead of failing.
* **Exchange-held target and stop** for OKX crypto (one-cancels-other order), like Alpaca brackets for stocks. Order ids are self-contained, so a restart never loses track of an order.
* **Real fills and fees** in P&L (price actually paid, fee in dollars, slippage vs the signal price).
* **Manual-close detection**: a position sold outside the app is closed in the books (marked as an estimate) and never sold twice.
* **Trades CSV** download (Performance tab).
* **NYSE holiday and early-close calendar** (computed, no table to go stale).
