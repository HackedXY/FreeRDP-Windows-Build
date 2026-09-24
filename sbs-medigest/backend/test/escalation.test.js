import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, adminAgent, employee, login, pool, closePools } from './helpers.js';

let admin, hr, rolesMgr, cashier, owner;
let roles = [];
const roleId = (code) => roles.find((r) => r.code === code).id;

before(async () => {
  await resetDb();
  admin = await adminAgent();
  owner = (await admin.get('/api/auth/me')).body.user;
  // Rôles délégués créés par le propriétaire
  assert.equal((await admin.post('/api/roles').send({ name: 'RH', permissions: ['users.view', 'users.manage', 'patients.view', 'payments.view', 'payments.create', 'cash.operate', 'expenses.view', 'expenses.create', 'expenses.disburse', 'appointments.view', 'patients.create'] })).status, 201);
  assert.equal((await admin.post('/api/roles').send({ name: 'Gestion roles', permissions: ['roles.manage', 'users.view'] })).status, 201);
  roles = (await admin.get('/api/roles')).body;
  hr = await employee(admin, 'rh', 'rh01');
  rolesMgr = await employee(admin, 'gestion_roles', 'roles01');
  cashier = await employee(admin, 'caissier', 'caissier01');
});
after(async () => { await closePools(); });

async function overridesOf(userId) {
  const { rows } = await pool.query('SELECT permission_code, granted FROM user_permissions WHERE user_id = $1', [userId]);
  return rows;
}

test('RH : ne peut pas s\'accorder de permissions', async () => {
  const r = await hr.put(`/api/users/${hr.user.id}`).send({ permission_overrides: [{ permission_code: 'audit.view', granted: true }] });
  assert.equal(r.status, 403);
  assert.deepEqual(await overridesOf(hr.user.id), []);
  assert.equal((await hr.get('/api/audit')).status, 403);
  const alerts = (await admin.get('/api/alerts?type=tentative_escalade')).body.items;
  assert.ok(alerts.some((a) => a.user_id === hr.user.id));
  const log = (await admin.get('/api/audit?action=security.escalation_denied')).body.items;
  assert.ok(log.length >= 1);
});

test('RH : ne peut pas changer son propre rôle ni son statut', async () => {
  assert.equal((await hr.put(`/api/users/${hr.user.id}`).send({ role_id: roleId('admin') })).status, 403);
  assert.equal((await hr.put(`/api/users/${hr.user.id}`).send({ role_id: roleId('caissier') })).status, 403);
  const { rows: [u] } = await pool.query('SELECT role_id FROM users WHERE id = $1', [hr.user.id]);
  assert.equal(u.role_id, roleId('rh'));
  // modifier ses coordonnées reste possible
  assert.equal((await hr.put(`/api/users/${hr.user.id}`).send({ phone: '620000009' })).status, 200);
});

test('RH : ne peut pas accorder de permissions individuelles à un autre employé', async () => {
  const r = await hr.put(`/api/users/${cashier.user.id}`).send({ permission_overrides: [{ permission_code: 'payments.refund', granted: true }] });
  assert.equal(r.status, 403);
  assert.deepEqual(await overridesOf(cashier.user.id), []);
  const c = await hr.post('/api/users').send({ first_name: 'A', last_name: 'B', username: 'with.override', role_id: roleId('caissier'), permission_overrides: [{ permission_code: 'audit.view', granted: true }] });
  assert.equal(c.status, 403);
});

test('RH : ne peut pas créer de compte administrateur ni de compte privilégié', async () => {
  assert.equal((await hr.post('/api/users').send({ first_name: 'X', last_name: 'Y', username: 'shadow.admin', role_id: roleId('admin') })).status, 403);
  assert.equal((await hr.post('/api/users').send({ first_name: 'X', last_name: 'Y', username: 'shadow.rh', role_id: roleId('rh') })).status, 403);
  // Rôle contenant des droits que RH n'a pas (médecin)
  assert.equal((await hr.post('/api/users').send({ first_name: 'X', last_name: 'Y', username: 'shadow.doc', role_id: roleId('medecin') })).status, 403);
  const { rows } = await pool.query(`SELECT count(*)::int n FROM users WHERE username LIKE 'shadow.%'`);
  assert.equal(rows[0].n, 0);
  // Rôle opérationnel dont RH détient toutes les permissions : autorisé
  assert.equal((await hr.post('/api/users').send({ first_name: 'Nouveau', last_name: 'Caissier', username: 'caissier02', role_id: roleId('caissier') })).status, 201);
});

test('RH : ne peut pas réinitialiser le mot de passe du propriétaire ni gérer un compte privilégié', async () => {
  assert.equal((await hr.post(`/api/users/${owner.id}/reset-password`)).status, 403);
  assert.equal((await hr.put(`/api/users/${owner.id}`).send({ status: 'disabled' })).status, 403);
  assert.equal((await hr.put(`/api/users/${owner.id}`).send({ username: 'pirate' })).status, 403);
  assert.equal((await hr.post(`/api/users/${owner.id}/unlock`)).status, 403);
  assert.equal((await hr.post(`/api/users/${rolesMgr.user.id}/reset-password`)).status, 403);
  // Le propriétaire peut toujours se connecter avec son mot de passe
  assert.equal((await login('admin', 'Proprietaire2026')).loginRes.status, 200);
  // RH peut gérer un employé non privilégié dont il détient tous les droits
  assert.equal((await hr.post(`/api/users/${cashier.user.id}/reset-password`)).status, 200);
});

test('Gestionnaire de rôles : ne peut ni élever ses droits ni modifier de rôle', async () => {
  const mine = roles.find((r) => r.code === 'gestion_roles');
  const r = await rolesMgr.put(`/api/roles/${mine.id}`).send({ name: 'Gestion roles', permissions: ['roles.manage', 'users.view', 'audit.view', 'settings.manage'] });
  assert.equal(r.status, 403);
  const { rows } = await pool.query('SELECT permission_code FROM role_permissions WHERE role_id = $1 ORDER BY 1', [mine.id]);
  assert.deepEqual(rows.map((x) => x.permission_code), ['roles.manage', 'users.view']);
  assert.equal((await rolesMgr.post('/api/roles').send({ name: 'Super', permissions: ['audit.view'] })).status, 403);
  assert.equal((await rolesMgr.put(`/api/roles/${roleId('caissier')}`).send({ name: 'Caissier', permissions: ['payments.refund'] })).status, 403);
  assert.equal((await rolesMgr.delete(`/api/roles/${roleId('caissier')}`)).status, 403);
});

test('Propriétaire : conserve tous les pouvoirs mais ne peut pas changer son propre rôle', async () => {
  assert.equal((await admin.put(`/api/users/${cashier.user.id}`).send({ permission_overrides: [{ permission_code: 'payments.refund', granted: true }] })).status, 200);
  assert.equal((await admin.post('/api/users').send({ first_name: 'Co', last_name: 'Gerant', username: 'cogerant', role_id: roleId('admin') })).status, 201);
  assert.equal((await admin.put(`/api/users/${owner.id}`).send({ role_id: roleId('caissier') })).status, 403);
});

test('Base de données : les triggers bloquent une escalade même si l\'API était contournée', async () => {
  const c = await pool.connect();
  const attempt = async (sql, params, actor) => {
    await c.query('BEGIN');
    try {
      if (actor !== undefined) await c.query(`SELECT set_config('sbs.actor_id', $1, true)`, [String(actor)]);
      await c.query(sql, params);
      await c.query('COMMIT');
      return 'ok';
    } catch (e) { await c.query('ROLLBACK'); return e.code; }
  };
  try {
    // Sans utilisateur agissant, ou avec un utilisateur non propriétaire
    assert.equal(await attempt('INSERT INTO user_permissions (user_id, permission_code, granted) VALUES ($1, $2, TRUE)', [hr.user.id, 'audit.view']), '42501');
    assert.equal(await attempt('INSERT INTO user_permissions (user_id, permission_code, granted) VALUES ($1, $2, TRUE)', [hr.user.id, 'audit.view'], hr.user.id), '42501');
    assert.equal(await attempt('INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, $2)', [roleId('rh'), 'audit.view'], hr.user.id), '42501');
    assert.equal(await attempt('UPDATE users SET role_id = $1 WHERE id = $2', [roleId('admin'), cashier.user.id], hr.user.id), '42501');
    assert.equal(await attempt('UPDATE users SET role_id = $1 WHERE id = $2', [roleId('caissier'), hr.user.id], hr.user.id), '42501');
    assert.equal(await attempt(`UPDATE users SET password_hash = 'x' WHERE id = $1`, [owner.id], hr.user.id), '42501');
    assert.equal(await attempt(`UPDATE users SET status = 'disabled' WHERE id = $1`, [owner.id]), '42501');
    // Contexte « system » usurpé : refusé si la connexion n'est pas le propriétaire du schéma
    // (la connexion de test est ici le propriétaire ; la séparation des rôles est testée dans audit-integrity)
    // Le propriétaire (super-admin) peut
    assert.equal(await attempt('INSERT INTO user_permissions (user_id, permission_code, granted) VALUES ($1, $2, FALSE)', [hr.user.id, 'payments.view'], owner.id), 'ok');
  } finally { c.release(); }
});
