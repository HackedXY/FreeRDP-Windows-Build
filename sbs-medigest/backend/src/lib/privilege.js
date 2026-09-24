// Règles anti-escalade de privilèges (appliquées côté API ; la base de données
// applique les mêmes règles en dernier rempart via des triggers).
import { query } from '../db/pool.js';
import { forbidden } from './errors.js';
import { audit } from './audit.js';
import { raiseAlert } from './notify.js';
import { HIGH_PRIVILEGE_PERMISSIONS } from './permissions.js';
import { loadPermissions } from './auth.js';

/** Déclare l'utilisateur agissant pour les triggers de la transaction courante. */
export async function setActor(db, user) {
  await db.query(`SELECT set_config('sbs.actor_id', $1, true)`, [user ? String(user.id) : '']);
}

export async function roleInfo(db, roleId) {
  const { rows: [r] } = await db.query(
    `SELECT r.*, coalesce(array_agg(rp.permission_code) FILTER (WHERE rp.permission_code IS NOT NULL), '{}') AS permissions
     FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id WHERE r.id = $1 GROUP BY r.id`, [roleId]);
  return r || null;
}

export const isPrivilegedRole = (role) => !!role && (role.is_superadmin || role.permissions.some((p) => HIGH_PRIVILEGE_PERMISSIONS.has(p)));

/** Permissions effectives d'un utilisateur cible + indicateur « privilégié ». */
export async function targetProfile(db, userId) {
  const { rows: [u] } = await db.query('SELECT id, role_id, first_name, last_name FROM users WHERE id = $1', [userId]);
  if (!u) return null;
  const role = await roleInfo(db, u.role_id);
  const perms = await loadPermissions(db, u.id, role);
  const privileged = role.is_superadmin || [...perms].some((p) => HIGH_PRIVILEGE_PERMISSIONS.has(p));
  return { ...u, role, perms, privileged, superadmin: role.is_superadmin };
}

/**
 * Refuse une tentative d'escalade : trace immuable + alerte haute, puis 403.
 * Écrit hors de toute transaction applicative (qui serait annulée).
 */
export async function denyEscalation(req, what, details = {}) {
  const db = { query };
  await audit(db, req.ctx, {
    action: 'security.escalation_denied', entityType: details.entityType || 'user', entityId: details.entityId ?? null,
    summary: `Tentative d'escalade de privilèges refusée : ${what}`, newValue: details.attempt || null, feed: false,
  });
  await raiseAlert(db, req.ctx, {
    category: 'systeme', type: 'tentative_escalade', severity: 'haute',
    title: `Tentative d'escalade de privilèges — ${req.user.fullName}`,
    details: { message: what }, userId: req.user.id, refType: details.entityType || 'user', refId: details.entityId ?? null,
    dedupeKey: `escalation:${req.user.id}:${what}`,
  });
  req.ctx.flush();
  throw forbidden(`Action réservée au propriétaire : ${what}.`);
}
