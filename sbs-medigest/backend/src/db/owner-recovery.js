// Récupération du compte propriétaire (procédure « bris de glace ») — voir docs/RECUPERATION-PROPRIETAIRE.md
//
//   docker compose run --rm -e AUDIT_HMAC_KEY migrate \
//     node src/db/owner-recovery.js --username admin --reason "Téléphone 2FA perdu, identité vérifiée par …" \
//       --confirm "RECUPERER admin"
//
// Nécessite les identifiants propriétaire du schéma (service « migrate », jamais l'application)
// et la clé HMAC du journal (la récupération est journalisée et signée comme toute action).
// Effets, dans une seule transaction :
//   - nouveau mot de passe temporaire (affiché UNE fois sur le terminal, changement imposé),
//   - double authentification désactivée et codes de récupération supprimés
//     (reconfiguration imposée à la connexion suivante lorsque la 2FA est obligatoire),
//   - verrouillage levé, toutes les sessions du compte révoquées,
//   - entrée d'audit « auth.owner_recovery » signée + alerte de sécurité haute.
import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'node:url';
import { ownerTx, ownerPool } from './pool.js';
import { temporaryPassword } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';
import { raiseAlert } from '../lib/notify.js';
import { makeContext } from '../lib/realtime.js';
import { requireAuditKey } from '../config.js';

export async function recoverOwner({ username, reason, operator = 'console', password = temporaryPassword() }) {
  if (!username) throw new Error('--username requis');
  if (!reason || reason.trim().length < 10) throw new Error('--reason requis (10 caractères minimum : circonstances et vérification d\'identité)');
  requireAuditKey(); // la trace doit être signée : refus sans la clé du journal
  const hash = await bcrypt.hash(password, 12);
  await ownerTx(async (db) => {
    await db.query(`SELECT set_config('sbs.context', 'system', true)`);
    const { rows: [u] } = await db.query(
      `SELECT u.id, u.username, u.first_name || ' ' || u.last_name AS full_name, r.is_superadmin
       FROM users u JOIN roles r ON r.id = u.role_id WHERE lower(u.username) = lower($1) FOR UPDATE OF u`, [username]);
    if (!u) throw new Error(`Compte « ${username} » introuvable`);
    if (!u.is_superadmin) throw new Error('Cette procédure est réservée au compte propriétaire (super-administrateur)');
    await db.query(
      `UPDATE users SET password_hash = $2, must_change_password = TRUE, status = 'active', failed_attempts = 0,
         locked_until = NULL, updated_at = now() WHERE id = $1`, [u.id, hash]);
    await db.query(
      `UPDATE user_mfa SET secret_enc = NULL, pending_secret_enc = NULL, pending_created_at = NULL, enabled_at = NULL,
         last_step = NULL, updated_at = now() WHERE user_id = $1`, [u.id]);
    await db.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [u.id]);
    await db.query(`UPDATE mfa_challenges SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL`, [u.id]);
    await db.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [u.id]);
    const ctx = makeContext({ deferred: false });
    await audit(db, ctx, {
      action: 'auth.owner_recovery', entityType: 'user', entityId: u.id, username: `procédure de récupération (${operator})`,
      summary: `Récupération du compte propriétaire « ${u.username} » : mot de passe réinitialisé, 2FA à reconfigurer, sessions révoquées`,
      reason, feed: false,
    });
    await raiseAlert(db, ctx, {
      category: 'systeme', type: 'recuperation_proprietaire', severity: 'haute',
      title: `Récupération du compte propriétaire « ${u.username} »`,
      details: { message: `Procédure hors ligne exécutée (${operator}). Motif : ${reason}` }, refType: 'user', refId: u.id, userId: u.id,
    });
  });
  return { password };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
  const username = arg('--username');
  const confirmText = `RECUPERER ${username}`;
  if (arg('--confirm') !== confirmText) {
    console.error(`Confirmation requise : ajoutez --confirm "${confirmText}"`);
    process.exit(2);
  }
  try {
    const { password } = await recoverOwner({ username, reason: arg('--reason'), operator: arg('--operator') || process.env.USER || 'console' });
    // Affiché une seule fois sur le terminal de l'opérateur (conteneur --rm : aucun journal conservé)
    console.log(`✔ Compte « ${username} » récupéré. Mot de passe temporaire : ${password}`);
    console.log('  Changement imposé à la connexion ; la double authentification devra être reconfigurée.');
  } catch (e) {
    console.error(`✖ ${e.message}`);
    process.exitCode = 1;
  } finally {
    await ownerPool.end();
  }
}
