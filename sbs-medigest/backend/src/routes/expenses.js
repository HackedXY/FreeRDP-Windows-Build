import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { z } from 'zod';
import { query, tx } from '../db/pool.js';
import { config } from '../config.js';
import { ah, parse, notFound, badRequest } from '../lib/errors.js';
import { requirePerm, can } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { notify, raiseAlert } from '../lib/notify.js';
import { nextNumber } from '../lib/numbering.js';
import { getSettings } from '../lib/settings.js';
import { fmtGNF, paging, addPeriod } from '../lib/helpers.js';
import { requireOpenSession, cashMovement } from './cash.js';

const router = Router();
fs.mkdirSync(config.uploadDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: config.uploadDir,
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${path.extname(file.originalname).toLowerCase().slice(0, 6)}`),
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, /^(image\/(jpeg|png|webp)|application\/pdf)$/.test(file.mimetype)),
});

const SELECT = `SELECT e.*, u.first_name || ' ' || u.last_name AS created_by_name,
  v.first_name || ' ' || v.last_name AS validated_by_name, s.name AS supplier_name
  FROM expenses e JOIN users u ON u.id = e.created_by LEFT JOIN users v ON v.id = e.validated_by
  LEFT JOIN suppliers s ON s.id = e.supplier_id`;

async function getExpense(db, id) {
  const { rows: [e] } = await db.query(`${SELECT} WHERE e.id = $1`, [id]);
  if (!e) throw notFound('Dépense introuvable');
  return e;
}

router.get('/', requirePerm('expenses.view'), ah(async (req, res) => {
  const { limit, offset } = paging(req);
  const where = []; const vals = [];
  addPeriod(where, vals, 'e.created_at', req.query);
  for (const f of ['status', 'category']) if (req.query[f]) { vals.push(req.query[f]); where.push(`e.${f} = $${vals.length}`); }
  if (req.query.q) { vals.push(`%${String(req.query.q).toLowerCase()}%`); where.push(`(lower(e.reason) LIKE $${vals.length} OR lower(e.number) LIKE $${vals.length} OR lower(coalesce(e.beneficiary,'')) LIKE $${vals.length})`); }
  vals.push(limit, offset);
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const { rows } = await query(`${SELECT} ${w} ORDER BY e.created_at DESC LIMIT $${vals.length - 1} OFFSET $${vals.length}`, vals);
  const { rows: [t] } = await query(
    `SELECT count(*)::int AS total, coalesce(sum(amount) FILTER (WHERE status = 'validee'), 0) AS total_validated FROM expenses e ${w}`, vals.slice(0, -2));
  res.json({ items: rows, ...t });
}));

router.get('/:id', requirePerm('expenses.view'), ah(async (req, res) => {
  res.json(await getExpense({ query }, Number(req.params.id)));
}));

router.get('/:id/attachment', requirePerm('expenses.view'), ah(async (req, res) => {
  const e = await getExpense({ query }, Number(req.params.id));
  if (!e.attachment_path) throw notFound('Aucun justificatif');
  res.download(path.join(config.uploadDir, path.basename(e.attachment_path)), e.attachment_name || 'justificatif');
}));

/**
 * Décaissement en espèces. Contrôles : caisse ouverte choisie, solde suffisant (jamais négatif),
 * et plafond journalier des dépenses en espèces (toutes caisses) : au-delà, seul un utilisateur
 * habilité à valider les dépenses peut décaisser, et une alerte est levée.
 */
async function disburse(db, req, e, registerId = null) {
  const session = await requireOpenSession(db, registerId);
  const { finance } = await getSettings();
  const limit = finance.cash_expense_daily_limit;
  if (limit) {
    await db.query('SELECT pg_advisory_xact_lock(4712)'); // décaissements concurrents : plafond contrôlé une fois pour toutes
    const { rows: [t] } = await db.query(
      `SELECT coalesce(sum(amount), 0)::bigint AS total FROM cash_movements
       WHERE category = 'depense' AND created_at >= CURRENT_DATE AND created_at < CURRENT_DATE + 1`);
    const after = Number(t.total) + e.amount;
    if (after > limit) {
      if (!can(req.user, 'expenses.validate')) {
        const err = badRequest(`Plafond journalier des dépenses en espèces atteint (${fmtGNF(Number(t.total))} / ${fmtGNF(limit)}) : décaissement réservé au responsable.`);
        err.code = 'CASH_EXPENSE_LIMIT';
        throw err;
      }
      await raiseAlert(db, req.ctx, {
        category: 'financiere', type: 'plafond_depenses_especes', severity: 'moyenne',
        title: `Plafond journalier des dépenses en espèces dépassé : ${fmtGNF(after)} / ${fmtGNF(limit)}`,
        details: { message: `Décaissement ${e.number} (${fmtGNF(e.amount)}) autorisé par ${req.user.fullName}` },
        refType: 'expense', refId: e.id, userId: req.user.id, link: `/depenses?id=${e.id}`,
      });
    }
  }
  await cashMovement(db, req, { sessionId: session.id, direction: 'out', category: 'depense', amount: e.amount, refType: 'expense', refId: e.id, note: e.reason });
  await db.query('UPDATE expenses SET disbursed = TRUE, disbursed_by = $2, disbursed_at = now(), cash_session_id = $3 WHERE id = $1', [e.id, req.user.id, session.id]);
  await audit(db, req.ctx, {
    action: 'expense.disburse', entityType: 'expense', entityId: e.id,
    summary: `Décaissement ${e.number} — ${fmtGNF(e.amount)} (${e.category})`, feed: { kind: 'expense', amount: e.amount },
  });
  req.ctx.emit('perm:dashboard.finance', 'stats', { kind: 'expense' });
}

router.post('/', requirePerm('expenses.create'), upload.single('attachment'), ah(async (req, res) => {
  const d = parse(z.object({
    category: z.string().trim().min(2).max(60),
    amount: z.coerce.number().int().min(1),
    reason: z.string().trim().min(3).max(500),
    beneficiary: z.string().trim().max(150).optional().nullable(),
    supplier_id: z.coerce.number().int().positive().optional().nullable().or(z.literal('').transform(() => null)),
    expense_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('').transform(() => undefined)),
    pay_from_cash: z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')]).optional(),
    register_id: z.coerce.number().int().positive().optional().nullable().or(z.literal('').transform(() => null)),
  }), req.body);
  const settings = await getSettings();
  const requiresValidation = d.amount >= settings.finance.expense_validation_threshold && !can(req.user, 'expenses.validate');
  const expense = await tx(async (db) => {
    const number = await nextNumber(db, 'expense', 'DEP');
    const status = requiresValidation ? 'en_attente' : 'validee';
    const { rows: [e] } = await db.query(
      `INSERT INTO expenses (site_id, number, category, amount, reason, beneficiary, supplier_id, expense_date, attachment_path, attachment_name,
         status, requires_validation, validated_by, validated_at, pay_from_cash, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,coalesce($8::date, CURRENT_DATE),$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [req.user.siteId, number, d.category, d.amount, d.reason, d.beneficiary || null, d.supplier_id || null, d.expense_date || null,
        req.file?.filename || null, req.file?.originalname || null, status, requiresValidation,
        requiresValidation ? null : req.user.id, requiresValidation ? null : new Date(), !!d.pay_from_cash, req.user.id]);
    await audit(db, req.ctx, {
      action: 'expense.create', entityType: 'expense', entityId: e.id,
      summary: `Dépense ${number} — ${fmtGNF(d.amount)} (${d.category}) : ${d.reason}${requiresValidation ? ' — en attente de validation' : ''}`,
      newValue: { amount: d.amount, category: d.category, beneficiary: d.beneficiary, status },
      feed: { kind: 'expense', amount: d.amount },
    });
    await notify(db, req.ctx, {
      permission: requiresValidation ? 'expenses.validate' : 'dashboard.finance', type: 'expense', icon: '💰',
      title: requiresValidation ? 'Dépense à valider' : 'Nouvelle dépense',
      body: `${fmtGNF(d.amount)} — ${d.category} : ${d.reason} (${req.user.fullName})`, link: `/depenses?id=${e.id}`,
    });
    // Dépense inhabituelle : au-dessus du seuil ou > 3× la moyenne de la catégorie (90 jours)
    const { rows: [avg] } = await db.query(
      `SELECT avg(amount)::bigint AS avg, count(*)::int AS n FROM expenses
       WHERE category = $1 AND status = 'validee' AND id <> $2 AND created_at > now() - interval '90 days'`, [d.category, e.id]);
    const unusual = d.amount >= settings.finance.unusual_expense_threshold || (avg.n >= 3 && d.amount > 3 * avg.avg);
    if (unusual) {
      await raiseAlert(db, req.ctx, {
        category: 'financiere', type: 'depense_inhabituelle', severity: 'moyenne',
        title: `Dépense inhabituelle : ${fmtGNF(d.amount)} (${d.category})`,
        details: { message: `${d.reason} — par ${req.user.fullName}${avg.n ? ` (moyenne catégorie : ${fmtGNF(avg.avg)})` : ''}` },
        refType: 'expense', refId: e.id, userId: req.user.id, link: `/depenses?id=${e.id}`,
      });
    }
    if (status === 'validee' && d.pay_from_cash) {
      if (!can(req.user, 'expenses.disburse') && !can(req.user, 'cash.operate')) throw badRequest('Vous n\'êtes pas autorisé à décaisser.');
      await disburse(db, req, e, d.register_id ?? null);
    }
    req.ctx.emit('perm:dashboard.finance', 'stats', { kind: 'expense' });
    return getExpense(db, e.id);
  });
  res.status(201).json(expense);
}));

router.post('/:id/validate', requirePerm('expenses.validate'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const d = parse(z.object({ decision: z.enum(['validee', 'refusee']), comment: z.string().trim().max(500).optional().nullable() }), req.body);
  if (d.decision === 'refusee' && !d.comment) throw badRequest('Un motif de refus est obligatoire.');
  const out = await tx(async (db) => {
    const { rows: [e] } = await db.query('SELECT * FROM expenses WHERE id = $1 FOR UPDATE', [id]);
    if (!e) throw notFound('Dépense introuvable');
    if (e.status !== 'en_attente') throw badRequest('Cette dépense a déjà été traitée.');
    await db.query(
      'UPDATE expenses SET status = $2, validated_by = $3, validated_at = now(), validation_comment = $4, updated_at = now() WHERE id = $1',
      [id, d.decision, req.user.id, d.comment || null]);
    await audit(db, req.ctx, {
      action: d.decision === 'validee' ? 'expense.validate' : 'expense.reject', entityType: 'expense', entityId: id,
      summary: `Dépense ${e.number} ${d.decision === 'validee' ? 'validée' : 'refusée'} — ${fmtGNF(e.amount)}`,
      oldValue: { status: e.status }, newValue: { status: d.decision }, reason: d.comment || null,
    });
    const { rows: [creator] } = await db.query('SELECT id FROM users WHERE id = $1', [e.created_by]);
    if (creator && creator.id !== req.user.id) {
      await db.query(
        `INSERT INTO notifications (user_id, type, icon, title, body, link) VALUES ($1,'expense',$2,$3,$4,$5)`,
        [creator.id, d.decision === 'validee' ? '✅' : '❌', `Dépense ${d.decision === 'validee' ? 'validée' : 'refusée'}`,
          `${e.number} — ${fmtGNF(e.amount)}${d.comment ? ` : ${d.comment}` : ''}`, `/depenses?id=${id}`]);
      req.ctx.emit(`user:${creator.id}`, 'notification', { title: `Dépense ${d.decision === 'validee' ? 'validée' : 'refusée'}` });
    }
    req.ctx.emit('perm:dashboard.finance', 'stats', { kind: 'expense' });
    return getExpense(db, id);
  });
  res.json(out);
}));

router.post('/:id/disburse', requirePerm('expenses.disburse', 'cash.operate'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const { register_id: registerId } = parse(z.object({ register_id: z.coerce.number().int().positive().optional().nullable() }), req.body || {});
  const out = await tx(async (db) => {
    const { rows: [e] } = await db.query('SELECT * FROM expenses WHERE id = $1 FOR UPDATE', [id]);
    if (!e) throw notFound('Dépense introuvable');
    if (e.status !== 'validee') throw badRequest('Seule une dépense validée peut être décaissée.');
    if (e.disbursed) throw badRequest('Dépense déjà décaissée.');
    await disburse(db, req, e, registerId ?? null);
    return getExpense(db, id);
  });
  res.json(out);
}));

router.post('/:id/cancel', requirePerm('expenses.validate'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const { reason } = parse(z.object({ reason: z.string().trim().min(3) }), req.body);
  const out = await tx(async (db) => {
    const { rows: [e] } = await db.query('SELECT * FROM expenses WHERE id = $1 FOR UPDATE', [id]);
    if (!e) throw notFound('Dépense introuvable');
    if (e.disbursed) throw badRequest('Dépense déjà décaissée : elle ne peut plus être annulée.');
    if (e.status === 'annulee') throw badRequest('Déjà annulée.');
    await db.query(`UPDATE expenses SET status = 'annulee', validation_comment = $2, updated_at = now() WHERE id = $1`, [id, reason]);
    await audit(db, req.ctx, { action: 'expense.cancel', entityType: 'expense', entityId: id, summary: `Annulation de la dépense ${e.number}`, oldValue: { status: e.status }, newValue: { status: 'annulee' }, reason });
    return getExpense(db, id);
  });
  res.json(out);
}));

export default router;
