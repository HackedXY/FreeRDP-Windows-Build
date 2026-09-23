import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownerPool as pool } from './pool.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function migrate({ log = console.log } = {}) {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const done = new Set((await pool.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const files = fs.readdirSync(dir).filter((f) => /\.(sql|js)$/.test(f)).sort();
  for (const file of files) {
    if (done.has(file)) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (file.endsWith('.sql')) {
        await client.query(fs.readFileSync(path.join(dir, file), 'utf8'));
      } else {
        // Migration de données (ex. chiffrement / signature) : nécessite les clés d'environnement
        const mod = await import(path.join(dir, file));
        await mod.up(client);
      }
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      log(`✔ migration appliquée : ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Échec de la migration ${file} : ${err.message}`);
    } finally {
      client.release();
    }
  }
  // Droits applicatifs recalculés à chaque exécution (nouvelles tables comprises)
  const { rows: [fn] } = await pool.query(`SELECT to_regproc('sbs_apply_grants') AS f`);
  if (fn.f) await pool.query('SELECT sbs_apply_grants()');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
}
