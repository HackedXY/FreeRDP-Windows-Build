import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import pg from 'pg';
import { spawnSync } from 'node:child_process';
import { resetDb, adminAgent, employee, pool, ownerPool, closePools } from './helpers.js';
const { runBackup } = await import('../src/backup/backup.js');
const { runRestore } = await import('../src/backup/restore.js');
const { sanitize } = await import('../src/backup/tools.js');
const { openStorage } = await import('../src/backup/storage.js');
const { checkBackups } = await import('../src/lib/backupmon.js');
const { makeContext } = await import('../src/lib/realtime.js');
const { config } = await import('../src/config.js');
const { decrypt } = await import('../src/lib/crypto.js');

const OWNER = process.env.MIGRATION_DATABASE_URL;
const BACKUP_URL = OWNER.replace(/\/\/[^@]+@/, '//sbs_backup:sbs_backup@');
const MARKER = 'ALLERGIEMARQUEUR';
const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'sbs-remote-'));
const pass = crypto.randomBytes(16).toString('hex');
const { publicKey, privateKey: privPem } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 3072, publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: pass },
});
const privateKey = crypto.createPrivateKey({ key: privPem, passphrase: pass });
const restoreDbs = [];
let admin, first;

async function freshDb() {
  const name = `sbs_restore_${Date.now()}_${restoreDbs.length}`;
  await ownerPool.query(`CREATE DATABASE ${name}`);
  await ownerPool.query(`GRANT CONNECT ON DATABASE ${name} TO sbs_app, sbs_backup`);
  restoreDbs.push(name);
  return OWNER.replace(/\/[^/]+$/, `/${name}`);
}
const backup = (extra = {}) => runBackup({ databaseUrl: BACKUP_URL, target: `dir:${remote}`, publicKeyPem: publicKey, ...extra });

before(async () => {
  await resetDb();
  admin = await adminAgent();
  const cashier = await employee(admin, 'caissier', 'caissier01');
  await admin.post('/api/patients').send({ first_name: 'Awa', last_name: 'Kaba', allergies: MARKER });
  await cashier.post('/api/cash/open').send({ opening_balance: 500000 });
  await cashier.post('/api/payments').send({ source_type: 'other', payer_name: 'X', description: 'Certificat', amount: 25000, method: 'especes' });
});
after(async () => {
  for (const d of restoreDbs) await ownerPool.query(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`);
  fs.rmSync(remote, { recursive: true, force: true });
  await closePools();
});

test('sauvegarde : chiffrée, envoyée hors serveur, tracée, sans clair local', async () => {
  const tmpBefore = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('sbs-backup-')).length;
  first = await backup();
  const dir = path.join(remote, first.set);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['db.dump.sbsenc', 'manifest.json']);
  const blob = fs.readFileSync(path.join(dir, 'db.dump.sbsenc'));
  assert.ok(blob.subarray(0, 7).toString() === 'SBSBK1\n');
  for (const m of [MARKER, 'Kaba', 'CREATE TABLE', 'Certificat']) assert.ok(!blob.includes(m), `« ${m} » lisible dans la sauvegarde`);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.ok(manifest.audit_head.id > 0);
  assert.equal(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('sbs-backup-')).length, tmpBefore);
  const { rows: [run] } = await pool.query('SELECT * FROM backup_runs WHERE id = $1', [first.id]);
  assert.equal(run.status, 'success');
  assert.equal(run.audit_head_id, manifest.audit_head.id);
});

test('restauration dans une base vierge : données, chiffrement, droits et journal vérifiés', async () => {
  const url = await freshDb();
  const report = await runRestore({ target: `dir:${remote}`, privateKey, restoreDatabaseUrl: url, auditKey: config.auditKey });
  assert.equal(report.ok, true);
  assert.deepEqual(report.audit.chain_ok && report.audit.anchor_ok && report.audit.signatures_ok, true);
  const src = {};
  for (const t of Object.keys(report.counts)) src[t] = (await pool.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n;
  assert.deepEqual(report.counts, src);
  // données médicales toujours chiffrées et déchiffrables avec la clé applicative
  const c = new pg.Client({ connectionString: url.replace(/\/\/[^@]+@/, '//sbs_app:sbs_app@') }); await c.connect();
  try {
    const { rows: [p] } = await c.query(`SELECT allergies FROM patients WHERE last_name = 'Kaba'`);
    assert.match(p.allergies, /^enc:v1:/);
    assert.equal(decrypt(p.allergies), MARKER);
    // droits applicatifs réappliqués : journal toujours en ajout seul
    await assert.rejects(c.query('DELETE FROM audit_log'), (e) => e.code === '42501');
    // nouvelle entrée d'audit après restauration : la chaîne continue
    await c.query(`INSERT INTO audit_log (action, summary) VALUES ('test.after_restore', 'x')`);
    const { rows: [r] } = await c.query(`SELECT prev_hash = (SELECT hash FROM audit_log WHERE id = $1) ok FROM audit_log WHERE action = 'test.after_restore'`, [first.manifest.audit_head.id]);
    assert.equal(r.ok, true);
  } finally { await c.end(); }
});

test('restauration refusée : fichier altéré, mauvaise clé, base cible non vide', async () => {
  const f = path.join(remote, first.set, 'db.dump.sbsenc');
  const orig = fs.readFileSync(f);
  const bad = Buffer.from(orig); bad[bad.length - 100] ^= 0xff;
  fs.writeFileSync(f, bad);
  await assert.rejects(runRestore({ target: `dir:${remote}`, set: first.set, privateKey, restoreDatabaseUrl: await freshDb() }), /altéré|Empreinte/);
  fs.writeFileSync(f, orig);
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  await assert.rejects(runRestore({ target: `dir:${remote}`, set: first.set, privateKey: other, restoreDatabaseUrl: await freshDb() }), /ne correspond pas/);
  await assert.rejects(runRestore({ target: `dir:${remote}`, set: first.set, privateKey, restoreDatabaseUrl: OWNER }), /n'est pas vide/);
});

test('échec de sauvegarde : tracé sans secret, alerte haute, puis résolution automatique', async () => {
  const blocker = path.join(os.tmpdir(), `sbs-not-a-dir-${Date.now()}`);
  fs.writeFileSync(blocker, 'x');
  await assert.rejects(backup({ target: `dir:${blocker}` }));
  fs.rmSync(blocker);
  const { rows: [run] } = await pool.query(`SELECT * FROM backup_runs ORDER BY id DESC LIMIT 1`);
  assert.equal(run.status, 'failed');
  assert.ok(run.error && !run.error.includes('sbs_backup:'));
  const ctx = makeContext({ deferred: false });
  const c = await pool.connect();
  try { await checkBackups(c, ctx); } finally { c.release(); }
  let alerts = (await admin.get('/api/alerts?type=sauvegarde_echec&status=open')).body.items;
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].severity, 'haute');
  // sauvegarde trop ancienne
  await ownerPool.query(`UPDATE backup_runs SET finished_at = now() - interval '30 hours', started_at = now() - interval '30 hours' WHERE status = 'success'`);
  const c2 = await pool.connect();
  try { await checkBackups(c2, ctx); } finally { c2.release(); }
  alerts = (await admin.get('/api/alerts?type=sauvegarde_absente&status=open')).body.items;
  assert.equal(alerts.length, 1);
  // nouvelle sauvegarde réussie : alertes résolues
  await backup();
  const c3 = await pool.connect();
  try { await checkBackups(c3, ctx); } finally { c3.release(); }
  assert.equal((await admin.get('/api/alerts?type=sauvegarde_absente&status=open')).body.items.length, 0);
  assert.equal((await admin.get('/api/alerts?type=sauvegarde_echec&status=open')).body.items.length, 0);
  const s = (await admin.get('/api/settings/backups')).body;
  assert.equal(s.stale, false);
});

test('rétention : les jeux plus anciens que la durée de conservation sont supprimés', async () => {
  const old = await backup({ now: new Date(Date.now() - 40 * 86400000) });
  assert.ok(fs.existsSync(path.join(remote, old.set)));
  await backup({ keepDays: 30 });
  assert.ok(!fs.existsSync(path.join(remote, old.set)));
});

test('garde-fous : rôle applicatif sans droit d\'écriture sur le journal des sauvegardes, cible locale refusée en production, secrets masqués', async () => {
  await assert.rejects(pool.query(`INSERT INTO backup_runs (status) VALUES ('success')`), (e) => e.code === '42501');
  assert.throws(() => openStorage(`dir:${remote}`, { isProd: true }), /refusée en production/);
  const s = sanitize('connexion postgres://sbs_backup:SuperSecret1@db:5432/sbs impossible; password=Other2'); // check-secrets: exemple (valeur fictive pour tester le masquage)
  assert.ok(!s.includes('SuperSecret1') && !s.includes('Other2'));
});


test('adaptateur rclone (configuration par variables d\'environnement) : sauvegarde puis restauration', { skip: !fs.existsSync('/usr/bin/rclone') && !fs.existsSync('/usr/local/bin/rclone') ? 'rclone non installé' : false }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbs-rclone-'));
  process.env.RCLONE_CONFIG_SBSTEST_TYPE = 'local';
  try {
    const r = await backup({ target: `rclone:sbstest:${dir}` });
    assert.ok(fs.existsSync(path.join(dir, r.set, 'manifest.json')));
    const report = await runRestore({ target: `rclone:sbstest:${dir}`, privateKey, restoreDatabaseUrl: await freshDb(), auditKey: config.auditKey });
    assert.equal(report.ok, true);
    assert.equal(report.set, r.set);
  } finally {
    delete process.env.RCLONE_CONFIG_SBSTEST_TYPE;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ phase 4 : stockage protégé, clé privée hors serveur
test('stockage en écriture seule : sans suppression par le serveur (production), les anciens jeux sont conservés', async () => {
  const old = await backup({ now: new Date(Date.now() - 60 * 86400000) });
  await backup({ keepDays: 30, prune: false });
  assert.ok(fs.existsSync(path.join(remote, old.set)), 'rétention confiée au stockage (verrouillage + cycle de vie)');
  const worker = fs.readFileSync(new URL('../src/backup/worker.js', import.meta.url), 'utf8');
  assert.match(worker, /BACKUP_REMOTE_PRUNE === 'on' : env\.NODE_ENV !== 'production'/, 'suppression désactivée par défaut en production');
});

test('clé privée jamais sur le serveur : refusée par la sauvegarde et par le service', async () => {
  await assert.rejects(backup({ publicKeyPem: privPem }), /PRIVÉE/);
  const { rows: [r] } = await pool.query(`SELECT status, error FROM backup_runs ORDER BY id DESC LIMIT 1`);
  assert.equal(r.status, 'failed');
  assert.ok(!r.error.includes('BEGIN'), 'aucun extrait de clé dans le journal');
  const w = spawnSync(process.execPath, ['src/backup/worker.js', '--once'], {
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, BACKUP_DATABASE_URL: BACKUP_URL, BACKUP_TARGET: `dir:${remote}`, BACKUP_PRIVATE_KEY: privPem },
  });
  assert.equal(w.status, 2);
  assert.match(w.stderr, /CLÉ PRIVÉE/);
  assert.ok(!w.stderr.includes('BEGIN'), 'la clé n\'est pas affichée');
});
