// Double authentification TOTP (RFC 6238, HMAC-SHA1, 6 chiffres, pas de 30 s),
// compatible avec les applications d'authentification courantes. Aucune dépendance.
import crypto from 'node:crypto';
import { config } from '../config.js';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_STEP = 30;
export const TOTP_DIGITS = 6;

export function base32Encode(buf) {
  let bits = 0; let value = 0; let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0; let value = 0; const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('Secret base32 invalide');
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** Nouveau secret aléatoire (160 bits), encodé en base32. */
export const generateSecret = () => base32Encode(crypto.randomBytes(20));

export function hotp(secretB32, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secretB32)).update(buf).digest();
  const off = h[h.length - 1] & 0xf;
  const code = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(code % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

export const currentStep = (now = Date.now()) => Math.floor(now / 1000 / TOTP_STEP);

export function totp(secretB32, now = Date.now()) {
  return hotp(secretB32, currentStep(now));
}

/**
 * Vérifie un code (tolérance ±1 pas pour la dérive d'horloge).
 * Retourne le pas accepté, ou null. Un pas ≤ lastStep est refusé (anti-rejeu).
 */
export function verifyTotp(secretB32, code, { lastStep = null, window = 1, now = Date.now() } = {}) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const step = currentStep(now);
  for (let w = -window; w <= window; w++) {
    const s = step + w;
    if (lastStep !== null && s <= Number(lastStep)) continue;
    const expected = Buffer.from(hotp(secretB32, s));
    if (crypto.timingSafeEqual(expected, Buffer.from(c))) return s;
  }
  return null;
}

/** URI otpauth:// à saisir (ou scanner) dans l'application d'authentification. */
export function otpauthUri({ secret, account, issuer = 'SBS MediGest' }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP}`;
}

// ------------------------------------------------------------ Codes de récupération
const RC_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const recoveryKey = () => crypto.createHmac('sha256', config.dataKey).update('sbs-mfa-recovery-v1').digest();

export const normalizeRecoveryCode = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Empreinte d'un code de récupération (HMAC avec une clé dérivée, hors base). */
export const hashRecoveryCode = (code) => crypto.createHmac('sha256', recoveryKey()).update(normalizeRecoveryCode(code)).digest('hex');

/** Codes de récupération à usage unique : 10 caractères (≈ 50 bits), format XXXXX-XXXXX. */
export function generateRecoveryCodes(n = 10) {
  return Array.from({ length: n }, () => {
    const bytes = crypto.randomBytes(10);
    const s = [...bytes].map((b) => RC_ALPHABET[b % RC_ALPHABET.length]).join('');
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}
