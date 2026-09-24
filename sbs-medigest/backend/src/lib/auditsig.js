// Signature HMAC des entrées du journal d'audit. La clé (AUDIT_HMAC_KEY) est
// fournie par l'environnement, jamais stockée en base ni dans le code source.
import crypto from 'node:crypto';
import { config } from '../config.js';

export const auditKeyId = () => crypto.createHash('sha256').update(config.auditKey).digest('hex').slice(0, 12);

export function signAuditHash(id, hash) {
  return crypto.createHmac('sha256', config.auditKey).update(`${id}|${hash}`).digest('hex');
}

export function verifyAuditSig(id, hash, sig) {
  if (!sig || !hash) return false;
  const expected = Buffer.from(signAuditHash(id, hash), 'hex');
  const given = Buffer.from(sig, 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}
