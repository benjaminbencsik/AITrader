#!/usr/bin/env node
'use strict';
// One scheduled pass of the trader, meant to run inside GitHub Actions (no server needed).
//
//   node scripts/run-once.js <state-dir>
//
// The state dir is a checkout of the repo's "data" branch. Everything in it is ENCRYPTED with STATE_PASSPHRASE
// (AES-256-GCM), because the repo is public:  meta.json (public salt) | state.enc.json (the full app state)
// | view.enc.json (what the app screens read) | results.enc.json (answers to your commands) | inbox/*.enc.json (commands from the app).
//
// Each pass: load state -> apply commands from the app -> scan/exits if due -> write the new encrypted files.
// Secrets arrive as environment variables (the workflow passes ALL_SECRETS / ALL_VARS as JSON and they are merged in).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const S = require('../public/shared');
const { Store } = require('../server/store');
const { Engine } = require('../server/engine');
const { createApp } = require('../server/index');
const { createData } = require('../server/data');
const { createNotifier } = require('../server/notifier');

const ITER = 250000;
const CMD_MAX_AGE_S = 12 * 3600;
const ALLOWED = new Set(['/api/settings', '/api/tick', '/api/kill', '/api/flatten', '/api/paper/reset', '/api/backtest', '/api/suggest', '/api/broker/test']);

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const writeJson = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); };

// Merges ALL_SECRETS / ALL_VARS (JSON from the workflow) into one environment. Real env vars win.
function mergeEnv(base) {
  const env = { ...base };
  for (const k of ['ALL_VARS', 'ALL_SECRETS']) {
    let o = {};
    try { o = JSON.parse(base[k] || '{}'); } catch { /* ignore */ }
    for (const [name, v] of Object.entries(o)) if (v !== '' && v != null && env[name] === undefined && !/^github_token$/i.test(name)) env[name] = String(v);
  }
  delete env.ALL_SECRETS;
  delete env.ALL_VARS;
  return env;
}

// Thins old equity snapshots so the encrypted state stays small over months.
function thin(arr, max = 6000) {
  if (arr.length <= max) return arr;
  const keepFrom = arr.length - Math.floor(max / 2);
  return arr.slice(0, keepFrom).filter((_, i) => i % 2 === 0).concat(arr.slice(keepFrom));
}

function makeActions(env, keys, now) {
  const token = env.NTFY_DISPATCH_TOKEN;
  const repo = env.GITHUB_REPOSITORY;
  if (!token || !repo) return null;
  const ref = env.GITHUB_REF_NAME || 'main';
  const url = `https://api.github.com/repos/${repo}/actions/workflows/trader.yml/dispatches`;
  return async () => {
    const one = async (cmd, label) => {
      const ts = String(Math.floor(now().getTime() / 1000));
      const nonce = S.nonce();
      const sig = await S.sign(`${cmd}|${ts}|${nonce}`, keys);
      const body = JSON.stringify({ ref, inputs: { cmd, ts, nonce, sig } });
      return `http, ${label}, ${url}, method=POST, headers.Authorization=Bearer ${token}, headers.Accept=application/vnd.github+json, body='${body}', clear=true`;
    };
    return [await one('pause', 'Pause'), await one('flatten', 'Sell everything')].join('; ');
  };
}

async function runOnce({ dir, env: rawEnv = process.env, fetchImpl = fetch, now = () => new Date(), log = () => {} }) {
  const env = mergeEnv(rawEnv);
  if (!env.STATE_PASSPHRASE) throw new Error('Add a repository secret named STATE_PASSPHRASE (8+ characters). It encrypts everything stored in the repo.');
  fs.mkdirSync(dir, { recursive: true });

  // ---- keys and previous state
  let meta = readJson(path.join(dir, 'meta.json'));
  if (!meta) meta = { v: 1, salt: S.newSalt(), iter: ITER, created: now().toISOString() };
  const keys = await S.deriveKeys(env.STATE_PASSPHRASE, meta.salt, meta.iter);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aitrader-run-'));
  const stateFile = path.join(tmp, 'state.json');
  let prevState = null;
  const sealedState = readJson(path.join(dir, 'state.enc.json'));
  if (sealedState) {
    prevState = await S.open(sealedState, keys).catch(() => { throw new Error('STATE_PASSPHRASE does not match the saved data. Use the original passphrase (or delete the data branch to start over).'); });
    fs.writeFileSync(stateFile, JSON.stringify(prevState));
  }
  const prevStateStr = prevState ? JSON.stringify(prevState) : null;
  const prevView = readJson(path.join(dir, 'view.enc.json')) ? await S.open(readJson(path.join(dir, 'view.enc.json')), keys).catch(() => null) : null;
  const prevResults = readJson(path.join(dir, 'results.enc.json')) ? await S.open(readJson(path.join(dir, 'results.enc.json')), keys).catch(() => ({})) : {};

  // ---- app, with phone-alert buttons if configured
  const store = new Store(stateFile);
  const data = createData(env);
  const notify = createNotifier(env, fetchImpl, { actions: makeActions(env, keys, now) });
  const engine = new Engine({ store, data, env, fetchImpl, now, notify });
  engine.start = () => {}; // the schedule is GitHub's cron; no in-process timers
  const app = createApp({ env: { ...env, APP_PASSWORD: crypto.randomBytes(24).toString('hex'), DATA_DIR: tmp }, store, data, engine, fetchImpl });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const bearer = app.issueToken();
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  const results = {};
  const processed = [];
  let ticked = false;
  const counts = { commands: 0, rejected: 0 };
  try {
    // ---- commands: signed phone buttons, then the app's own queued requests
    const cmds = [];
    if (env.CMD) {
      const ts = Number(env.CMD_TS);
      const nonces = (store.state.meta.cmdNonces = store.state.meta.cmdNonces || []);
      const fresh = Math.abs(now().getTime() / 1000 - ts) <= CMD_MAX_AGE_S;
      const good = fresh && !nonces.includes(env.CMD_NONCE) && (await S.verify(`${env.CMD}|${env.CMD_TS}|${env.CMD_NONCE}`, env.CMD_SIG || '', keys));
      if (!good) {
        counts.rejected++;
        store.log('warn', `ignored a phone command (${env.CMD}): bad signature, expired, or already used`);
      } else {
        nonces.push(env.CMD_NONCE);
        if (nonces.length > 60) nonces.splice(0, nonces.length - 60);
        const map = { pause: ['POST', '/api/kill'], resume: ['POST', '/api/settings', { paused: false }], flatten: ['POST', '/api/flatten', { confirm: 'SELL EVERYTHING' }], scan: ['POST', '/api/tick', { force: true }] };
        if (map[env.CMD]) cmds.push({ id: `phone-${env.CMD_NONCE}`, ts, method: map[env.CMD][0], path: map[env.CMD][1], body: map[env.CMD][2], phone: true });
        else counts.rejected++;
      }
    }
    const inboxDir = path.join(dir, 'inbox');
    const files = fs.existsSync(inboxDir) ? fs.readdirSync(inboxDir).filter((f) => f.endsWith('.enc.json')).sort() : [];
    for (const f of files) {
      processed.push(path.join(inboxDir, f));
      try {
        const c = await S.open(readJson(path.join(inboxDir, f)), keys);
        if (Math.abs(now().getTime() - c.ts) > 7 * 86400e3) { counts.rejected++; continue; }
        if (!ALLOWED.has(c.path) || c.method !== 'POST') { counts.rejected++; results[c.id] = { at: now().toISOString(), status: 400, body: { error: 'that action is not available here' } }; continue; }
        cmds.push(c);
      } catch {
        counts.rejected++; // not encrypted with our passphrase: ignored (anyone with a write token could drop a file here)
      }
    }
    cmds.sort((a, b) => a.ts - b.ts);
    for (const c of cmds) {
      counts.commands++;
      if (c.path === '/api/tick') ticked = true;
      try {
        results[c.id] = { at: now().toISOString(), ...(await call(c.method, c.path, c.body)) };
      } catch (e) {
        results[c.id] = { at: now().toISOString(), status: 500, body: { error: e.message } };
      }
    }

    // ---- the scheduled work: scan when due, otherwise just watch exits
    const s = store.state.settings;
    if ((s.autoRun || s.autopilot) && !ticked) {
      const last = store.state.meta.lastTickAt;
      const due = !last || now().getTime() - new Date(last).getTime() >= s.tickMinutes * 60000 - 120000; // 2 min slack for cron jitter
      if (due) await engine.tick();
      else await engine.exitCheck();
    }
    store.state.equity = thin(store.state.equity);

    // ---- publish: the screens read this (never the raw state)
    const st = await app.status();
    const view = {
      v: 1, at: now().toISOString(), status: st,
      trades: store.state.trades.slice(-1000),
      signals: store.state.signals.slice(-100),
      log: store.state.log.slice(-150),
      performance: { stocks: await app.performance('stocks').catch(() => null), crypto: await app.performance('crypto').catch(() => null) },
    };
    store.save();

    // ---- write only what changed, so quiet runs make no commit
    const stateStr = JSON.stringify(store.state);
    if (stateStr !== prevStateStr) writeJson(path.join(dir, 'state.enc.json'), await S.seal(store.state, keys));
    const strip = (v) => JSON.stringify({ ...v, at: 0 });
    const stale = !prevView || now().getTime() - new Date(prevView.at).getTime() > 50 * 60000;
    if (!prevView || strip(prevView) !== strip(view) || stale) writeJson(path.join(dir, 'view.enc.json'), await S.seal(view, keys));
    const keep = {};
    const all = { ...prevResults, ...results };
    for (const [id, r] of Object.entries(all)) if (now().getTime() - new Date(r.at).getTime() < 86400e3) keep[id] = r;
    const ids = Object.keys(keep).sort((a, b) => keep[a].at.localeCompare(keep[b].at)).slice(-12);
    const trimmed = Object.fromEntries(ids.map((i) => [i, keep[i]]));
    if (Object.keys(results).length || JSON.stringify(Object.keys(prevResults)) !== JSON.stringify(ids)) writeJson(path.join(dir, 'results.enc.json'), await S.seal(trimmed, keys));
    writeJson(path.join(dir, 'meta.json'), meta);
    for (const f of processed) fs.rmSync(f, { force: true });
    log(`run ok: ${counts.commands} command(s), ${counts.rejected} ignored`);
    return { counts, view };
  } finally {
    app.server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { runOnce, mergeEnv, makeActions, thin };

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: node scripts/run-once.js <state-dir>'); process.exit(2); }
  // Keep the public Actions log boring: no symbols, balances or amounts.
  runOnce({ dir: path.resolve(dir), log: (m) => console.log(m) }).catch((e) => { console.error('run failed:', e.message.replace(/[A-Za-z0-9_\-]{24,}/g, '***')); process.exit(1); });
}
