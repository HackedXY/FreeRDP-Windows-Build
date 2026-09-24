import { audit } from './audit.js';

/** Utilisateurs actifs disposant d'une permission (rôle + surcharges). */
export async function usersWithPermission(db, perm) {
  const { rows } = await db.query(
    `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
     WHERE u.status = 'active' AND (
       r.is_superadmin
       OR EXISTS (SELECT 1 FROM user_permissions up WHERE up.user_id = u.id AND up.permission_code = $1 AND up.granted)
       OR (EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_code = $1)
           AND NOT EXISTS (SELECT 1 FROM user_permissions up WHERE up.user_id = u.id AND up.permission_code = $1 AND NOT up.granted))
     )`,
    [perm],
  );
  return rows.map((r) => r.id);
}

/**
 * Notification dans la plateforme pour tous les utilisateurs ayant `permission`
 * (l'auteur de l'action est exclu par défaut).
 */
export async function notify(db, ctx, { permission, type, icon, title, body = null, link = null, includeActor = false }) {
  let ids = await usersWithPermission(db, permission);
  if (!includeActor && ctx?.user) ids = ids.filter((id) => id !== ctx.user.id);
  if (!ids.length) return;
  const { rows } = await db.query(
    `INSERT INTO notifications (user_id, type, icon, title, body, link)
     SELECT unnest($1::int[]), $2, $3, $4, $5, $6 RETURNING id, user_id, created_at`,
    [ids, type, icon, title, body, link],
  );
  for (const r of rows) {
    ctx?.emit(`user:${r.user_id}`, 'notification', {
      id: r.id, type, icon, title, body, link, created_at: r.created_at,
    });
  }
}

/**
 * Crée une alerte (signal à vérifier, pas une preuve de fraude).
 * Si dedupeKey est fourni, une seule alerte ouverte par clé.
 */
export async function raiseAlert(db, ctx, {
  category, type, severity, title, details = null, refType = null, refId = null, userId = null, dedupeKey = null, link = null,
}) {
  const { rows } = await db.query(
    `INSERT INTO alerts (category, type, severity, title, details, ref_type, ref_id, user_id, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('nouvelle','en_verification')
     DO NOTHING
     RETURNING *`,
    [category, type, severity, title, details ? JSON.stringify(details) : null, refType, refId, userId, dedupeKey],
  );
  const alert = rows[0];
  if (!alert) return null;
  const icon = severity === 'haute' ? '🔴' : '🟠';
  ctx?.emit('perm:alerts.view', 'alert', alert);
  await notify(db, ctx, {
    permission: 'alerts.view', type: 'alert', icon, title, includeActor: true,
    body: details?.message || null, link: link || `/alertes?id=${alert.id}`,
  });
  await audit(db, ctx, {
    action: 'alert.raised', entityType: 'alert', entityId: alert.id,
    summary: `Alerte ${severity} : ${title}`, newValue: { type, severity, ref_type: refType, ref_id: refId },
    feed: { kind: 'alert', severity },
  });
  return alert;
}
