import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../db/pool.js';
import { ah, parse, notFound, badRequest } from '../lib/errors.js';
import { requirePerm } from '../lib/auth.js';
import { audit, diff } from '../lib/audit.js';
import { notify, raiseAlert } from '../lib/notify.js';
import { nextNumber } from '../lib/numbering.js';
import { fmtGNF, paging, addPeriod } from '../lib/helpers.js';

const router = Router();

// ------------------------------------------------------------ Catalogue d'examens
const examSchema = z.object({
  code: z.string().trim().max(30).optional().nullable(),
  name: z.string().trim().min(2).max(150),
  category: z.string().trim().max(80).optional().nullable(),
  price: z.coerce.number().int().min(0),
  unit: z.string().trim().max(30).optional().nullable(),
  reference_range: z.string().trim().max(100).optional().nullable(),
  active: z.boolean().optional(),
});
const EXAM_FIELDS = Object.keys(examSchema.shape);

router.get('/exams', ah(async (req, res) => {
  const { rows } = await query(`SELECT * FROM lab_exam_types ${req.query.all === '1' ? '' : 'WHERE active'} ORDER BY category NULLS LAST, name`);
  res.json(rows);
}));

router.post('/exams', requirePerm('lab.manage'), ah(async (req, res) => {
  const d = parse(examSchema, req.body);
  const out = await tx(async (db) => {
    const { rows: [e] } = await db.query(
      `INSERT INTO lab_exam_types (code, name, category, price, unit, reference_range) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [d.code || null, d.name, d.category || null, d.price, d.unit || null, d.reference_range || null]);
    await audit(db, req.ctx, { action: 'lab_exam.create', entityType: 'lab_exam_type', entityId: e.id, summary: `Nouvel examen : ${e.name} (${fmtGNF(e.price)})`, feed: false });
    return e;
  });
  res.status(201).json(out);
}));

router.put('/exams/:id', requirePerm('lab.manage'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const d = parse(examSchema.partial(), req.body);
  const out = await tx(async (db) => {
    const { rows: [before] } = await db.query('SELECT * FROM lab_exam_types WHERE id = $1 FOR UPDATE', [id]);
    if (!before) throw notFound('Examen introuvable');
    const sets = []; const vals = [];
    for (const f of EXAM_FIELDS) if (d[f] !== undefined) { vals.push(d[f]); sets.push(`${f} = $${vals.length}`); }
    if (!sets.length) return before;
    vals.push(id);
    const { rows: [e] } = await db.query(`UPDATE lab_exam_types SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length} RETURNING *`, vals);
    const ch = diff(before, d, EXAM_FIELDS);
    if (ch) {
      const priceChanged = ch.newValue.price !== undefined;
      await audit(db, req.ctx, { action: priceChanged ? 'lab_exam.price_change' : 'lab_exam.update', entityType: 'lab_exam_type', entityId: id, summary: `Modification de l'examen ${e.name}`, ...ch });
      if (priceChanged) {
        await raiseAlert(db, req.ctx, {
          category: 'systeme', type: 'changement_prix', severity: 'moyenne', title: `Changement de tarif : ${e.name}`,
          details: { message: `${fmtGNF(before.price)} → ${fmtGNF(e.price)} par ${req.user.fullName}` }, refType: 'lab_exam_type', refId: id,
        });
      }
    }
    return e;
  });
  res.json(out);
}));

// ------------------------------------------------------------ Demandes
async function getRequest(db, id) {
  const { rows: [r] } = await db.query(
    `SELECT lr.*, p.patient_number, p.first_name || ' ' || p.last_name AS patient_name, p.sex AS patient_sex, p.birth_date AS patient_birth_date,
       u.first_name || ' ' || u.last_name AS requested_by_name, c.number AS consultation_number
     FROM lab_requests lr JOIN patients p ON p.id = lr.patient_id LEFT JOIN users u ON u.id = lr.requested_by
     LEFT JOIN consultations c ON c.id = lr.consultation_id WHERE lr.id = $1`, [id]);
  if (!r) throw notFound('Demande introuvable');
  const { rows: items } = await db.query(
    `SELECT i.*, t.name, t.code, t.category, t.unit AS default_unit, t.reference_range AS default_range,
       u.first_name || ' ' || u.last_name AS technician_name
     FROM lab_request_items i JOIN lab_exam_types t ON t.id = i.exam_type_id LEFT JOIN users u ON u.id = i.technician_id
     WHERE i.request_id = $1 ORDER BY i.id`, [id]);
  return { ...r, items };
}

router.get('/requests', requirePerm('lab.view', 'lab.request', 'lab.results'), ah(async (req, res) => {
  const { limit, offset } = paging(req);
  const where = []; const vals = [];
  addPeriod(where, vals, 'lr.created_at', req.query);
  if (req.query.status) { vals.push(req.query.status); where.push(`lr.status = $${vals.length}`); }
  if (req.query.patient_id) { vals.push(Number(req.query.patient_id)); where.push(`lr.patient_id = $${vals.length}`); }
  if (req.query.q) { vals.push(`%${String(req.query.q).toLowerCase()}%`); where.push(`(lower(lr.number) LIKE $${vals.length} OR lower(p.first_name || ' ' || p.last_name) LIKE $${vals.length})`); }
  vals.push(limit, offset);
  const { rows } = await query(
    `SELECT lr.id, lr.number, lr.status, lr.priority, lr.created_at, lr.completed_at, lr.amount, lr.payment_status,
       lr.patient_id, p.patient_number, p.first_name || ' ' || p.last_name AS patient_name,
       u.first_name || ' ' || u.last_name AS requested_by_name,
       (SELECT string_agg(t.name, ', ' ORDER BY t.name) FROM lab_request_items i JOIN lab_exam_types t ON t.id = i.exam_type_id WHERE i.request_id = lr.id) AS exams,
       count(*) OVER()::int AS total
     FROM lab_requests lr JOIN patients p ON p.id = lr.patient_id LEFT JOIN users u ON u.id = lr.requested_by
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY (lr.status IN ('demandee','en_cours')) DESC, (lr.priority = 'urgente') DESC, lr.created_at DESC
     LIMIT $${vals.length - 1} OFFSET $${vals.length}`, vals);
  res.json({ items: rows.map(({ total, ...r }) => r), total: rows[0]?.total || 0 });
}));

router.get('/requests/:id', requirePerm('lab.view', 'lab.request', 'lab.results'), ah(async (req, res) => {
  res.json(await getRequest({ query }, Number(req.params.id)));
}));

// Médecin → Demande d'examen
router.post('/requests', requirePerm('lab.request'), ah(async (req, res) => {
  const d = parse(z.object({
    patient_id: z.coerce.number().int().positive(),
    consultation_id: z.coerce.number().int().positive().optional().nullable(),
    exam_type_ids: z.array(z.coerce.number().int().positive()).min(1),
    priority: z.enum(['normale', 'urgente']).default('normale'),
    notes: z.string().max(1000).optional().nullable(),
  }), req.body);
  const out = await tx(async (db) => {
    const { rows: [p] } = await db.query('SELECT id, first_name, last_name FROM patients WHERE id = $1', [d.patient_id]);
    if (!p) throw badRequest('Patient introuvable');
    const { rows: exams } = await db.query('SELECT * FROM lab_exam_types WHERE id = ANY($1::int[]) AND active', [d.exam_type_ids]);
    if (exams.length !== new Set(d.exam_type_ids).size) throw badRequest('Examen inconnu ou inactif.');
    const number = await nextNumber(db, 'lab_request', 'LAB');
    const amount = exams.reduce((s, e) => s + e.price, 0);
    const { rows: [r] } = await db.query(
      `INSERT INTO lab_requests (site_id, number, patient_id, consultation_id, requested_by, priority, notes, amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [req.user.siteId, number, p.id, d.consultation_id || null, req.user.id, d.priority, d.notes || null, amount]);
    for (const e of exams) {
      await db.query('INSERT INTO lab_request_items (request_id, exam_type_id, price, unit, reference_range) VALUES ($1,$2,$3,$4,$5)',
        [r.id, e.id, e.price, e.unit, e.reference_range]);
    }
    await audit(db, req.ctx, {
      action: 'lab.request', entityType: 'lab_request', entityId: r.id,
      summary: `Examen demandé ${number} — ${p.first_name} ${p.last_name} (${exams.map((e) => e.name).join(', ')})`,
      feed: { kind: 'lab' },
    });
    await notify(db, req.ctx, {
      permission: 'lab.results', type: 'lab', icon: '🧪', title: d.priority === 'urgente' ? 'Examen URGENT demandé' : 'Nouvel examen demandé',
      body: `${p.first_name} ${p.last_name} — ${exams.map((e) => e.name).join(', ')}`, link: `/laboratoire/${r.id}`,
    });
    return getRequest(db, r.id);
  });
  res.status(201).json(out);
}));

// Laboratoire → Résultat
router.put('/requests/:id/results', requirePerm('lab.results'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const d = parse(z.object({
    items: z.array(z.object({
      id: z.coerce.number().int().positive(),
      result_value: z.string().max(200).optional().nullable(),
      result_text: z.string().max(5000).optional().nullable(),
      unit: z.string().max(30).optional().nullable(),
      reference_range: z.string().max(100).optional().nullable(),
      abnormal: z.boolean().optional().nullable(),
    })),
    complete: z.boolean().default(false),
  }), req.body);
  const out = await tx(async (db) => {
    const { rows: [r] } = await db.query('SELECT * FROM lab_requests WHERE id = $1 FOR UPDATE', [id]);
    if (!r) throw notFound('Demande introuvable');
    if (['annulee'].includes(r.status)) throw badRequest('Demande annulée.');
    const wasCompleted = r.status === 'terminee';
    for (const it of d.items) {
      const { rows: [before] } = await db.query('SELECT * FROM lab_request_items WHERE id = $1 AND request_id = $2', [it.id, id]);
      if (!before) throw badRequest(`Ligne d'examen inconnue (#${it.id})`);
      await db.query(
        `UPDATE lab_request_items SET result_value = $2, result_text = $3, unit = coalesce($4, unit), reference_range = coalesce($5, reference_range),
           abnormal = $6, technician_id = $7, result_at = now() WHERE id = $1`,
        [it.id, it.result_value ?? null, it.result_text ?? null, it.unit ?? null, it.reference_range ?? null, it.abnormal ?? null, req.user.id]);
      if (wasCompleted) {
        const ch = diff(before, it, ['result_value', 'result_text', 'abnormal']);
        if (ch) await audit(db, req.ctx, { action: 'lab.result_correction', entityType: 'lab_request', entityId: id, summary: `Correction de résultat — ${r.number}`, ...ch, feed: false });
      }
    }
    const status = d.complete ? 'terminee' : 'en_cours';
    await db.query(`UPDATE lab_requests SET status = $2, completed_at = CASE WHEN $2 = 'terminee' THEN coalesce(completed_at, now()) END WHERE id = $1`, [id, status]);
    if (d.complete && !wasCompleted) {
      await audit(db, req.ctx, { action: 'lab.results', entityType: 'lab_request', entityId: id, summary: `Résultats disponibles — ${r.number}`, feed: { kind: 'lab' } });
      if (r.requested_by && r.requested_by !== req.user.id) {
        await db.query(`INSERT INTO notifications (user_id, type, icon, title, body, link) VALUES ($1,'lab','🧪','Résultats disponibles',$2,$3)`,
          [r.requested_by, r.number, `/laboratoire/${id}`]);
        req.ctx.emit(`user:${r.requested_by}`, 'notification', { title: 'Résultats disponibles' });
      }
    }
    return getRequest(db, id);
  });
  res.json(out);
}));

router.post('/requests/:id/cancel', requirePerm('lab.request', 'lab.results'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const { reason } = parse(z.object({ reason: z.string().trim().min(3) }), req.body);
  await tx(async (db) => {
    const { rows: [r] } = await db.query('SELECT * FROM lab_requests WHERE id = $1 FOR UPDATE', [id]);
    if (!r) throw notFound('Demande introuvable');
    if (r.status === 'annulee') throw badRequest('Déjà annulée.');
    if (r.paid_amount > 0) throw badRequest('Demande payée : annulez ou remboursez d\'abord le paiement.');
    await db.query(`UPDATE lab_requests SET status = 'annulee', cancel_reason = $2 WHERE id = $1`, [id, reason]);
    await audit(db, req.ctx, { action: 'lab.cancel', entityType: 'lab_request', entityId: id, summary: `Annulation de la demande ${r.number}`, reason, oldValue: { status: r.status }, newValue: { status: 'annulee' } });
  });
  res.json({ ok: true });
}));

export default router;
