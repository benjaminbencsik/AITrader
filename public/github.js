'use strict';
// Serverless connector. Only loaded in the static build (website on GitHub Pages, or the APK), where config.js defines AITRADER_STATIC.
// The app screens read what your GitHub runner publishes (encrypted with your passphrase) and send it commands the same way.
// Your GitHub token and passphrase stay on this device. Nothing is ever sent anywhere except api.github.com.
(function () {
  const CFG = window.AITRADER_STATIC;
  const S = window.AITRADER_SHARED;
  if (!CFG || !S) return;
  const KEY = 'aitrader_gh';
  const API = CFG.api || 'https://api.github.com'; // CFG.api is only set by tests
  const POLL_MS = 4000;
  const WAIT_MS = 180000;

  const store = {
    get() { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } },
    set(v) { try { v ? localStorage.setItem(KEY, JSON.stringify(v)) : localStorage.removeItem(KEY); } catch { /* storage blocked: stays signed in until reload */ } },
  };
  let session = store.get();
  let keys = null;
  let cached = { at: 0, view: null };
  let defaultBranch = null;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const headers = (raw) => ({ Authorization: 'Bearer ' + session.token, Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' });

  async function gh(path, opts = {}) {
    const r = await fetch(API + path, { cache: 'no-store', ...opts, headers: { ...headers(opts.raw), ...(opts.body ? { 'content-type': 'application/json' } : {}) } });
    if (r.status === 401) throw new Error('GitHub rejected the token. Make a new one and sign in again.');
    if (r.status === 403 && /rate limit/i.test(await r.clone().text())) throw new Error('GitHub rate limit reached. Wait a few minutes.');
    return r;
  }
  async function readFile(name) {
    const r = await gh(`/repos/${CFG.repo}/contents/${name}?ref=${CFG.branch}`, { raw: true });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GitHub ${r.status} reading ${name}`);
    return r.text();
  }
  async function getKeys() {
    if (keys) return keys;
    const m = await readFile('meta.json');
    if (!m) throw new Error('Nothing saved yet. On GitHub open Actions, pick "Trader", and press Run workflow once. Then try again.');
    const meta = JSON.parse(m);
    keys = await S.deriveKeys(session.passphrase, meta.salt, meta.iter);
    return keys;
  }
  async function readView(force) {
    if (!force && cached.view && Date.now() - cached.at < 15000) return cached.view;
    const k = await getKeys();
    const t = await readFile('view.enc.json');
    if (!t) throw new Error('The runner has not published anything yet. On GitHub: Actions, Trader, Run workflow.');
    cached = { at: Date.now(), view: await S.open(JSON.parse(t), k) };
    return cached.view;
  }

  // ---- waiting indicator while a command travels to the runner and back
  let toast = null;
  const say = (msg) => {
    if (!msg) { if (toast) toast.remove(); toast = null; return; }
    if (!toast) {
      toast = document.createElement('div');
      toast.style.cssText = 'position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));z-index:99;padding:10px 14px;border-radius:10px;background:#0f172a;color:#fff;font:14px system-ui;text-align:center;box-shadow:0 4px 16px rgba(0,0,0,.3)';
      document.body.append(toast);
    }
    toast.textContent = msg;
  };

  async function send(method, path, body) {
    const k = await getKeys();
    const id = S.nonce();
    const ts = Date.now();
    const sealed = await S.seal({ id, ts, method, path, body: body || {} }, k);
    const put = await gh(`/repos/${CFG.repo}/contents/inbox/${ts}-${id}.enc.json`, {
      method: 'PUT',
      body: JSON.stringify({ message: 'cmd', branch: CFG.branch, content: btoa(JSON.stringify(sealed)) }),
    });
    if (!put.ok) throw new Error(put.status === 403 || put.status === 404 ? 'GitHub would not accept the command. Check the token can write Contents on this repo.' : `GitHub ${put.status} while sending`);
    if (!defaultBranch) defaultBranch = (await (await gh(`/repos/${CFG.repo}`)).json()).default_branch || 'main';
    const d = await gh(`/repos/${CFG.repo}/actions/workflows/${CFG.workflow}/dispatches`, { method: 'POST', body: JSON.stringify({ ref: defaultBranch }) });
    const started = Date.now();
    for (;;) {
      say(`Sent to your runner. Waiting for it… ${Math.round((Date.now() - started) / 1000)}s${d.ok ? '' : ' (could not start it now; it will pick this up on its next scheduled run)'}`);
      await sleep(POLL_MS);
      const t = await readFile('results.enc.json');
      if (t) {
        const res = await S.open(JSON.parse(t), k);
        if (res[id]) {
          cached = { at: 0, view: null };
          say(null);
          if (res[id].status >= 400) { const e = new Error((res[id].body && res[id].body.error) || 'Request failed'); e.data = res[id].body; throw e; }
          return res[id].body;
        }
      }
      if (Date.now() - started > WAIT_MS) {
        say(null);
        throw new Error('Your runner has not picked this up yet. It is queued and will apply on its next run (up to about 10 minutes).');
      }
    }
  }

  const NOT_HERE = {
    '/api/2fa/setup': 'Two-factor is not used here; GitHub and your passphrase protect the app.',
    '/api/schwab/link': 'Schwab needs a server for its login redirect, so it is not available in the serverless version.',
  };

  async function api(path, opts = {}) {
    const method = opts.method || 'GET';
    const [p, qs] = path.split('?');
    if (method === 'GET') {
      const v = await readView(p === '/api/status');
      const cls = new URLSearchParams(qs || '').get('class');
      if (p === '/api/status') return { ...v.status, github: { viewAt: v.at } };
      if (p === '/api/trades') return v.trades.slice().reverse().slice(0, 200);
      if (p === '/api/signals') return v.signals.slice().reverse();
      if (p === '/api/log') return v.log.slice().reverse();
      if (p === '/api/performance') {
        const perf = v.performance[cls === 'crypto' ? 'crypto' : 'stocks'];
        if (!perf) throw new Error('No performance data yet.');
        return perf;
      }
      if (p === '/api/trades.csv') return S.tradesToCsv(v.trades.filter((t) => !cls || (t.assetClass || 'stocks') === cls));
      throw new Error('Not available: ' + p);
    }
    if (NOT_HERE[p] || p.startsWith('/api/2fa/')) throw new Error(NOT_HERE[p] || NOT_HERE['/api/2fa/setup']);
    return send(method, p, opts.body);
  }

  function loginView(onDone) {
    const el = (tag, props, ...kids) => { const e = document.createElement(tag); Object.assign(e, props || {}); e.append(...kids.filter((x) => x != null)); return e; };
    const token = el('input', { type: 'password', placeholder: 'GitHub token (fine-grained)', autocomplete: 'off' });
    const pass = el('input', { type: 'password', placeholder: 'Your passphrase (STATE_PASSPHRASE)', autocomplete: 'off' });
    const err = el('div', { className: 'bad', style: 'min-height:20px;margin-top:8px' });
    const go = async () => {
      err.textContent = '';
      session = { token: token.value.trim(), passphrase: pass.value };
      keys = null;
      cached = { at: 0, view: null };
      try {
        if (!session.token || !session.passphrase) throw new Error('Enter both.');
        await readView(true);
        store.set(session);
        onDone();
      } catch (e) {
        session = null;
        err.textContent = e.message;
      }
    };
    pass.addEventListener('keydown', (e) => e.key === 'Enter' && go());
    const btn = el('button', { onclick: go, style: 'width:100%' }, 'Connect');
    return el('div', { className: 'login' },
      el('h1', {}, 'AI Trader'),
      el('p', { className: 'muted' }, 'Your repo: ', el('b', {}, CFG.repo), '. Your keys stay in GitHub Secrets. This device keeps only the token and passphrase below.'),
      token, el('div', { style: 'height:8px' }), pass, el('div', { style: 'height:10px' }), btn, err);
  }

  window.AITRADER_GITHUB = {
    api, loginView,
    hasSession: () => Boolean(session && session.token && session.passphrase),
    signOut() { session = null; keys = null; cached = { at: 0, view: null }; store.set(null); },
  };
})();
