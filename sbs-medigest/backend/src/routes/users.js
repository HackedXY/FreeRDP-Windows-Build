import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { query, tx } from '../db/pool.js';
import { ah, parse, badRequest, notFound, conflict } from '../lib/errors.js';
import { requirePerm } from '../lib/auth.js';
import { audit, diff } from '../lib/audit.js';
import { raiseAlert } from '../lib/notify.js';
import { temporaryPassword } from '../lib/crypto.js';
import { nextNumber } from '../lib/numbering.js';
import { PERMISSION_CODES } from '../lib/permissions.js';
import { disconnectUser, refreshRealtime } from '../lib/realtime.js';
import { checkPasswordPolicy, BCRYPT_ROUNDS } from './auth.js';
import { setActor, roleInfo, isPrivilegedRole, targetProfile, denyEscalation } from '../lib/privilege.js';

const router = Router();

const USER_COLUMNS = `u.id, u.employee_number, u.first_name, u.last_name, u.phone, u.email, u.job_title, u.professional_id,
  u.username, u.status, u.must_change_password, u.last_login_at, u.created_at, u.updated_at, u.site_id,
  u.locked_until, r.id AS role_id, r.name AS role_name, r.code AS role_code`;

async function getUser(db, id) {
  const { rows } = await db.query(`SELECT ${USER_COLUMNS} FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`, [id]);
  if (!rows[0]) throw notFound('Employé introuvable');
  const { rows: overrides } = await db.query('SELECT permission_code, granted FROM user_permissions WHERE user_id = $1', [id]);
  return { ...rows[0], permission_overrides: overrides };
}

const overridesSchema = z.array(z.object({
  permission_code: z.enum(PERMISSION_CODES),
  granted: z.boolean(),
})).optional();

const userSchema = z.object({
  first_name: z.string().trim().min(1).max(100),
  last_name: z.string().trim().min(1).max(100),
  phone: z.string().trim().max(30).optional().nullable(),
  email: z.string().trim().email().max(150).optional().nullable().or(z.literal('')),
  job_title: z.string().trim().max(100).optional().nullable(),
  // n° d'inscription à l'Ordre / autorisation d'exercice (imprimé sur ordonnances et certificats)
  professional_id: z.string().trim().max(60).optional().nullable(),
  role_id: z.coerce.number().int().positive(),
  username: z.string().trim().min(3).max(50).regex(/^[a-zA-Z0-9._-]+$/, 'lettres, chiffres, . _ - uniquement'),
  password: z.string().max(200).optional().nullable(),
  status: z.enum(['active', 'disabled']).optional(),
  permission_overrides: overridesSchema,
});

async function saveOverrides(db, userId, overrides) {
  await db.query('DELETE FROM user_permissions WHERE user_id = $1', [userId]);
  for (const o of overrides) {
    await db.query('INSERT INTO user_permissions (user_id, permission_code, granted) VALUES ($1,$2,$3)', [userId, o.permission_code, o.granted]);
  }
}

router.get('/', requirePerm('users.view', 'users.manage', 'reports.employee'), ah(async (req, res) => {
  const { rows } = await query(
    `SELECT ${USER_COLUMNS},
       (SELECT max(created_at) FROM login_events le WHERE le.user_id = u.id AND le.event = 'login') AS last_login
     FROM users u JOIN roles r ON r.id = u.role_id
     ORDER BY u.status, u.last_name, u.first_name`,
  );
  res.json(rows);
}));

// Annuaire minimal des praticiens (pour les sélecteurs médecin), accessible à tout utilisateur connecté
router.get('/directory/doctors', ah(async (_req, res) => {
  const { rows } = await query(
    `SELECT u.id, u.first_name || ' ' || u.last_name AS name, u.job_title FROM users u JOIN roles r ON r.id = u.role_id
     WHERE u.status = 'active' AND (r.code = 'medecin' OR EXISTS (
       SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_code = 'consultations.diagnose'))
     ORDER BY u.last_name`);
  res.json(rows);
}));

router.get('/:id', requirePerm('users.view', 'users.manage'), ah(async (req, res) => {
  res.json(await getUser({ query }, Number(req.params.id)));
}));

/**
 * Règles d'administration des comptes (le propriétaire = super-administrateur) :
 *  - seul le propriétaire accorde/retire des permissions individuelles ;
 *  - seul le propriétaire attribue un rôle privilégié (administrateur ou
 *    contenant une permission à haut privilège) ;
 *  - seul le propriétaire gère un compte privilégié, ou un compte disposant de
 *    permissions que le gestionnaire ne possède pas lui-même ;
 *  - personne ne modifie son propre rôle, ses propres permissions ni son statut.
 */
async function assertCanManageTarget(req, target, what) {
  if (req.user.superadmin) return;
  if (target.privileged) await denyEscalation(req, `${what} d'un compte privilégié`, { entityId: target.id });
  const missing = [...target.perms].filter((p) => !req.user.permissions.has(p));
  if (missing.length) await denyEscalation(req, `${what} d'un compte disposant de droits que vous n'avez pas`, { entityId: target.id, attempt: { missing } });
}

router.post('/', requirePerm('users.manage'), ah(async (req, res) => {
  const data = parse(userSchema, req.body);
  if (!req.user.superadmin) {
    const role = await roleInfo({ query }, data.role_id);
    if (role && isPrivilegedRole(role)) await denyEscalation(req, `création d'un compte avec le rôle privilégié « ${role.name} »`, { attempt: { role: role.code } });
    if (role && role.permissions.some((p) => !req.user.permissions.has(p))) await denyEscalation(req, `création d'un compte avec des droits que vous n'avez pas (rôle « ${role.name} »)`, { attempt: { role: role.code } });
    if (data.permission_overrides?.length) await denyEscalation(req, 'attribution de permissions individuelles', { attempt: { permission_overrides: data.permission_overrides } });
  }
  const password = data.password || temporaryPassword();
  const policy = checkPasswordPolicy(password, data.username);
  if (policy) throw badRequest(policy);
  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const user = await tx(async (db) => {
    await setActor(db, req.user);
    const { rows: dup } = await db.query('SELECT 1 FROM users WHERE lower(username) = lower($1)', [data.username]);
    if (dup.length) throw conflict('Cet identifiant est déjà utilisé.');
    const { rows: [role] } = await db.query('SELECT id, name FROM roles WHERE id = $1', [data.role_id]);
    if (!role) throw badRequest('Rôle inconnu');
    const empNo = await nextNumber(db, 'employee', 'EMP', { yearly: false, pad: 3 });
    const { rows: [u] } = await db.query(
      `INSERT INTO users (site_id, employee_number, first_name, last_name, phone, email, job_title, role_id, username,
         password_hash, must_change_password, status, created_by, professional_id)
       VALUES ((SELECT min(id) FROM sites), $1,$2,$3,$4,$5,$6,$7,$8,$9, TRUE, $10, $11, $12) RETURNING id`,
      [empNo, data.first_name, data.last_name, data.phone || null, data.email || null, data.job_title || null,
        data.role_id, data.username, hash, data.status || 'active', req.user.id, data.professional_id || null],
    );
    if (data.permission_overrides?.length) await saveOverrides(db, u.id, data.permission_overrides);
    await audit(db, req.ctx, {
      action: 'user.create', entityType: 'user', entityId: u.id,
      summary: `Nouvel employé : ${data.first_name} ${data.last_name} (${role.name})`,
      newValue: { username: data.username, role: role.name, job_title: data.job_title, permission_overrides: data.permission_overrides || [] },
    });
    return getUser(db, u.id);
  });
  res.status(201).json({ user, temporaryPassword: password });
}));

router.put('/:id', requirePerm('users.manage'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const data = parse(userSchema.omit({ password: true }).partial(), req.body);
  const current = await getUser({ query }, id);
  const norm = (l) => JSON.stringify([...l].map((o) => `${o.permission_code}:${o.granted}`).sort());
  const overridesChange = data.permission_overrides !== undefined && norm(current.permission_overrides) !== norm(data.permission_overrides);
  const roleChange = data.role_id !== undefined && data.role_id !== current.role_id;
  const statusChange = data.status !== undefined && data.status !== current.status;
  if (id === req.user.id && (roleChange || overridesChange || statusChange)) {
    await denyEscalation(req, 'modification de son propre rôle, de ses propres permissions ou de son statut', { entityId: id, attempt: { role_id: data.role_id, permission_overrides: data.permission_overrides, status: data.status } });
  }
  if (!req.user.superadmin) {
    if (id !== req.user.id) await assertCanManageTarget(req, await targetProfile({ query }, id), 'modification');
    if (overridesChange) await denyEscalation(req, 'attribution de permissions individuelles', { entityId: id, attempt: { permission_overrides: data.permission_overrides } });
    if (roleChange) {
      const role = await roleInfo({ query }, data.role_id);
      if (role && (isPrivilegedRole(role) || role.permissions.some((p) => !req.user.permissions.has(p)))) {
        await denyEscalation(req, `attribution du rôle « ${role.name} »`, { entityId: id, attempt: { role: role.code } });
      }
    }
  }
  const user = await tx(async (db) => {
    await setActor(db, req.user);
    const before = await getUser(db, id);
    if (data.username && data.username.toLowerCase() !== before.username.toLowerCase()) {
      const { rows: dup } = await db.query('SELECT 1 FROM users WHERE lower(username) = lower($1) AND id <> $2', [data.username, id]);
      if (dup.length) throw conflict('Cet identifiant est déjà utilisé.');
    }
    const fields = ['first_name', 'last_name', 'phone', 'email', 'job_title', 'professional_id', 'role_id', 'username', 'status'];
    const sets = []; const vals = [];
    for (const f of fields) if (data[f] !== undefined) { vals.push(data[f] === '' ? null : data[f]); sets.push(`${f} = $${vals.length}`); }
    if (sets.length) {
      vals.push(id);
      await db.query(`UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length}`, vals);
    }
    const changes = diff(before, data, fields);
    const permChanged = overridesChange;
    if (permChanged) await saveOverrides(db, id, data.permission_overrides);
    if (changes || permChanged) {
      const roleChanged = changes?.newValue.role_id !== undefined;
      await audit(db, req.ctx, {
        action: permChanged || roleChanged ? 'user.permissions_change' : 'user.update', entityType: 'user', entityId: id,
        summary: `Modification de l'employé ${before.first_name} ${before.last_name}`,
        oldValue: { ...(changes?.oldValue || {}), ...(permChanged ? { permission_overrides: before.permission_overrides } : {}) },
        newValue: { ...(changes?.newValue || {}), ...(permChanged ? { permission_overrides: data.permission_overrides } : {}) },
      });
      if (permChanged || roleChanged) {
        await raiseAlert(db, req.ctx, {
          category: 'systeme', type: 'modification_sensible', severity: 'moyenne',
          title: `Droits modifiés pour ${before.first_name} ${before.last_name}`,
          details: { message: `Modifié par ${req.user.fullName}` }, refType: 'user', refId: id,
        });
      }
    }
    if (data.status === 'disabled' && before.status !== 'disabled') {
      await db.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
      await audit(db, req.ctx, { action: 'user.disable', entityType: 'user', entityId: id, summary: `Compte désactivé : ${before.first_name} ${before.last_name}` });
    }
    if (data.status === 'active' && before.status === 'disabled') {
      await db.query('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1', [id]);
      await audit(db, req.ctx, { action: 'user.enable', entityType: 'user', entityId: id, summary: `Compte réactivé : ${before.first_name} ${before.last_name}` });
    }
    return getUser(db, id);
  });
  if (user.status === 'disabled') disconnectUser(id);
  else await refreshRealtime({ userIds: [id] }); // droits réévalués avant la réponse
  res.json(user);
}));

router.post('/:id/reset-password', requirePerm('users.manage'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const target = await targetProfile({ query }, id);
  if (!target) throw notFound('Employé introuvable');
  await assertCanManageTarget(req, target, 'réinitialisation du mot de passe');
  const password = temporaryPassword();
  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  await tx(async (db) => {
    await setActor(db, req.user);
    const before = await getUser(db, id);
    await db.query(
      'UPDATE users SET password_hash = $1, must_change_password = TRUE, failed_attempts = 0, locked_until = NULL, updated_at = now() WHERE id = $2',
      [hash, id],
    );
    await db.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
    await audit(db, req.ctx, {
      action: 'user.password_reset', entityType: 'user', entityId: id,
      summary: `Réinitialisation du mot de passe de ${before.first_name} ${before.last_name}`,
    });
  });
  disconnectUser(id);
  res.json({ temporaryPassword: password });
}));

router.post('/:id/unlock', requirePerm('users.manage'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const target = await targetProfile({ query }, id);
  if (!target) throw notFound('Employé introuvable');
  await assertCanManageTarget(req, target, 'déverrouillage');
  await tx(async (db) => {
    await setActor(db, req.user);
    const u = await getUser(db, id);
    await db.query('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1', [id]);
    await audit(db, req.ctx, { action: 'user.unlock', entityType: 'user', entityId: id, summary: `Déverrouillage du compte de ${u.first_name} ${u.last_name}` });
  });
  res.json({ ok: true });
}));

// Connexions de l'employé
router.get('/:id/logins', requirePerm('users.view', 'users.manage', 'reports.employee'), ah(async (req, res) => {
  const { rows } = await query(
    `SELECT id, event, ip, user_agent, created_at FROM login_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200`,
    [Number(req.params.id)],
  );
  res.json(rows);
}));

// Historique des opérations de l'employé (journal d'audit)
router.get('/:id/activity', requirePerm('users.view', 'users.manage', 'reports.employee'), ah(async (req, res) => {
  const { rows } = await query(
    `SELECT id, action, entity_type, entity_id, summary, old_value, new_value, reason, created_at
     FROM audit_log WHERE user_id = $1 ORDER BY id DESC LIMIT 300`,
    [Number(req.params.id)],
  );
  res.json(rows);
}));

// Historique des modifications du compte lui-même
router.get('/:id/history', requirePerm('users.view', 'users.manage'), ah(async (req, res) => {
  const { rows } = await query(
    `SELECT id, username, action, summary, old_value, new_value, reason, created_at
     FROM audit_log WHERE entity_type = 'user' AND entity_id = $1 ORDER BY id DESC LIMIT 200`,
    [String(Number(req.params.id))],
  );
  res.json(rows);
}));

export default router;
