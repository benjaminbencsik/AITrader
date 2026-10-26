'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../public/shared');
const { runOnce, mergeEnv, makeActions } = require('../scripts/run-once');

const ENV = { STATE_PASSPHRASE: 'a long test passphrase', DATA_PROVIDER: 'demo' };
const dirOf = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aitrader-gh-'));
const J = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
async function keysFor(dir, pass = ENV.STATE_PASSPHRASE) {
  const m = J(path.join(dir, 'meta.json'));
  return S.deriveKeys(pass, m.salt, m.iter);
}
async function enqueue(dir, cmd) {
  const keys = await keysFor(dir);
  fs.mkdirSync(path.join(dir, 'inbox'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'inbox', `${cmd.ts}-${cmd.id}.enc.json`), JSON.stringify(await S.seal(cmd, keys)));
}
const results = async (dir) => S.open(J(path.join(dir, 'results.enc.json')), await keysFor(dir));
const view = async (dir) => S.open(J(path.join(dir, 'view.enc.json')), await keysFor(dir));

test('first run creates only encrypted files; nothing readable is stored', async () => {
  const dir = dirOf();
  await runOnce({ dir, env: ENV });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['meta.json', 'state.enc.json', 'view.enc.json']);
  for (const f of ['state.enc.json', 'view.enc.json']) {
    const raw = Buffer.from(J(path.join(dir, f)).ct, 'base64').toString('latin1');
    assert.doesNotMatch(raw, /paper|settings|equity|watchlist|SPY/);
    assert.ok(!fs.readFileSync(path.join(dir, f), 'utf8').includes('watchlist'));
  }
  const v = await view(dir);
  assert.equal(v.status.settings.mode, 'paper');
  assert.ok(v.performance.stocks);
  await assert.rejects(() => runOnce({ dir, env: { ...ENV, STATE_PASSPHRASE: 'some other passphrase' } }), /does not match/);
  await assert.rejects(() => runOnce({ dir: dirOf(), env: {} }), /STATE_PASSPHRASE/);
});

test('commands queued by the app are applied, answered, and removed; foreign files are ignored', async () => {
  const dir = dirOf();
  await runOnce({ dir, env: ENV });
  await enqueue(dir, { id: 'c1', ts: Date.now(), method: 'POST', path: '/api/settings', body: { tradeDollars: 9, watchlist: ['SPY', 'KO'] } });
  await enqueue(dir, { id: 'c2', ts: Date.now() + 1, method: 'POST', path: '/api/settings', body: { tradeDollars: -4 } });
  await enqueue(dir, { id: 'c3', ts: Date.now() + 2, method: 'POST', path: '/api/login', body: { password: 'x' } }); // not an allowed action
  fs.writeFileSync(path.join(dir, 'inbox', 'evil.enc.json'), JSON.stringify({ v: 1, iv: 'AAAAAAAAAAAAAAAA', ct: 'AAAA' })); // someone without the passphrase
  const out = await runOnce({ dir, env: ENV });
  assert.equal(out.counts.rejected, 2);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'inbox')), []);
  const r = await results(dir);
  assert.equal(r.c1.body.settings.tradeDollars, 9);
  assert.deepEqual(r.c2.body.rejected, ['tradeDollars']);
  assert.equal(r.c3.status, 400);
  assert.deepEqual((await view(dir)).status.settings.watchlist, ['SPY', 'KO']);
});

test('phone buttons: a correctly signed command works once; replays, tampering and old commands are refused', async () => {
  const dir = dirOf();
  await runOnce({ dir, env: ENV });
  const keys = await keysFor(dir);
  const mk = async (cmd, { age = 0, nonce = S.nonce() } = {}) => {
    const ts = String(Math.floor(Date.now() / 1000) - age);
    return { CMD: cmd, CMD_TS: ts, CMD_NONCE: nonce, CMD_SIG: await S.sign(`${cmd}|${ts}|${nonce}`, keys) };
  };
  const ok = await mk('pause');
  await runOnce({ dir, env: { ...ENV, ...ok } });
  assert.equal((await view(dir)).status.settings.paused, true);
  // resume by hand, then replay the same signed pause: refused
  await enqueue(dir, { id: 'r', ts: Date.now(), method: 'POST', path: '/api/settings', body: { paused: false } });
  await runOnce({ dir, env: ENV });
  await runOnce({ dir, env: { ...ENV, ...ok } });
  assert.equal((await view(dir)).status.settings.paused, false, 'replay refused');
  const old = await mk('pause', { age: 13 * 3600 });
  await runOnce({ dir, env: { ...ENV, ...old } });
  assert.equal((await view(dir)).status.settings.paused, false, 'expired refused');
  const forged = { ...(await mk('flatten')), CMD: 'pause' };
  await runOnce({ dir, env: { ...ENV, ...forged } });
  assert.equal((await view(dir)).status.settings.paused, false, 'tampered refused');
});

test('scheduled runs: a scan happens when due, an idle run changes nothing on disk', async () => {
  const dir = dirOf();
  await runOnce({ dir, env: ENV });
  await enqueue(dir, { id: 's', ts: Date.now(), method: 'POST', path: '/api/settings', body: { autoRun: true, tickMinutes: 60 } });
  await runOnce({ dir, env: ENV }); // applies settings, then scans (never scanned before)
  const v1 = await view(dir);
  assert.ok(v1.status.lastScanAt, 'scanned');
  const before = fs.readFileSync(path.join(dir, 'state.enc.json'), 'utf8');
  await runOnce({ dir, env: ENV }); // not due again for an hour
  assert.equal(fs.readFileSync(path.join(dir, 'state.enc.json'), 'utf8'), before, 'quiet run leaves the state file untouched');
});

test('secrets and variables from the workflow are merged into the environment; the GitHub token is not', () => {
  const env = mergeEnv({ ALL_SECRETS: JSON.stringify({ OKX_API_KEY: 'k', github_token: 'ghs_x', EMPTY: '' }), ALL_VARS: JSON.stringify({ NTFY_SERVER: 'https://ntfy.example' }), OKX_DEMO: 'true' });
  assert.deepEqual([env.OKX_API_KEY, env.NTFY_SERVER, env.OKX_DEMO, env.github_token, env.EMPTY, env.ALL_SECRETS], ['k', 'https://ntfy.example', 'true', undefined, undefined, undefined]);
});

test('phone-alert buttons carry a fresh signed command and dispatch to the workflow', async () => {
  const dir = dirOf();
  await runOnce({ dir, env: ENV });
  const keys = await keysFor(dir);
  const header = await makeActions({ NTFY_DISPATCH_TOKEN: 'tok', GITHUB_REPOSITORY: 'me/aitrader', GITHUB_REF_NAME: 'main' }, keys, () => new Date())();
  const [a, b] = header.split('; ');
  assert.match(a, /^http, Pause, https:\/\/api\.github\.com\/repos\/me\/aitrader\/actions\/workflows\/trader\.yml\/dispatches, method=POST, headers\.Authorization=Bearer tok/);
  assert.match(b, /Sell everything/);
  const body = JSON.parse(a.match(/body='(.*)', clear/)[1]);
  assert.equal(body.ref, 'main');
  assert.equal(body.inputs.cmd, 'pause');
  assert.ok(await S.verify(`pause|${body.inputs.ts}|${body.inputs.nonce}`, body.inputs.sig, keys));
  assert.equal(makeActions({}, keys, () => new Date()), null);
});

test('static build wires the GitHub connector into the page for this repo', () => {
  const { build } = require('../scripts/build-static');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'aitrader-dist-'));
  build({ out, repo: 'me/aitrader' });
  const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  assert.ok(html.indexOf('shared.js') < html.indexOf('github.js') && html.indexOf('github.js') < html.indexOf('app.js'));
  assert.match(fs.readFileSync(path.join(out, 'config.js'), 'utf8'), /"repo":"me\/aitrader"/);
  assert.throws(() => build({ out, repo: 'nonsense' }), /GITHUB_REPOSITORY/);
});
