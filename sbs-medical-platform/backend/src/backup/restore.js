// Restauration déterministe et vérifiée d'une sauvegarde.
//
//   BACKUP_TARGET=…  BACKUP_KEY_PASSPHRASE=…  RESTORE_DATABASE_URL=<propriétaire d'une base VIDE>
//   node src/backup/restore.js --private-key /chemin/backup-private.pem [--set latest|sbs-AAAAMMJJ-HHMMSS]
//                              [--uploads-dir /data/uploads] [--audit-key-env AUDIT_HMAC_KEY]
//
// Étapes : manifeste → téléchargement → contrôle des empreintes → déchiffrement authentifié
// → contrôle de l'empreinte du clair → base cible vide exigée → pg_restore (transaction unique)
// → droits applicatifs → vérification du journal d'audit (chaîne, ancre du manifeste, signatures).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { decryptFile, sha256File, keyFingerprint, loadPrivateKey } from './format.js';
import { pgEnv, run } from './tools.js';
import { openStorage } from './storage.js';
import { restoreUploads } from './uploads.js';

export async function runRestore({ target, set = 'latest', privateKey, restoreDatabaseUrl, uploadsDir = null, auditKey = null, log = () => {} }) {
  const storage = openStorage(target, { allowDir: true });
  const sets = await storage.listSets();
  const chosen = set === 'latest' ? sets[sets.length - 1] : set;
  if (!chosen || !sets.includes(chosen)) throw new Error(`Sauvegarde introuvable (${set}) ; disponibles : ${sets.slice(-5).join(', ') || 'aucune'}`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sbs-restore-'));
  fs.chmodSync(work, 0o700);
  const report = { set: chosen, steps: [] };
  const step = (s) => { report.steps.push(s); log(`✔ ${s}`); };
  try {
    await storage.get(`${chosen}/manifest.json`, path.join(work, 'manifest.json'));
    const manifest = JSON.parse(fs.readFileSync(path.join(work, 'manifest.json'), 'utf8'));
    if (manifest.format !== 'sbs-backup/1') throw new Error('Format de manifeste inconnu');
    report.created_at = manifest.created_at;
    const pubFp = keyFingerprint(crypto.createPublicKey(privateKey));
    if (pubFp !== manifest.key_fingerprint) throw new Error('La clé privée fournie ne correspond pas à cette sauvegarde');
    step(`manifeste ${chosen} lu (créé le ${manifest.created_at})`);

    // Base de données
    const enc = path.join(work, manifest.database.file);
    await storage.get(`${chosen}/${manifest.database.file}`, enc);
    if ((await sha256File(enc)) !== manifest.database.sha256_encrypted) throw new Error('Empreinte du fichier chiffré incorrecte : fichier altéré ou incomplet');
    const plain = path.join(work, 'db.dump');
    const { sha256_plain } = await decryptFile(enc, plain, privateKey);
    if (sha256_plain !== manifest.database.sha256_plain) throw new Error('Empreinte du contenu déchiffré incorrecte');
    step('base : empreintes et authentification du chiffrement vérifiées');

    const target = new pg.Client({ connectionString: restoreDatabaseUrl });
    await target.connect();
    try {
      const { rows: [{ n }] } = await target.query(`SELECT count(*)::int n FROM pg_tables WHERE schemaname = 'public'`);
      if (n) throw new Error('La base cible n\'est pas vide : restaurez dans une base nouvellement créée');
      // contexte « system » : conserve identifiants et hachages d'origine du journal d'audit
      const renv = pgEnv(restoreDatabaseUrl);
      // nom de base seul en argument ; identifiants via l'environnement du processus
      await run('pg_restore', ['--no-owner', '--no-privileges', '--exit-on-error', '--single-transaction', `--dbname=${renv.PGDATABASE}`, plain],
        { env: { ...pgEnv(restoreDatabaseUrl), PGOPTIONS: '-c sbs.context=system' } });
      await target.query('SELECT sbs_apply_grants()');
      step('base restaurée (transaction unique) et droits applicatifs réappliqués');

      // Vérification du journal d'audit
      const { rows } = await target.query(
        `SELECT a.id, a.hash, a.prev_hash, audit_row_hash(a) AS computed, lag(a.hash) OVER (ORDER BY a.id) AS lag_hash, s.sig
         FROM audit_log a LEFT JOIN audit_signatures s ON s.audit_id = a.id ORDER BY a.id`);
      const chainOk = rows.every((r) => r.hash === r.computed && (r.prev_hash || '') === (r.lag_hash || ''));
      const anchor = manifest.audit_head;
      const anchorOk = !anchor || rows.some((r) => Number(r.id) === anchor.id && r.hash === anchor.hash);
      let sigOk = null;
      if (auditKey) {
        sigOk = rows.every((r) => r.sig && crypto.timingSafeEqual(
          Buffer.from(r.sig, 'hex'), crypto.createHmac('sha256', auditKey).update(`${r.id}|${r.hash}`).digest()));
      }
      report.audit = { entries: rows.length, chain_ok: chainOk, anchor_ok: anchorOk, signatures_ok: sigOk };
      if (!chainOk || !anchorOk || sigOk === false) throw new Error(`Journal d'audit restauré non intègre : ${JSON.stringify(report.audit)}`);
      step(`journal d'audit vérifié (${rows.length} entrées, ancre${sigOk ? ', signatures' : ''} OK)`);

      const counts = {};
      for (const t of ['users', 'patients', 'consultations', 'payments', 'cash_sessions', 'expenses', 'products', 'lab_requests']) {
        counts[t] = (await target.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n;
      }
      report.counts = counts;
    } finally { await target.end(); }

    if (manifest.uploads) {
      if (!uploadsDir) throw new Error('Cette sauvegarde contient des justificatifs : indiquez --uploads-dir');
      report.uploads = await restoreUploads({ storage, set: chosen, manifest, work, privateKey, uploadsDir });
      step(`justificatifs restaurés et vérifiés (${report.uploads.files} fichier(s))`);
    }
    report.ok = true;
    return report;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ CLI
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (n, d = null) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
  const keyFile = arg('--private-key');
  const env = process.env;
  if (!keyFile || !env.BACKUP_TARGET || !env.RESTORE_DATABASE_URL || !env.BACKUP_KEY_PASSPHRASE) {
    console.error('Variables requises : BACKUP_TARGET, RESTORE_DATABASE_URL, BACKUP_KEY_PASSPHRASE ; option --private-key <fichier>');
    process.exit(2);
  }
  const auditKeyEnv = arg('--audit-key-env');
  try {
    const report = await runRestore({
      target: env.BACKUP_TARGET, set: arg('--set', 'latest'), privateKey: loadPrivateKey(keyFile, env.BACKUP_KEY_PASSPHRASE),
      restoreDatabaseUrl: env.RESTORE_DATABASE_URL, uploadsDir: arg('--uploads-dir'),
      auditKey: auditKeyEnv && env[auditKeyEnv] ? Buffer.from(env[auditKeyEnv], 'base64') : null,
      log: (m) => console.log(m),
    });
    console.log(JSON.stringify({ ...report, steps: undefined }, null, 2));
  } catch (e) {
    console.error(`✖ Restauration interrompue : ${e.message}`);
    process.exit(1);
  }
}
