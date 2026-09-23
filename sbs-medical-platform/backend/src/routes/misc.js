import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../db/pool.js';
import { ah, parse, notFound, badRequest } from '../lib/errors.js';
import { requirePerm, can } from '../lib/auth.js';
import { audit, actionLabel } from '../lib/audit.js';
import { raiseAlert } from '../lib/notify.js';
import { getSettings, invalidateSettings } from '../lib/settings.js';
import { paging, addPeriod } from '../lib/helpers.js';
import { DEFAULT_SETTINGS } from '../lib/permissions.js';
import { config } from '../config.js';
import { auditKeyId, verifyAuditSig } from '../lib/auditsig.js';

export const search = Router();
export const alerts = Router();
export const auditRoutes = Router();
export const notifications = Router();
export const settings = Router();

// ----------------------------------------------------------------- Recherche globale
search.get('/', ah(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({});
  const like = `%${q.toLowerCase()}%`;
  const u = req.user; const out = {}; const jobs = [];
  const run = (key, sql) => jobs.push(query(sql, [like]).then((r) => { out[key] = r.rows; }));
  if (can(u, 'patients.view')) run('patients', `SELECT id, patient_number AS ref, first_name || ' ' || last_name AS label, phone AS detail FROM patients
    WHERE archived_at IS NULL AND (lower(patient_number) LIKE $1 OR lower(first_name || ' ' || last_name) LIKE $1 OR lower(last_name || ' ' || first_name) LIKE $1 OR phone LIKE $1) ORDER BY last_name LIMIT 8`);
  if (can(u, 'payments.view')) run('payments', `SELECT py.id, py.receipt_number AS ref, py.description AS label, py.amount AS detail, py.number FROM payments py
    LEFT JOIN patients p ON p.id = py.patient_id
    WHERE lower(py.number) LIKE $1 OR lower(py.receipt_number) LIKE $1 OR lower(coalesce(py.reference,'')) LIKE $1 OR lower(coalesce(p.first_name || ' ' || p.last_name, py.payer_name, '')) LIKE $1
    ORDER BY py.id DESC LIMIT 8`);
  if (can(u, 'consultations.view')) run('consultations', `SELECT c.id, c.number AS ref, p.first_name || ' ' || p.last_name AS label, c.consulted_at AS detail FROM consultations c
    JOIN patients p ON p.id = c.patient_id WHERE lower(c.number) LIKE $1 OR lower(p.first_name || ' ' || p.last_name) LIKE $1 ORDER BY c.id DESC LIMIT 8`);
  if (can(u, 'pharmacy.view') || can(u, 'pharmacy.sell')) run('products', `SELECT id, reference AS ref, name AS label, quantity AS detail FROM products
    WHERE lower(name) LIKE $1 OR lower(reference) LIKE $1 ORDER BY name LIMIT 8`);
  if (can(u, 'users.view')) run('employees', `SELECT id, employee_number AS ref, first_name || ' ' || last_name AS label, job_title AS detail FROM users
    WHERE lower(first_name || ' ' || last_name) LIKE $1 OR lower(username) LIKE $1 OR lower(employee_number) LIKE $1 LIMIT 8`);
  if (can(u, 'lab.view') || can(u, 'lab.request')) run('lab_requests', `SELECT lr.id, lr.number AS ref, p.first_name || ' ' || p.last_name AS label, lr.status AS detail FROM lab_requests lr
    JOIN patients p ON p.id = lr.patient_id WHERE lower(lr.number) LIKE $1 OR lower(p.first_name || ' ' || p.last_name) LIKE $1 ORDER BY lr.id DESC LIMIT 8`);
  if (can(u, 'expenses.view')) run('expenses', `SELECT id, number AS ref, reason AS label, amount AS detail FROM expenses
    WHERE lower(number) LIKE $1 OR lower(reason) LIKE $1 ORDER BY id DESC LIMIT 5`);
  await Promise.all(jobs);
  res.json(out);
}));

// ----------------------------------------------------------------- Alertes
alerts.get('/', requirePerm('alerts.view'), ah(async (req, res) => {
  const { limit, offset } = paging(req);
  const where = []; const vals = [];
  if (req.query.status === 'open') where.push(`a.status IN ('nouvelle','en_verification')`);
  else if (req.query.status) { vals.push(req.query.status); where.push(`a.status = $${vals.length}`); }
  for (const f of ['category', 'severity', 'type']) if (req.query[f]) { vals.push(req.query[f]); where.push(`a.${f} = $${vals.length}`); }
  addPeriod(where, vals, 'a.created_at', req.query);
  vals.push(limit, offset);
  const { rows } = await query(
    `SELECT a.*, u.first_name || ' ' || u.last_name AS user_name, r.first_name || ' ' || r.last_name AS resolved_by_name, count(*) OVER()::int AS total
     FROM alerts a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN users r ON r.id = a.resolved_by
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY (a.status IN ('nouvelle','en_verification')) DESC, a.id DESC
     LIMIT $${vals.length - 1} OFFSET $${vals.length}`, vals);
  res.json({ items: rows.map(({ total, ...r }) => r), total: rows[0]?.total || 0 });
}));

alerts.put('/:id', requirePerm('alerts.manage'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const d = parse(z.object({ status: z.enum(['en_verification', 'resolue', 'ignoree']), resolution_note: z.string().trim().max(1000).optional().nullable() }), req.body);
  if (['resolue', 'ignoree'].includes(d.status) && !d.resolution_note) throw badRequest('Une note de traitement est obligatoire.');
  const out = await tx(async (db) => {
    const { rows: [before] } = await db.query('SELECT * FROM alerts WHERE id = $1 FOR UPDATE', [id]);
    if (!before) throw notFound('Alerte introuvable');
    const closing = ['resolue', 'ignoree'].includes(d.status);
    const { rows: [a] } = await db.query(
      `UPDATE alerts SET status = $2, resolution_note = coalesce($3, resolution_note),
         resolved_by = CASE WHEN $4 THEN $5::int ELSE resolved_by END, resolved_at = CASE WHEN $4 THEN now() ELSE resolved_at END
       WHERE id = $1 RETURNING *`, [id, d.status, d.resolution_note || null, closing, req.user.id]);
    await audit(db, req.ctx, {
      action: 'alert.update', entityType: 'alert', entityId: id, summary: `Alerte « ${before.title} » → ${d.status}`,
      oldValue: { status: before.status }, newValue: { status: d.status }, reason: d.resolution_note || null, feed: false,
    });
    req.ctx.emit('perm:alerts.view', 'alert_update', a);
    req.ctx.emit('perm:dashboard.view', 'stats', { kind: 'alert' });
    return a;
  });
  res.json(out);
}));

// ----------------------------------------------------------------- Journal d'audit
auditRoutes.get('/', requirePerm('audit.view'), ah(async (req, res) => {
  const { limit, offset } = paging(req, 100, 500);
  const where = []; const vals = [];
  addPeriod(where, vals, 'a.created_at', req.query);
  if (req.query.user_id) { vals.push(Number(req.query.user_id)); where.push(`a.user_id = $${vals.length}`); }
  if (req.query.action) { vals.push(`${req.query.action}%`); where.push(`a.action LIKE $${vals.length}`); }
  if (req.query.entity_type) { vals.push(req.query.entity_type); where.push(`a.entity_type = $${vals.length}`); }
  if (req.query.entity_id) { vals.push(String(req.query.entity_id)); where.push(`a.entity_id = $${vals.length}`); }
  if (req.query.q) { vals.push(`%${String(req.query.q).toLowerCase()}%`); where.push(`(lower(coalesce(a.summary,'')) LIKE $${vals.length} OR lower(coalesce(a.reason,'')) LIKE $${vals.length})`); }
  vals.push(limit, offset);
  const { rows } = await query(
    `SELECT a.id, a.user_id, a.username, a.action, a.entity_type, a.entity_id, a.summary, a.old_value, a.new_value, a.reason, a.ip, a.created_at,
       coalesce(u.first_name || ' ' || u.last_name, a.username) AS user_name, r.name AS role_name, count(*) OVER()::int AS total
     FROM audit_log a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN roles r ON r.id = u.role_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.id DESC LIMIT $${vals.length - 1} OFFSET $${vals.length}`, vals);
  res.json({ items: rows.map(({ total, ...r }) => ({ ...r, action_label: actionLabel(r.action) })), total: rows[0]?.total || 0 });
}));

auditRoutes.get('/actions', requirePerm('audit.view'), ah(async (_req, res) => {
  const { rows } = await query('SELECT DISTINCT action FROM audit_log ORDER BY action');
  res.json(rows.map((r) => r.action));
}));

/**
 * Vérifie l'intégrité du journal :
 *  - chaîne de hachage (chaque entrée référence la précédente, contenu inchangé) ;
 *  - signature HMAC de chaque entrée (clé hors base) : détecte aussi une
 *    réécriture complète de la chaîne par un accès direct à la base.
 */
auditRoutes.get('/verify', requirePerm('audit.view'), ah(async (_req, res) => {
  const { rows } = await query(
    `SELECT a.id, a.hash, a.prev_hash, audit_row_hash(a) AS computed, lag(a.hash) OVER (ORDER BY a.id) AS lag_hash,
       s.sig, s.key_id
     FROM audit_log a LEFT JOIN audit_signatures s ON s.audit_id = a.id ORDER BY a.id`);
  const chainBroken = []; const sigInvalid = []; const sigMissing = [];
  const keyId = auditKeyId();
  for (const r of rows) {
    if (r.hash !== r.computed || (r.prev_hash || '') !== (r.lag_hash || '')) chainBroken.push(Number(r.id));
    if (!r.sig) sigMissing.push(Number(r.id));
    else if (r.key_id !== keyId || !verifyAuditSig(r.id, r.hash, r.sig)) sigInvalid.push(Number(r.id));
  }
  const last = rows[rows.length - 1];
  res.json({
    ok: !chainBroken.length && !sigInvalid.length && !sigMissing.length,
    entries: rows.length,
    chain_broken_ids: chainBroken.slice(0, 20),
    signature_invalid_ids: sigInvalid.slice(0, 20),
    signature_missing_ids: sigMissing.slice(0, 20),
    broken_ids: [...new Set([...chainBroken, ...sigInvalid, ...sigMissing])].sort((a, b) => a - b).slice(0, 20),
    head: last ? { id: Number(last.id), hash: last.hash } : null,
    checked_at: new Date(),
  });
}));

// ----------------------------------------------------------------- Notifications
notifications.get('/', ah(async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM notifications WHERE user_id = $1 ORDER BY id DESC LIMIT 50', [req.user.id]);
  const { rows: [c] } = await query('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [req.user.id]);
  res.json({ items: rows, unread: c.n });
}));

notifications.post('/read', ah(async (req, res) => {
  const { ids } = parse(z.object({ ids: z.array(z.coerce.number().int()).optional() }), req.body);
  if (ids?.length) await query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND id = ANY($2::bigint[]) AND read_at IS NULL', [req.user.id, ids]);
  else await query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [req.user.id]);
  res.json({ ok: true });
}));

// ----------------------------------------------------------------- Paramètres
settings.get('/', requirePerm('settings.manage'), ah(async (_req, res) => {
  const { rows: registers } = await query('SELECT * FROM cash_registers ORDER BY id');
  const { rows: sites } = await query('SELECT * FROM sites ORDER BY id');
  res.json({ settings: await getSettings(), registers, sites });
}));

const settingSchemas = {
  clinic: z.object({ name: z.string().min(2), full_name: z.string().optional(), address: z.string().optional(), phone: z.string().optional(), currency: z.string().optional() }),
  security: z.object({ max_failed_logins: z.coerce.number().int().min(3).max(20), lock_minutes: z.coerce.number().int().min(1).max(1440), failed_login_alert_threshold: z.coerce.number().int().min(1).max(20) }),
  finance: z.object({
    expense_validation_threshold: z.coerce.number().int().min(0), unusual_expense_threshold: z.coerce.number().int().min(0),
    discount_alert_percent: z.coerce.number().min(0).max(100), cash_tolerance: z.coerce.number().int().min(0),
  }),
  stock: z.object({ expiry_warning_days: z.coerce.number().int().min(1).max(365) }),
  expense_categories: z.array(z.string().trim().min(2)).min(1),
};

settings.put('/:key', requirePerm('settings.manage'), ah(async (req, res) => {
  const key = req.params.key;
  if (!settingSchemas[key]) throw notFound('Paramètre inconnu');
  const value = parse(settingSchemas[key], req.body);
  await tx(async (db) => {
    const before = (await getSettings())[key] ?? DEFAULT_SETTINGS[key];
    await db.query(
      `INSERT INTO settings (key, value, updated_by) VALUES ($1,$2,$3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [key, JSON.stringify(value), req.user.id]);
    await audit(db, req.ctx, { action: 'settings.update', entityType: 'settings', entityId: key, summary: `Modification des paramètres « ${key} »`, oldValue: before, newValue: value });
    if (['security', 'finance'].includes(key)) {
      await raiseAlert(db, req.ctx, {
        category: 'systeme', type: 'modification_sensible', severity: 'moyenne', title: `Paramètres ${key === 'security' ? 'de sécurité' : 'financiers'} modifiés`,
        details: { message: `Par ${req.user.fullName}` }, refType: 'settings',
      });
    }
  });
  invalidateSettings();
  res.json(await getSettings());
}));

settings.post('/registers', requirePerm('settings.manage'), ah(async (req, res) => {
  const { name } = parse(z.object({ name: z.string().trim().min(2).max(80) }), req.body);
  const r = await tx(async (db) => {
    const { rows: [r] } = await db.query('INSERT INTO cash_registers (site_id, name) VALUES ((SELECT min(id) FROM sites), $1) RETURNING *', [name]);
    await audit(db, req.ctx, { action: 'settings.register_create', entityType: 'cash_register', entityId: r.id, summary: `Nouvelle caisse : ${name}`, feed: false });
    return r;
  });
  res.status(201).json(r);
}));

// État des sauvegardes (journal écrit par le service de sauvegarde)
settings.get('/backups', requirePerm('settings.manage'), ah(async (_req, res) => {
  const { rows } = await query(
    `SELECT id, started_at, finished_at, status, set_name, target_kind, db_bytes, uploads_count, uploads_bytes, error
     FROM backup_runs ORDER BY started_at DESC LIMIT 30`);
  const lastSuccess = rows.find((r) => r.status === 'success') || null;
  const stale = !lastSuccess || Date.now() - new Date(lastSuccess.finished_at).getTime() > config.backupMaxAgeHours * 3600000;
  res.json({ monitoring: config.backupMonitoring, max_age_hours: config.backupMaxAgeHours, runs: rows, last_success: lastSuccess, stale });
}));
