// Service de sauvegarde (conteneur dédié, rôle base sbs_backup en lecture seule).
//   node src/backup/worker.js          planificateur (quotidien à BACKUP_HOUR, rattrapage si > 24 h)
//   node src/backup/worker.js --once   une sauvegarde immédiate (code de sortie ≠ 0 en cas d'échec)
import fs from 'node:fs';
import pg from 'pg';
import { runBackup } from './backup.js';
import { uploadsStep } from './uploads.js';

const env = process.env;
const cfg = {
  databaseUrl: env.BACKUP_DATABASE_URL,
  target: env.BACKUP_TARGET,
  publicKeyPem: env.BACKUP_PUBLIC_KEY_FILE ? fs.readFileSync(env.BACKUP_PUBLIC_KEY_FILE, 'utf8') : null,
  keepDays: Number(env.BACKUP_KEEP_DAYS || 30),
  // production : rétention gérée par le stockage (verrouillage + cycle de vie), le serveur ne supprime rien
  prune: env.BACKUP_REMOTE_PRUNE ? env.BACKUP_REMOTE_PRUNE === 'on' : env.NODE_ENV !== 'production',
  hour: Number(env.BACKUP_HOUR ?? 2),
  isProd: env.NODE_ENV === 'production',
  allowDir: env.BACKUP_ALLOW_DIR_TARGET === 'true',
  uploadsDir: env.UPLOAD_DIR || '/data/uploads',
};
if (!cfg.databaseUrl) { console.error('BACKUP_DATABASE_URL requis'); process.exit(2); }
// Garde-fou : aucune clé privée ne doit être fournie au serveur (variables ou fichier de clé)
if (Object.values(env).some((v) => typeof v === 'string' && v.includes('PRIVATE KEY')) || /PRIVATE KEY/.test(cfg.publicKeyPem || '')) {
  console.error('Refus de démarrer : une CLÉ PRIVÉE a été fournie au service de sauvegarde. Seule la clé publique va sur le serveur.');
  process.exit(2);
}

async function once() {
  const t0 = Date.now();
  try {
    const r = await runBackup({ ...cfg, extraSteps: [uploadsStep(cfg.uploadsDir)] });
    console.log(`[${new Date().toISOString()}] sauvegarde réussie : ${r.set} (${Math.round((Date.now() - t0) / 1000)} s)`);
    return true;
  } catch (e) {
    // message déjà expurgé ; l'application détecte l'échec via backup_runs et alerte
    console.error(`[${new Date().toISOString()}] ÉCHEC de la sauvegarde : ${e.message}`);
    return false;
  }
}

async function due() {
  const c = new pg.Client({ connectionString: cfg.databaseUrl });
  await c.connect();
  try {
    const { rows: [r] } = await c.query(`SELECT max(finished_at) AS t FROM backup_runs WHERE status = 'success'`);
    const last = r.t ? new Date(r.t) : null;
    const now = new Date();
    if (!last || now - last > 24 * 3600000) return true;
    return now.getHours() === cfg.hour && last.toDateString() !== now.toDateString();
  } finally { await c.end(); }
}

if (process.argv.includes('--once')) {
  process.exit((await once()) ? 0 : 1);
} else {
  console.log(`Service de sauvegarde démarré (cible : ${cfg.target?.split(':')[0] || 'non configurée'}, heure : ${cfg.hour} h)`);
  for (;;) {
    try { if (await due()) await once(); } catch (e) { console.error('Planificateur :', e.message); }
    // après un échec, nouvel essai au prochain passage (15 min)
    await new Promise((r) => setTimeout(r, 15 * 60 * 1000));
  }
}
