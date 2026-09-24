// Phase 4 (N-1) : séparation de la clé HMAC du journal d'audit et des identifiants de migration.
// Le service « migrate » (propriétaire du schéma) ne reçoit plus ni la clé HMAC ni la clé de
// chiffrement médical ; l'application, seule détentrice des clés, refuse de démarrer sans elles.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resetDb, adminAgent, pool, ownerPool, closePools } from './helpers.js';
import { config } from '../src/config.js';

const compose = fs.readFileSync(new URL('../../docker-compose.yml', import.meta.url), 'utf8');
/** Bloc YAML d'un service (jusqu'au service suivant). */
const service = (name) => {
  const m = compose.match(new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z_]+:\\n|\\nvolumes:)`));
  assert.ok(m, `service ${name}`);
  return m[1];
};
const withoutKeys = () => {
  const env = { ...process.env };
  delete env.AUDIT_HMAC_KEY; delete env.DATA_ENCRYPTION_KEY;
  return env;
};

before(async () => { await resetDb(); });
after(async () => { await closePools(); });

test('configuration Docker : seul le service applicatif détient la clé HMAC et la clé médicale', () => {
  const app = service('app'); const migrate = service('migrate'); const backup = service('backup'); const caddy = service('caddy'); const db = service('db');
  assert.match(app, /AUDIT_HMAC_KEY:/); assert.match(app, /DATA_ENCRYPTION_KEY:/);
  for (const [name, block] of Object.entries({ migrate, backup, caddy, db })) {
    assert.doesNotMatch(block, /AUDIT_HMAC_KEY:/, `${name} ne doit pas recevoir AUDIT_HMAC_KEY`);
    assert.doesNotMatch(block, /DATA_ENCRYPTION_KEY:/, `${name} ne doit pas recevoir DATA_ENCRYPTION_KEY`);
  }
  // à l'inverse, l'application ne reçoit pas les identifiants propriétaire
  assert.doesNotMatch(app, /MIGRATION_DATABASE_URL/);
  assert.match(migrate, /MIGRATION_DATABASE_URL/);
});

test('migrations + initialisation en mode production SANS clé HMAC ni clé médicale : réussies', async () => {
  await ownerPool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const script = `
    const { migrate } = await import('./src/db/migrate.js');
    const { seed } = await import('./src/db/seed.js');
    const { ownerPool } = await import('./src/db/pool.js');
    await migrate({ log: () => {} }); await seed({ log: () => {} }); await ownerPool.end();`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...withoutKeys(), NODE_ENV: 'production' }, timeout: 120000 });
  assert.equal(r.status, 0, r.stderr);
  const { rows: [m] } = await pool.query(`SELECT value FROM settings WHERE key = 'deployment'`);
  assert.equal(m.value.mode, 'production', 'base marquée production par le service de migration');
  await resetDb(); // base de test neuve pour la suite
});

test('l\'application refuse de démarrer sans ses clés (production)', () => {
  const script = `const m = await import('./src/config.js'); m.requireRuntimeKeys();`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...withoutKeys(), NODE_ENV: 'production' } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /DATA_ENCRYPTION_KEY|AUDIT_HMAC_KEY/);
  const ok = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production', AUDIT_HMAC_KEY: 'A'.repeat(43) + '=', DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') } });
  assert.equal(ok.status, 0, ok.stderr);
});

test('les clés ne sont jamais sérialisées avec la configuration (journaux)', () => {
  const dump = JSON.stringify(config);
  assert.ok(!/dataKey|auditKey/.test(dump));
  assert.equal(config.auditKey.length >= 32, true, 'accès explicite toujours possible pour l\'application');
});

test('rôle applicatif : ni modification ni suppression du journal et des signatures (y compris lectures médicales)', async () => {
  const admin = await adminAgent();
  await admin.get('/api/patients');
  const { rows: [last] } = await pool.query('SELECT id FROM audit_log ORDER BY id DESC LIMIT 1');
  for (const sql of [
    'UPDATE audit_log SET summary = $1 WHERE id = $2', 'DELETE FROM audit_log WHERE id = $2 AND $1::text IS NOT NULL',
    'UPDATE audit_signatures SET sig = $1 WHERE audit_id = $2', 'DELETE FROM audit_signatures WHERE audit_id = $2 AND $1::text IS NOT NULL',
  ]) await assert.rejects(pool.query(sql, ['x', last.id]), undefined, sql);
  for (const sql of ['TRUNCATE audit_log', 'TRUNCATE audit_signatures', 'ALTER TABLE audit_log DISABLE TRIGGER USER', 'DROP TRIGGER audit_log_no_update ON audit_log']) {
    await assert.rejects(pool.query(sql), undefined, sql);
  }
  const { rows: [p] } = await pool.query(`SELECT has_table_privilege('audit_log', 'UPDATE') AS u, has_table_privilege('audit_log', 'DELETE') AS d,
    has_table_privilege('audit_signatures', 'UPDATE') AS su, has_table_privilege('audit_signatures', 'DELETE') AS sd`);
  assert.deepEqual(p, { u: false, d: false, su: false, sd: false });
});

test('droits propriétaire sans la clé HMAC : une réécriture du journal reste détectée', async () => {
  const admin = await adminAgent();
  const { rows: [row] } = await pool.query('SELECT id FROM audit_log ORDER BY id LIMIT 1');
  const c = await ownerPool.connect();
  try {
    await c.query('BEGIN');
    await c.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update');
    await c.query(`UPDATE audit_log SET summary = 'réécrit' WHERE id = $1`, [row.id]);
    await c.query('UPDATE audit_log SET hash = audit_row_hash(audit_log) WHERE id = $1', [row.id]);
    await c.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update');
    await c.query('COMMIT');
  } finally { c.release(); }
  const v = (await admin.get('/api/audit/verify')).body;
  assert.equal(v.ok, false);
  assert.ok(v.broken_ids.includes(Number(row.id)));
});
