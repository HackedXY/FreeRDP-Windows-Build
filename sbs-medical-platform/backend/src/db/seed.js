import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'node:url';
import { pool, tx } from './pool.js';
import { config } from '../config.js';
import { PERMISSIONS, DEFAULT_ROLES } from '../lib/permissions.js';
import { temporaryPassword } from '../lib/crypto.js';

const DEFAULT_ACTS = [
  ['CONS', 'Consultation générale', 'consultation', 50000, 20],
  ['CONS-SP', 'Consultation de contrôle', 'consultation', 30000, 15],
  ['INJ', 'Injection', 'soin', 10000, 10],
  ['PANS', 'Pansement simple', 'soin', 15000, 15],
  ['PANS-C', 'Pansement complexe', 'soin', 30000, 30],
  ['PERF', 'Perfusion', 'soin', 40000, 60],
  ['SUT', 'Suture / petite chirurgie', 'petite_chirurgie', 75000, 30],
  ['ECG', 'Électrocardiogramme', 'examen', 60000, 20],
];

const DEFAULT_EXAMS = [
  ['GE', 'Goutte épaisse (paludisme)', 'Parasitologie', 25000, null, 'Négatif'],
  ['TDR', 'TDR paludisme', 'Parasitologie', 15000, null, 'Négatif'],
  ['NFS', 'Numération formule sanguine', 'Hématologie', 60000, null, null],
  ['GLY', 'Glycémie à jeun', 'Biochimie', 20000, 'g/L', '0,70 – 1,10'],
  ['CREA', 'Créatininémie', 'Biochimie', 35000, 'mg/L', '6 – 12'],
  ['WID', 'Sérodiagnostic de Widal', 'Sérologie', 40000, null, '< 1/80'],
  ['HIV', 'Sérologie VIH', 'Sérologie', 30000, null, 'Négatif'],
  ['ECBU', 'ECBU', 'Bactériologie', 60000, null, null],
  ['BHCG', 'Test de grossesse (β-HCG)', 'Biochimie', 25000, null, null],
];

export async function seed({ log = console.log } = {}) {
  await tx(async (db) => {
    let i = 0;
    for (const [code, module, label] of PERMISSIONS) {
      await db.query(
        `INSERT INTO permissions (code, module, label, sort_order) VALUES ($1,$2,$3,$4)
         ON CONFLICT (code) DO UPDATE SET module = EXCLUDED.module, label = EXCLUDED.label, sort_order = EXCLUDED.sort_order`,
        [code, module, label, i++]);
    }
    for (const r of DEFAULT_ROLES) {
      const { rows: [role] } = await db.query(
        `INSERT INTO roles (code, name, description, is_system, is_superadmin) VALUES ($1,$2,$3,TRUE,$4)
         ON CONFLICT (code) DO NOTHING RETURNING id`, [r.code, r.name, r.description, !!r.superadmin]);
      // Les permissions par défaut ne sont posées qu'à la création : l'administrateur peut ensuite les modifier.
      if (role) {
        await db.query('INSERT INTO role_permissions (role_id, permission_code) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING', [role.id, r.permissions]);
      }
    }
    const { rows: sites } = await db.query('SELECT id FROM sites LIMIT 1');
    if (!sites.length) {
      await db.query(`INSERT INTO sites (name, address) VALUES ('Cabinet Médical SBS', 'Siguiri, Guinée')`);
      await db.query(`INSERT INTO cash_registers (site_id, name) VALUES ((SELECT min(id) FROM sites), 'Caisse principale')`);
    }
    const { rows: acts } = await db.query('SELECT 1 FROM medical_acts LIMIT 1');
    if (!acts.length) {
      for (const [code, name, category, price, dur] of DEFAULT_ACTS) {
        await db.query('INSERT INTO medical_acts (code, name, category, price, duration_minutes) VALUES ($1,$2,$3,$4,$5)', [code, name, category, price, dur]);
      }
    }
    const { rows: exams } = await db.query('SELECT 1 FROM lab_exam_types LIMIT 1');
    if (!exams.length) {
      for (const [code, name, category, price, unit, range] of DEFAULT_EXAMS) {
        await db.query('INSERT INTO lab_exam_types (code, name, category, price, unit, reference_range) VALUES ($1,$2,$3,$4,$5,$6)', [code, name, category, price, unit, range]);
      }
    }
    const { rows: admins } = await db.query('SELECT 1 FROM users LIMIT 1');
    if (!admins.length) {
      const username = process.env.ADMIN_USERNAME || 'admin';
      let password = process.env.ADMIN_PASSWORD;
      if (!password) password = config.isProd ? temporaryPassword() : 'ChangeMoi2026';
      const hash = await bcrypt.hash(password, 12);
      await db.query(
        `INSERT INTO users (site_id, employee_number, first_name, last_name, job_title, role_id, username, password_hash, must_change_password)
         VALUES ((SELECT min(id) FROM sites), 'EMP-000', 'Administrateur', 'SBS', 'Propriétaire', (SELECT id FROM roles WHERE code = 'admin'), $1, $2, TRUE)`,
        [username, hash]);
      log('──────────────────────────────────────────────────────────');
      log(` Compte administrateur créé : ${username}`);
      log(` Mot de passe temporaire   : ${password}`);
      log(' (changement obligatoire à la première connexion)');
      log('──────────────────────────────────────────────────────────');
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { migrate } = await import('./migrate.js');
  migrate().then(() => seed()).then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
}
