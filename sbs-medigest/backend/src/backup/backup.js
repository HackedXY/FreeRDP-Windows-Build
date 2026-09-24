// Exécution d'une sauvegarde : dump PostgreSQL chiffré à la volée (clé publique),
// envoi vers le stockage distant, vérification de la taille, manifeste envoyé en
// dernier (marque une sauvegarde complète), rétention, et journal dans backup_runs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import pg from 'pg';
import { encryptStreamToFile, keyFingerprint, sha256File } from './format.js';
import { pgEnv, spawnStream, sanitize } from './tools.js';
import { openStorage } from './storage.js';

const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

/**
 * @param {object} o
 * @param {string} o.databaseUrl   connexion du rôle sbs_backup (lecture seule)
 * @param {string} o.target        BACKUP_TARGET (rclone:… ou dir:…)
 * @param {string} o.publicKeyPem  clé publique de chiffrement
 * @param {number} [o.keepDays]    rétention distante
 */
export async function runBackup({ databaseUrl, target, publicKeyPem, keepDays = 30, isProd = false, allowDir = false, now = new Date(), extraSteps = [] }) {
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  const { rows: [run] } = await db.query(`INSERT INTO backup_runs (host) VALUES ($1) RETURNING id`, [os.hostname()]);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sbs-backup-'));
  fs.chmodSync(work, 0o700);
  const setName = `sbs-${stamp(now)}`;
  try {
    // contrôles préalables : échouer avant de lancer pg_dump
    const storage = openStorage(target, { isProd, allowDir });
    if (!publicKeyPem) throw new Error('Clé publique de sauvegarde absente (BACKUP_PUBLIC_KEY_FILE)');
    const fp = keyFingerprint(publicKeyPem);

    // 1. Dump de la base, chiffré sans jamais écrire de clair sur disque
    const dump = spawnStream('pg_dump', ['--format=custom', '--no-owner', '--no-privileges'], pgEnv(databaseUrl));
    const dbFile = path.join(work, 'db.dump.sbsenc');
    let dbInfo;
    try {
      [dbInfo] = await Promise.all([encryptStreamToFile(dump.stdout, dbFile, publicKeyPem), dump.done]);
    } catch (e) { dump.kill(); dump.done.catch(() => {}); throw e; }
    const { rows: [head] } = await db.query('SELECT id, hash FROM audit_log ORDER BY id DESC LIMIT 1');

    const manifest = {
      format: 'sbs-backup/1', set: setName, created_at: now.toISOString(), key_fingerprint: fp,
      database: { file: 'db.dump.sbsenc', sha256_plain: dbInfo.sha256_plain, bytes_plain: dbInfo.bytes_plain, sha256_encrypted: await sha256File(dbFile), bytes_encrypted: fs.statSync(dbFile).size },
      uploads: null,
      // Ancre externe du journal d'audit : la dernière entrée connue au moment de la sauvegarde
      audit_head: head ? { id: Number(head.id), hash: head.hash } : null,
    };
    for (const step of extraSteps) await step({ work, manifest, publicKeyPem });

    // 2. Envoi hors serveur puis vérification des tailles
    const files = [manifest.database, ...(manifest.uploads ? [manifest.uploads] : [])];
    for (const f of files) {
      const sent = await storage.put(path.join(work, f.file), `${setName}/${f.file}`);
      if (sent !== f.bytes_encrypted) throw new Error(`Vérification de l'envoi échouée pour ${f.file}`);
    }
    const manifestPath = path.join(work, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    const manifestSha = crypto.createHash('sha256').update(fs.readFileSync(manifestPath)).digest('hex');
    await storage.put(manifestPath, `${setName}/manifest.json`);

    // 3. Rétention (ne supprime que des sauvegardes complètes, jamais la plus récente)
    const sets = await storage.listSets();
    const limit = stamp(new Date(now.getTime() - keepDays * 86400000));
    for (const s of sets.slice(0, -1)) if (s.slice(4) < limit) await storage.removeSet(s);

    await db.query(
      `UPDATE backup_runs SET status = 'success', finished_at = now(), set_name = $2, target_kind = $3, db_bytes = $4,
         uploads_count = $5, uploads_bytes = $6, manifest_sha256 = $7, audit_head_id = $8, audit_head_hash = $9 WHERE id = $1`,
      [run.id, setName, storage.kind, manifest.database.bytes_encrypted, manifest.uploads?.count ?? null, manifest.uploads?.bytes_encrypted ?? null,
        manifestSha, manifest.audit_head?.id ?? null, manifest.audit_head?.hash ?? null]);
    return { id: run.id, set: setName, manifest };
  } catch (e) {
    const msg = sanitize(e.message);
    await db.query(`UPDATE backup_runs SET status = 'failed', finished_at = now(), set_name = $2, error = $3 WHERE id = $1`, [run.id, setName, msg]).catch(() => {});
    throw new Error(msg);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    await db.end();
  }
}
