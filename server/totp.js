'use strict';
// Time-based one-time passwords (RFC 6238) for Google Authenticator, 1Password, Authy and similar apps.
const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) out += ALPHABET[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}

function base32Decode(str) {
  let bits = '';
  for (const ch of str.replace(/=+$/, '').replace(/\s/g, '').toUpperCase()) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new Error('invalid base32');
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function hotp(secretBuf, counter, digits = 6) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', secretBuf).update(msg).digest();
  const off = h[h.length - 1] & 0xf;
  const code = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(code % 10 ** digits).padStart(digits, '0');
}

// Returns the matching time step (so the caller can refuse to accept the same code twice), or null.
function verifyTotp(secretB32, code, now = Date.now(), window = 1) {
  if (!/^\d{6}$/.test(String(code))) return null;
  const secret = base32Decode(secretB32);
  const step = Math.floor(now / 30000);
  for (let w = -window; w <= window; w++) {
    const a = Buffer.from(hotp(secret, step + w));
    const b = Buffer.from(String(code));
    if (crypto.timingSafeEqual(a, b)) return step + w;
  }
  return null;
}

function newSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function otpauthUri(secret, account, issuer = 'AI Trader') {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=6&period=30`;
}

module.exports = { base32Encode, base32Decode, hotp, verifyTotp, newSecret, otpauthUri };
