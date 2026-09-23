import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../db/pool.js';
import { ah, parse, badRequest, notFound, conflict } from '../lib/errors.js';
import { requirePerm } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { raiseAlert } from '../lib/notify.js';
import { PERMISSION_CODES, HIGH_PRIVILEGE_PERMISSIONS } from '../lib/permissions.js';
import { setActor, denyEscalation } from '../lib/privilege.js';

// Modifier un rôle revient à accorder des permissions : réservé au propriétaire,
// même pour un employé disposant de « roles.manage ».
async function ownerOnly(req, what) {
  if (!req.user.superadmin) await denyEscalation(req, what, { entityType: 'role', entityId: req.params.id ?? null, attempt: req.body || null });
}

const router = Router();

router.get('/permissions', requirePerm('users.view', 'users.manage', 'roles.manage'), ah(async (_req, res) => {
  const { rows } = await query('SELECT code, module, label, high_privilege FROM permissions ORDER BY sort_order');
  res.json(rows);
}));

router.get('/', requirePerm('users.view', 'users.manage', 'roles.manage'), ah(async (_req, res) => {
  const { rows } = await query(
    `SELECT r.*, coalesce(array_agg(rp.permission_code ORDER BY rp.permission_code) FILTER (WHERE rp.permission_code IS NOT NULL), '{}') AS permissions,
       (SELECT count(*)::int FROM users u WHERE u.role_id = r.id) AS user_count
     FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
     GROUP BY r.id ORDER BY r.is_superadmin DESC, r.name`,
  );
  res.json(rows.map((r) => ({ ...r, privileged: r.is_superadmin || r.permissions.some((p) => HIGH_PRIVILEGE_PERMISSIONS.has(p)) })));
}));

const roleSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(300).optional().nullable(),
  permissions: z.array(z.enum(PERMISSION_CODES)),
});

async function setPermissions(db, roleId, perms) {
  await db.query('DELETE FROM role_permissions WHERE role_id = $1', [roleId]);
  if (perms.length) {
    await db.query('INSERT INTO role_permissions (role_id, permission_code) SELECT $1, unnest($2::text[])', [roleId, [...new Set(perms)]]);
  }
}

router.post('/', requirePerm('roles.manage'), ah(async (req, res) => {
  await ownerOnly(req, 'création d\'un rôle');
  const data = parse(roleSchema, req.body);
  const code = data.name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const role = await tx(async (db) => {
    await setActor(db, req.user);
    const { rows: dup } = await db.query('SELECT 1 FROM roles WHERE code = $1 OR lower(name) = lower($2)', [code, data.name]);
    if (dup.length) throw conflict('Un rôle portant ce nom existe déjà.');
    const { rows: [r] } = await db.query(
      'INSERT INTO roles (code, name, description) VALUES ($1,$2,$3) RETURNING *', [code, data.name, data.description || null]);
    await setPermissions(db, r.id, data.permissions);
    await audit(db, req.ctx, {
      action: 'role.create', entityType: 'role', entityId: r.id, summary: `Création du rôle « ${data.name} »`,
      newValue: { permissions: data.permissions },
    });
    return r;
  });
  res.status(201).json(role);
}));

router.put('/:id', requirePerm('roles.manage'), ah(async (req, res) => {
  await ownerOnly(req, 'modification des permissions d\'un rôle');
  const id = Number(req.params.id);
  const data = parse(roleSchema, req.body);
  await tx(async (db) => {
    await setActor(db, req.user);
    const { rows: [before] } = await db.query(
      `SELECT r.*, coalesce(array_agg(rp.permission_code ORDER BY rp.permission_code) FILTER (WHERE rp.permission_code IS NOT NULL), '{}') AS permissions
       FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id WHERE r.id = $1 GROUP BY r.id`, [id]);
    if (!before) throw notFound('Rôle introuvable');
    if (before.is_superadmin) throw badRequest('Le rôle Administrateur dispose toujours de toutes les permissions.');
    await db.query('UPDATE roles SET name = $1, description = $2 WHERE id = $3', [data.name, data.description || null, id]);
    await setPermissions(db, id, data.permissions);
    const added = data.permissions.filter((p) => !before.permissions.includes(p));
    const removed = before.permissions.filter((p) => !data.permissions.includes(p));
    await audit(db, req.ctx, {
      action: 'role.permissions_change', entityType: 'role', entityId: id,
      summary: `Modification du rôle « ${data.name} »`,
      oldValue: { name: before.name, permissions: before.permissions },
      newValue: { name: data.name, permissions: data.permissions, added, removed },
    });
    if (added.length || removed.length) {
      await raiseAlert(db, req.ctx, {
        category: 'systeme', type: 'modification_sensible', severity: 'moyenne',
        title: `Permissions du rôle « ${data.name} » modifiées`,
        details: { message: `+${added.length} / -${removed.length} permission(s) — par ${req.user.fullName}`, added, removed },
        refType: 'role', refId: id,
      });
    }
  });
  res.json({ ok: true });
}));

router.delete('/:id', requirePerm('roles.manage'), ah(async (req, res) => {
  await ownerOnly(req, 'suppression d\'un rôle');
  const id = Number(req.params.id);
  await tx(async (db) => {
    await setActor(db, req.user);
    const { rows: [r] } = await db.query('SELECT * FROM roles WHERE id = $1', [id]);
    if (!r) throw notFound('Rôle introuvable');
    if (r.is_system) throw badRequest('Les rôles système ne peuvent pas être supprimés.');
    const { rows: [{ n }] } = await db.query('SELECT count(*)::int AS n FROM users WHERE role_id = $1', [id]);
    if (n) throw badRequest('Ce rôle est attribué à des employés : réattribuez-les d\'abord.');
    await db.query('DELETE FROM roles WHERE id = $1', [id]);
    await audit(db, req.ctx, { action: 'role.delete', entityType: 'role', entityId: id, summary: `Suppression du rôle « ${r.name} »`, oldValue: r });
  });
  res.json({ ok: true });
}));

export default router;
