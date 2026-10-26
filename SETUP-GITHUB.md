# Run it free on GitHub (no server)

GitHub does three jobs for you:

| Job | How | Cost |
|---|---|---|
| The "server": scans and checks exits | A scheduled GitHub Action (`trader.yml`), every 10 minutes | free on a public repo |
| The website | GitHub Pages (`pages.yml`) at `https://YOU.github.io/REPO/` | free |
| The Android app | GitHub Action (`android.yml`) builds an APK and posts it to Releases | free |

**Your repo is public, so nothing private is stored in the clear.** Broker keys live in GitHub *Secrets*. The app's state (trades, settings, balances) is stored in the `data` branch **encrypted** with your passphrase (AES-256-GCM). Anyone can see the code and that the runner ran; nobody can read your data without the passphrase.

## 1. Create the repo and push the code
Create an empty **public** repo (for example `aitrader`) and push this folder to it (Claude can do the push once the repo exists).

## 2. Add secrets
Repo → **Settings → Secrets and variables → Actions → New repository secret**.

| Secret | What |
|---|---|
| `STATE_PASSPHRASE` | **Required.** 8+ characters, long is better. Encrypts everything. If you lose it the saved data cannot be recovered. |
| `OKX_API_KEY`, `OKX_API_SECRET`, `OKX_PASSPHRASE` | Your OKX keys (trade permission, **no withdrawal**). Start with OKX *demo* keys. |
| `ALPACA_KEY_ID`, `ALPACA_SECRET_KEY` (+ others) | Any broker listed in `.env.example`. Use the same names. |
| `ANTHROPIC_API_KEY`, `FINNHUB_API_KEY` | Optional: AI review, earnings dates. |
| `NTFY_TOPIC` | Optional: phone alerts. Use a long random name. |

**Easier:** skip typing these into GitHub. Once the app is running, Settings → *Connect accounts* encrypts your keys on the phone and saves them as GitHub Secrets for you (it needs the token permissions in step 5).

Non-secret settings (such as `OKX_DEMO=true` or `MAX_LIVE_TRADE_DOLLARS=25`) go under the **Variables** tab with the same names. `OKX_DEMO` defaults to true.

## 3. Start the runner
**Actions** tab → *Trader* → **Run workflow**. (If GitHub asks to enable workflows, enable them.) The first run creates the `data` branch with the encrypted state.

## 4. Turn on the website
**Settings → Pages → Source: GitHub Actions**, then **Actions → Website → Run workflow**. Your site: `https://YOU.github.io/REPO/`.

## 5. Make a GitHub token for the app
GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate:
* Repository access: **only this repo**
* Permissions: **Contents: Read and write**, **Actions: Read and write**, **Secrets: Read and write**, **Variables: Read and write** (the last two let the app save your broker keys for you)

Open the website, paste the token and your passphrase. Both stay on that device.

## 6. Get the Android app
**Actions → Build Android APK → Run workflow.** When it finishes, open `github.com/YOU/REPO/releases` on your phone and download `ai-trader.apk` (allow "install unknown apps" for your browser). Sign in with the same token and passphrase.

## 7. Phone buttons (optional)
With `NTFY_TOPIC` set, alerts can carry **Pause** and **Sell everything** buttons. Make a second fine-grained token with only **Actions: Read and write** on this repo, save it as the secret `NTFY_DISPATCH_TOKEN`. Each button carries a signed, single-use command that expires in 12 hours. Anyone who can read your ntfy topic can see the token inside the buttons, so keep the topic name long and secret, and keep that token limited to Actions.

## Test before real money
1. Settings → your crypto broker → **Test connection** (runs on GitHub's servers, so it also checks that your exchange accepts connections from them).
2. On OKX demo: **Test with a tiny demo order**.
3. Run paper mode for a while; read the Performance tab.

## Honest limits
* **Timing is approximate.** GitHub cron is best-effort and often runs a few minutes late (sometimes much later at busy times). That is why target and stop orders are placed *at the exchange* (OKX crypto, Alpaca whole-share stocks) when you are live: they keep working between runs. Brokers without that (Tradier, etc.) only sell when a run notices.
* Taps in the app take effect on the next run. The app triggers one immediately, so it normally takes about a minute.
* GitHub pauses scheduled workflows on a repo with no activity for 60 days. The runner commits whenever something changes, but a long quiet stretch could still pause it; if the app says "Runner updated" long ago, open Actions and re-enable it.
* Some exchanges refuse connections from US cloud IPs. Use **Test connection** on the runner before trusting it.
* Not available here: Schwab (needs a server for its login redirect) and two-factor (GitHub and the passphrase protect the app).
* Nothing here has been run against a real GitHub repo, OKX or any broker account yet. The code is tested with simulated GitHub and exchange responses only.
