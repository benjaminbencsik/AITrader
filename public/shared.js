'use strict';
// Shared by the Node runner and the browser/APK: AES-GCM sealing, command signing, and the trades CSV.
// Works with the WebCrypto API that both Node 20+ and browsers provide. Nothing here talks to the network.
(function (root, factory) {
  const api = factory(root.crypto || (typeof require === 'function' ? require('node:crypto').webcrypto : null));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AITRADER_SHARED = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (webcrypto) {
  const subtle = webcrypto.subtle;
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const b64 = (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
  const randomBytes = (n) => webcrypto.getRandomValues(new Uint8Array(n));

  // One passphrase -> a key that encrypts and a key that signs. The salt is public (it lives in meta.json).
  async function deriveKeys(passphrase, saltB64, iterations = 250000) {
    if (!passphrase || passphrase.length < 8) throw new Error('the passphrase must be at least 8 characters');
    const base = await subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveBits']);
    const bits = new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', salt: unb64(saltB64), iterations, hash: 'SHA-256' }, base, 512));
    const aes = await subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
    const mac = await subtle.importKey('raw', bits.slice(32), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    return { aes, mac };
  }
  async function seal(obj, keys) {
    const iv = randomBytes(12);
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, keys.aes, enc.encode(JSON.stringify(obj))));
    return { v: 1, iv: b64(iv), ct: b64(ct) };
  }
  async function open(sealed, keys) {
    try {
      return JSON.parse(dec.decode(await subtle.decrypt({ name: 'AES-GCM', iv: unb64(sealed.iv) }, keys.aes, unb64(sealed.ct))));
    } catch {
      throw new Error('could not decrypt: wrong passphrase, or the file is damaged');
    }
  }
  const sign = async (msg, keys) => hex(new Uint8Array(await subtle.sign('HMAC', keys.mac, enc.encode(msg))));
  async function verify(msg, sigHex, keys) {
    const want = await sign(msg, keys);
    if (want.length !== String(sigHex).length) return false;
    let d = 0;
    for (let i = 0; i < want.length; i++) d |= want.charCodeAt(i) ^ sigHex.charCodeAt(i);
    return d === 0;
  }
  const newSalt = () => b64(randomBytes(16));
  const nonce = () => hex(randomBytes(6));

  const esc = (v) => {
    const x = v == null ? '' : String(v);
    return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x;
  };
  // Every trade with real fills, fees and slippage where the broker reported them. Opens in any spreadsheet.
  function tradesToCsv(trades) {
    const cols = [
      ['opened', (t) => t.entryAt], ['closed', (t) => t.exitAt], ['symbol', (t) => t.symbol], ['class', (t) => t.assetClass || 'stocks'],
      ['mode', (t) => t.mode], ['broker', (t) => t.broker], ['strategy', (t) => t.strategy], ['status', (t) => t.status],
      ['qty', (t) => t.qty], ['signal_price', (t) => t.signalPrice], ['entry_price', (t) => t.entryPrice], ['entry_slippage_pct', (t) => (t.entrySlipPct != null ? t.entrySlipPct.toFixed(3) : '')],
      ['exit_price', (t) => t.exitPrice], ['fees_usd', (t) => t.fees], ['pnl_usd', (t) => (t.pnl != null ? t.pnl.toFixed(4) : '')], ['pnl_pct', (t) => (t.pnlPct != null ? t.pnlPct.toFixed(3) : '')],
      ['exit_reason', (t) => t.exitReason], ['price_is_estimate', (t) => (t.estimated || (t.status === 'closed' && t.exitReal === false) ? 'yes' : '')],
    ];
    return [cols.map((c) => c[0]).join(','), ...trades.map((t) => cols.map((c) => esc(c[1](t))).join(','))].join('\n') + '\n';
  }

  return { deriveKeys, seal, open, sign, verify, newSalt, nonce, tradesToCsv, b64, unb64 };
});
