// Signe (HMAC) les entrées d'audit antérieures à l'introduction des signatures.
import { signAuditHash, auditKeyId } from '../../lib/auditsig.js';

// La clé n'est demandée que s'il existe des entrées à signer (base antérieure aux signatures) :
// une installation neuve n'a pas besoin de fournir AUDIT_HMAC_KEY au service de migration.
export async function up(client) {
  const { rows } = await client.query(
    `SELECT a.id, a.hash FROM audit_log a LEFT JOIN audit_signatures s ON s.audit_id = a.id WHERE s.audit_id IS NULL ORDER BY a.id`);
  if (!rows.length) return;
  for (const r of rows) {
    await client.query('INSERT INTO audit_signatures (audit_id, key_id, sig) VALUES ($1,$2,$3)', [r.id, auditKeyId(), signAuditHash(r.id, r.hash)]);
  }
}
