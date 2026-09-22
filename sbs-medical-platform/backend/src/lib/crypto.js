import crypto from 'node:crypto';
import { config } from '../config.js';

const PREFIX = 'enc:v1:';

/** Chiffre une valeur texte (AES-256-GCM). null/'' restent inchangés. */
export function encrypt(plain) {
  if (plain === null || plain === undefined || plain === '') return plain ?? null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', config.dataKey, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv, tag, ct].map((b) => b.toString('base64')).join(':');
}

export function decrypt(value) {
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) return value ?? null;
  const [iv, tag, ct] = value.slice(PREFIX.length).split(':').map((s) => Buffer.from(s, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', config.dataKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/** Mot de passe temporaire lisible : 10 caractères, contient lettres et chiffres. */
export function temporaryPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  const bytes = crypto.randomBytes(10);
  let out = '';
  for (let i = 0; i < 7; i++) out += alphabet[bytes[i] % alphabet.length];
  for (let i = 7; i < 10; i++) out += digits[bytes[i] % digits.length];
  return out;
}
