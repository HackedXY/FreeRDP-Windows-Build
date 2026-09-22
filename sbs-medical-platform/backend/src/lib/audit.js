// Journal d'audit : chaque opération sensible laisse une trace immuable
// (utilisateur, date/heure, action, élément, ancienne/nouvelle valeur, motif).
// La table est en ajout seul et chaînée par hachage (voir migration).

const ACTION_LABELS = {
  'auth.login': 'Connexion',
  'auth.logout': 'Déconnexion',
  'auth.login_failed': 'Échec de connexion',
  'auth.password_changed': 'Changement de mot de passe',
  'access.denied': 'Tentative d\'accès non autorisé',
};
export const actionLabel = (a) => ACTION_LABELS[a] || a;

// Actions trop fréquentes / peu utiles pour le fil d'activité du tableau de bord
const NOT_IN_FEED = new Set(['auth.login', 'auth.logout', 'notifications.read']);

/**
 * @param db  client pg (dans une transaction) ou pool
 * @param ctx contexte (utilisateur, ip, file d'émission)
 */
export async function audit(db, ctx, {
  action, entityType = null, entityId = null, summary = null,
  oldValue = null, newValue = null, reason = null, feed = {}, username = null,
}) {
  const user = ctx?.user;
  const { rows } = await db.query(
    `INSERT INTO audit_log (user_id, username, action, entity_type, entity_id, summary,
       old_value, new_value, reason, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING id, created_at`,
    [
      user?.id ?? null, username ?? user?.username ?? null, action, entityType,
      entityId === null ? null : String(entityId), summary,
      oldValue === null ? null : JSON.stringify(oldValue),
      newValue === null ? null : JSON.stringify(newValue),
      reason, ctx?.ip ?? null, ctx?.userAgent ?? null,
    ],
  );
  if (ctx && !NOT_IN_FEED.has(action) && feed !== false) {
    ctx.emit('perm:dashboard.view', 'activity', {
      id: rows[0].id,
      at: rows[0].created_at,
      action,
      summary: summary || actionLabel(action),
      user: user ? user.fullName : (username || 'Système'),
      role: user?.roleName || null,
      ...feed,
    });
  }
  return rows[0];
}

/** Différences entre deux objets (champs listés) pour l'audit. */
export function diff(before, after, fields) {
  const oldV = {}; const newV = {};
  for (const f of fields) {
    if (after[f] === undefined) continue;
    const a = before?.[f] ?? null; const b = after[f] ?? null;
    if (JSON.stringify(a) !== JSON.stringify(b)) { oldV[f] = a; newV[f] = b; }
  }
  return Object.keys(newV).length ? { oldValue: oldV, newValue: newV } : null;
}
