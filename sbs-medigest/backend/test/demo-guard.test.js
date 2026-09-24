// Phase 4 : le jeu de démonstration ne peut jamais s'exécuter sur une base de production.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resetDb, pool, ownerPool, closePools } from './helpers.js';
import { assertDemoEnvironment, assertDemoDatabase } from '../src/db/demo-guard.js';

const runDemo = (extraEnv) => spawnSync(process.execPath, ['src/db/demo.js'], { encoding: 'utf8', env: { ...process.env, ...extraEnv }, timeout: 120000 });
const counts = async () => (await pool.query(`SELECT (SELECT count(*)::int FROM patients) AS p, (SELECT count(*)::int FROM users) AS u`)).rows[0];

before(async () => { await resetDb(); });
after(async () => { await closePools(); });

test('garde-fou applicatif : NODE_ENV=production refusé avant tout accès à la base', async () => {
  assert.throws(() => assertDemoEnvironment({ NODE_ENV: 'production' }), /production/);
  assert.doesNotThrow(() => assertDemoEnvironment({ NODE_ENV: 'development' }));
  const before = await counts();
  const r = runDemo({ NODE_ENV: 'production' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /interdites en production/);
  assert.deepEqual(await counts(), before, 'aucune donnée créée');
});

test('garde-fou base : base marquée « production » refusée ; marqueur protégé contre le rôle applicatif', async () => {
  await ownerPool.query(`INSERT INTO settings (key, value) VALUES ('deployment', '{"mode":"production"}')`);
  await assert.rejects(assertDemoDatabase(pool), /production/);
  const r = runDemo({});
  assert.equal(r.status, 1);
  assert.match(r.stderr, /marquée « production »/);
  assert.equal((await counts()).p, 0);
  await assert.rejects(pool.query(`DELETE FROM settings WHERE key = 'deployment'`), /marqueur/);
  await assert.rejects(pool.query(`UPDATE settings SET value = '{"mode":"demo"}' WHERE key = 'deployment'`), /marqueur/);
});

test('garde-fou base : base déjà utilisée (patients ou employés) refusée', async () => {
  await resetDb();
  await assert.doesNotReject(assertDemoDatabase(pool), 'base neuve : autorisée');
  await ownerPool.query(`INSERT INTO patients (patient_number, first_name, last_name) VALUES ('P-999999', 'Réel', 'Patient')`);
  await assert.rejects(assertDemoDatabase(pool), /non vierge/);
  const r = runDemo({});
  assert.equal(r.status, 1);
  assert.match(r.stderr, /non vierge/);
  assert.equal((await counts()).p, 1, 'aucun patient fictif ajouté');
});

test('garde-fou configuration : le script est exclu de l\'image de production et la base est marquée par le service de migration', () => {
  const dockerfile = fs.readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /RUN rm -f src\/db\/demo\.js/);
  const seed = fs.readFileSync(new URL('../src/db/seed.js', import.meta.url), 'utf8');
  assert.match(seed, /'deployment'.*'production'/s);
});
