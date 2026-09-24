import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import pg from 'pg';
import { resetDb, adminAgent, employee, pool, ownerPool, closePools } from './helpers.js';
const { runBackup } = await import('../src/backup/backup.js');
const { runRestore } = await import('../src/backup/restore.js');
const { uploadsStep } = await import('../src/backup/uploads.js');
const { checkBackups } = await import('../src/lib/backupmon.js');
const { makeContext } = await import('../src/lib/realtime.js');
const { config } = await import('../src/config.js');

const OWNER = process.env.MIGRATION_DATABASE_URL;
const BACKUP_URL = OWNER.replace(/\/\/[^@]+@/, '//sbs_backup:sbs_backup@');
const uploadDir = config.uploadDir;
const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'sbs-remote-up-'));
const pass = crypto.randomBytes(16).toString('hex');
const { publicKey, privateKey: pem } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 3072, publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: pass },
});
const privateKey = crypto.createPrivateKey({ key: pem, passphrase: pass });
const dbs = []; const dirs = [];
let admin, cashier, receipt, receiptBytes, set;

async function freshDb() {
  const name = `sbs_restore_up_${Date.now()}_${dbs.length}`;
  await ownerPool.query(`CREATE DATABASE ${name}`);
  await ownerPool.query(`GRANT CONNECT ON DATABASE ${name} TO sbs_app, sbs_backup`);
  dbs.push(name);
  return OWNER.replace(/\/[^/]+$/, `/${name}`);
}
function emptyDir() { const d = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sbs-restored-up-')), 'uploads'); dirs.push(path.dirname(d)); return d; }
const backup = (extra = {}) => runBackup({ databaseUrl: BACKUP_URL, target: `dir:${remote}`, publicKeyPem: publicKey, extraSteps: [uploadsStep(uploadDir)], ...extra });

before(async () => {
  await resetDb();
  admin = await adminAgent();
  cashier = await employee(admin, 'caissier', 'caissier01');
  // Reçu téléversé via l'API (image PNG minimale + octets aléatoires)
  receiptBytes = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), crypto.randomBytes(4096)]);
  const r = await cashier.raw.post('/api/expenses').set('X-SBS-Client', 'test')
    .field('category', 'Matériel').field('amount', '120000').field('reason', 'Achat thermomètres')
    .attach('attachment', receiptBytes, { filename: 'recu-fournisseur.png', contentType: 'image/png' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  receipt = r.body;
  assert.ok(receipt.attachment_path);
});
after(async () => {
  for (const d of dbs) await ownerPool.query(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`);
  for (const d of [remote, ...dirs]) fs.rmSync(d, { recursive: true, force: true });
  await closePools();
});

test('sauvegarde : le justificatif est inclus, chiffré et inventorié', async () => {
  const r = await backup();
  set = r.set;
  const u = r.manifest.uploads;
  assert.equal(u.count, fs.readdirSync(uploadDir).length);
  const entry = u.files.find((f) => f.name === receipt.attachment_path);
  assert.equal(entry.sha256, crypto.createHash('sha256').update(receiptBytes).digest('hex'));
  const archive = fs.readFileSync(path.join(remote, set, 'uploads.tar.sbsenc'));
  assert.ok(!archive.includes(receiptBytes.subarray(0, 64)), 'le contenu du reçu ne doit pas être lisible');
  const { rows: [run] } = await pool.query('SELECT uploads_count FROM backup_runs WHERE id = $1', [r.id]);
  assert.equal(run.uploads_count, u.count);
});

test('restauration dans un environnement vierge : fichier et métadonnées identiques', async () => {
  const url = await freshDb();
  const target = emptyDir();
  const report = await runRestore({ target: `dir:${remote}`, set, privateKey, restoreDatabaseUrl: url, uploadsDir: target, auditKey: config.auditKey });
  assert.equal(report.ok, true);
  assert.equal(report.uploads.verified, true);
  assert.equal(report.uploads.referenced, 1);
  const restored = fs.readFileSync(path.join(target, receipt.attachment_path));
  assert.ok(restored.equals(receiptBytes), 'octets du reçu identiques');
  const c = new pg.Client({ connectionString: url }); await c.connect();
  try {
    const { rows: [e] } = await c.query('SELECT number, amount, reason, attachment_path, attachment_name, created_by FROM expenses WHERE id = $1', [receipt.id]);
    assert.deepEqual(e, { number: receipt.number, amount: 120000, reason: 'Achat thermomètres', attachment_path: receipt.attachment_path, attachment_name: 'recu-fournisseur.png', created_by: cashier.user.id });
  } finally { await c.end(); }
});

test('restauration déterministe : dossier non vide, archive altérée et dossier manquant refusés', async () => {
  const notEmpty = emptyDir(); fs.mkdirSync(notEmpty, { recursive: true }); fs.writeFileSync(path.join(notEmpty, 'intrus.txt'), 'x');
  await assert.rejects(runRestore({ target: `dir:${remote}`, set, privateKey, restoreDatabaseUrl: await freshDb(), uploadsDir: notEmpty }), /pas vide/);
  await assert.rejects(runRestore({ target: `dir:${remote}`, set, privateKey, restoreDatabaseUrl: await freshDb() }), /--uploads-dir/);
  const f = path.join(remote, set, 'uploads.tar.sbsenc');
  const orig = fs.readFileSync(f); const bad = Buffer.from(orig); bad[bad.length - 50] ^= 0x01;
  fs.writeFileSync(f, bad);
  await assert.rejects(runRestore({ target: `dir:${remote}`, set, privateKey, restoreDatabaseUrl: await freshDb(), uploadsDir: emptyDir() }), /altéré|Empreinte/);
  fs.writeFileSync(f, orig);
});

test('échec de sauvegarde des justificatifs : tracé et alerte haute', async () => {
  const notADir = path.join(os.tmpdir(), `sbs-uploads-file-${Date.now()}`);
  fs.writeFileSync(notADir, 'x');
  await assert.rejects(runBackup({ databaseUrl: BACKUP_URL, target: `dir:${remote}`, publicKeyPem: publicKey, extraSteps: [uploadsStep(notADir)] }), /justificatifs/);
  fs.rmSync(notADir);
  const { rows: [r] } = await pool.query('SELECT status, error FROM backup_runs ORDER BY id DESC LIMIT 1');
  assert.equal(r.status, 'failed');
  const c = await pool.connect();
  try { await checkBackups(c, makeContext({ deferred: false })); } finally { c.release(); }
  const alerts = (await admin.get('/api/alerts?type=sauvegarde_echec&status=open')).body.items;
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].severity, 'haute');
  // aucun jeu incomplet laissé sur le stockage distant
  for (const s of fs.readdirSync(remote)) assert.ok(fs.existsSync(path.join(remote, s, 'manifest.json')) || !fs.readdirSync(path.join(remote, s)).length);
});
