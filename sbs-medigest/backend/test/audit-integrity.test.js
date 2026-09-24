import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, adminAgent, employee, pool, ownerPool, closePools } from './helpers.js';

let admin;
before(async () => {
  await resetDb();
  admin = await adminAgent();
  await employee(admin, 'caissier', 'caissier01');
  await admin.post('/api/patients').send({ first_name: 'A', last_name: 'B' });
});
after(async () => { await closePools(); });

const verify = async () => (await admin.get('/api/audit/verify')).body;
const someId = async () => (await pool.query('SELECT min(id) + 3 AS id FROM audit_log')).rows[0].id;

test('rôle applicatif : aucune modification, suppression ou vidage du journal', async () => {
  const id = await someId();
  await assert.rejects(pool.query(`UPDATE audit_log SET summary = 'x' WHERE id = $1`, [id]), (e) => e.code === '42501');
  await assert.rejects(pool.query('DELETE FROM audit_log WHERE id = $1', [id]), (e) => e.code === '42501');
  await assert.rejects(pool.query('TRUNCATE audit_log'), (e) => e.code === '42501');
  await assert.rejects(pool.query(`UPDATE audit_signatures SET sig = 'x'`), (e) => e.code === '42501');
  await assert.rejects(pool.query('DELETE FROM audit_signatures'), (e) => e.code === '42501');
});

test('rôle applicatif : impossible de désactiver les protections ou de changer la structure', async () => {
  await assert.rejects(pool.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update'), (e) => e.code === '42501');
  await assert.rejects(pool.query('DROP TRIGGER audit_log_chain ON audit_log'), (e) => e.code === '42501');
  await assert.rejects(pool.query('DROP TABLE audit_log'), (e) => e.code === '42501');
  await assert.rejects(pool.query('CREATE TABLE evil (x int)'), (e) => e.code === '42501');
  await assert.rejects(pool.query(`CREATE OR REPLACE FUNCTION audit_row_hash(r audit_log) RETURNS text LANGUAGE sql AS $$ SELECT 'x' $$`), (e) => e.code === '42501');
  // usurpation du contexte « system » réservé au propriétaire du schéma
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('sbs.context', 'system', true)`);
    await assert.rejects(c.query(`INSERT INTO role_permissions (role_id, permission_code) VALUES (2, 'audit.view')`), (e) => e.code === '42501');
    await c.query('ROLLBACK');
  } finally { c.release(); }
  assert.equal((await verify()).ok, true);
});

test('insertion falsifiée directe (sans clé HMAC) : détectée', async () => {
  await pool.query(`INSERT INTO audit_log (user_id, action, summary) VALUES (1, 'payment.cancel', 'fausse entrée')`);
  const v = await verify();
  assert.equal(v.ok, false);
  assert.equal(v.signature_missing_ids.length, 1);
});

test('réécriture avec les droits propriétaire + recalcul complet de la chaîne : détectée par les signatures', async () => {
  const id = await someId();
  const c = await ownerPool.connect();
  try {
    await c.query('BEGIN');
    await c.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update');
    await c.query(`UPDATE audit_log SET summary = 'RÉÉCRIT' WHERE id = $1`, [id]);
    // l'attaquant recalcule toute la chaîne avec la fonction publique
    await c.query(`DO $$ DECLARE r audit_log; prev text := NULL; BEGIN
      FOR r IN SELECT * FROM audit_log ORDER BY id LOOP
        r.prev_hash := prev; r.hash := audit_row_hash(r);
        UPDATE audit_log SET prev_hash = r.prev_hash, hash = r.hash WHERE id = r.id; prev := r.hash;
      END LOOP; END $$`);
    await c.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update');
    await c.query('COMMIT');
  } finally { c.release(); }
  const v = await verify();
  assert.equal(v.ok, false);
  assert.equal(v.chain_broken_ids.length, 0, 'la chaîne recalculée paraît cohérente…');
  assert.ok(v.signature_invalid_ids.includes(Number(id)), '…mais la signature HMAC révèle la réécriture');
});

test('l\'application refuse de s\'exécuter avec le rôle propriétaire en production (garde-fou)', async () => {
  const { rows: [r] } = await pool.query(
    `SELECT pg_has_role(current_user, (SELECT tableowner FROM pg_tables WHERE tablename = 'audit_log'), 'MEMBER') AS owner, current_user`);
  assert.equal(r.owner, false);
  assert.equal(r.current_user, 'sbs_app');
});
