import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../db/pool.js';
import { ah, parse, notFound, badRequest, forbidden } from '../lib/errors.js';
import { requirePerm, can } from '../lib/auth.js';
import { audit, diff } from '../lib/audit.js';
import { notify, raiseAlert } from '../lib/notify.js';
import { nextNumber } from '../lib/numbering.js';
import { fmtGNF, paging, addPeriod } from '../lib/helpers.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { canLabResults, encJson, decJson, patientRef, logMedicalRead } from '../lib/medical.js';
import { getSettings } from '../lib/settings.js';
import { sendPdf, fmtDate, fmtDateTime, ageOf } from '../lib/documents.js';

const router = Router();

// Nombre facultatif : '' ou null → null (jamais 0 par conversion implicite)
const optionalNumber = z.preprocess((v) => (v === '' ? null : v), z.coerce.number().finite().nullable().optional());

// ------------------------------------------------------------ Catalogue d'examens
const examSchema = z.object({
  code: z.string().trim().max(30).optional().nullable(),
  name: z.string().trim().min(2).max(150),
  category: z.string().trim().max(80).optional().nullable(),
  price: z.coerce.number().int().min(0),
  unit: z.string().trim().max(30).optional().nullable(),
  reference_range: z.string().trim().max(100).optional().nullable(),
  ref_min: optionalNumber,
  ref_max: optionalNumber,
  active: z.boolean().optional(),
});
const EXAM_FIELDS = Object.keys(examSchema.shape);
const checkRange = (d) => { if (d.ref_min != null && d.ref_max != null && d.ref_min > d.ref_max) throw badRequest('Valeur de référence minimale supérieure à la maximale.'); };

/** Valeur numérique d'un résultat (« 1,25 », « 7.2 g/dL »…) ou null. */
export function numericValue(v) {
  if (v === null || v === undefined) return null;
  const m = String(v).trim().replace(',', '.').match(/^[<>≤≥]?\s*(-?\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}
/** Indicateur d'anomalie : « bas » / « haut » selon les valeurs de référence, sinon null. */
export function rangeFlag(value, min, max) {
  const n = numericValue(value);
  if (n === null || ((min === null || min === undefined) && (max === null || max === undefined))) return null;
  if (min !== null && min !== undefined && n < Number(min)) return 'bas';
  if (max !== null && max !== undefined && n > Number(max)) return 'haut';
  return 'normal';
}

router.get('/exams', ah(async (req, res) => {
  const { rows } = await query(`SELECT * FROM lab_exam_types ${req.query.all === '1' ? '' : 'WHERE active'} ORDER BY category NULLS LAST, name`);
  res.json(rows);
}));

router.post('/exams', requirePerm('lab.manage'), ah(async (req, res) => {
  const d = parse(examSchema, req.body);
  checkRange(d);
  const out = await tx(async (db) => {
    const { rows: [e] } = await db.query(
      `INSERT INTO lab_exam_types (code, name, category, price, unit, reference_range, ref_min, ref_max) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [d.code || null, d.name, d.category || null, d.price, d.unit || null, d.reference_range || null, d.ref_min ?? null, d.ref_max ?? null]);
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
    checkRange({ ref_min: d.ref_min !== undefined ? d.ref_min : before.ref_min, ref_max: d.ref_max !== undefined ? d.ref_max : before.ref_max });
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
/** Résultats et renseignements cliniques déchiffrés uniquement pour les rôles habilités. */
function presentRequest(r, user) {
  const allowed = canLabResults(user);
  return {
    ...r,
    notes: allowed ? decrypt(r.notes) : undefined,
    results_restricted: !allowed || undefined,
    items: r.items.map(({ result, ...it }) => {
      if (!allowed) return it;
      const x = decJson(result, {});
      return { ...it, result_value: x.value ?? null, result_text: x.text ?? null, abnormal: x.abnormal ?? null, flag: x.flag ?? null, abnormal_manual: !!x.manual };
    }),
  };
}

async function getRequest(db, id) {
  const { rows: [r] } = await db.query(
    `SELECT lr.*, p.patient_number, p.first_name || ' ' || p.last_name AS patient_name, p.sex AS patient_sex, p.birth_date AS patient_birth_date,
       u.first_name || ' ' || u.last_name AS requested_by_name, c.number AS consultation_number,
       v.first_name || ' ' || v.last_name AS validated_by_name
     FROM lab_requests lr JOIN patients p ON p.id = lr.patient_id LEFT JOIN users u ON u.id = lr.requested_by
     LEFT JOIN consultations c ON c.id = lr.consultation_id LEFT JOIN users v ON v.id = lr.validated_by WHERE lr.id = $1`, [id]);
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
  const r = await getRequest({ query }, Number(req.params.id));
  if (canLabResults(req.user)) {
    await logMedicalRead(req, { patientId: r.patient_id, patientNumber: r.patient_number, access: 'resultats_laboratoire', ref: r.number });
  }
  res.json(presentRequest(r, req.user));
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
    const { rows: [p] } = await db.query('SELECT id, patient_number FROM patients WHERE id = $1', [d.patient_id]);
    if (!p) throw badRequest('Patient introuvable');
    const { rows: exams } = await db.query('SELECT * FROM lab_exam_types WHERE id = ANY($1::int[]) AND active', [d.exam_type_ids]);
    if (exams.length !== new Set(d.exam_type_ids).size) throw badRequest('Examen inconnu ou inactif.');
    const number = await nextNumber(db, 'lab_request', 'LAB');
    const amount = exams.reduce((s, e) => s + e.price, 0);
    const { rows: [r] } = await db.query(
      `INSERT INTO lab_requests (site_id, number, patient_id, consultation_id, requested_by, priority, notes, amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [req.user.siteId, number, p.id, d.consultation_id || null, req.user.id, d.priority, encrypt(d.notes || null), amount]);
    for (const e of exams) {
      await db.query('INSERT INTO lab_request_items (request_id, exam_type_id, price, unit, reference_range, ref_min, ref_max) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [r.id, e.id, e.price, e.unit, e.reference_range, e.ref_min, e.ref_max]);
    }
    await audit(db, req.ctx, {
      action: 'lab.request', entityType: 'lab_request', entityId: r.id,
      // ni nom de patient ni intitulé d'examen dans le journal / fil d'activité
      summary: `Examen demandé ${number} — ${patientRef(p)} (${exams.length} examen(s))`,
      feed: { kind: 'lab' },
    });
    await notify(db, req.ctx, {
      permission: 'lab.results', type: 'lab', icon: '🧪', title: d.priority === 'urgente' ? 'Examen URGENT demandé' : 'Nouvel examen demandé',
      body: `${number} — ${exams.length} examen(s)`, link: `/laboratoire/${r.id}`,
    });
    return presentRequest(await getRequest(db, r.id), req.user);
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
      ref_min: optionalNumber,
      ref_max: optionalNumber,
      abnormal: z.boolean().optional().nullable(),
    })),
    complete: z.boolean().default(false),
  }), req.body);
  const out = await tx(async (db) => {
    const { rows: [r] } = await db.query('SELECT * FROM lab_requests WHERE id = $1 FOR UPDATE', [id]);
    if (!r) throw notFound('Demande introuvable');
    if (['annulee'].includes(r.status)) throw badRequest('Demande annulée.');
    // Résultats validés : seule une personne habilitée à valider peut les corriger (la validation est alors levée)
    if (r.validated_at && !can(req.user, 'lab.validate')) throw forbidden('Résultats validés : correction réservée aux personnes habilitées à valider.');
    const wasCompleted = r.status === 'terminee';
    let corrected = 0;
    for (const it of d.items) {
      const { rows: [before] } = await db.query('SELECT * FROM lab_request_items WHERE id = $1 AND request_id = $2', [it.id, id]);
      if (!before) throw badRequest(`Ligne d'examen inconnue (#${it.id})`);
      const prev = decJson(before.result, {});
      const min = it.ref_min !== undefined ? it.ref_min : before.ref_min;
      const max = it.ref_max !== undefined ? it.ref_max : before.ref_max;
      if (min != null && max != null && Number(min) > Number(max)) throw badRequest('Valeur de référence minimale supérieure à la maximale.');
      // Anomalie : calculée d'après les valeurs de référence, sauf indication explicite du laboratoire
      const flag = rangeFlag(it.result_value, min, max);
      const abnormal = it.abnormal ?? (flag === 'bas' || flag === 'haut' ? true : flag === 'normal' ? false : null);
      const next = { value: it.result_value ?? null, text: it.result_text ?? null, abnormal, flag: flag === 'normal' ? null : flag, manual: it.abnormal != null };
      await db.query(
        `UPDATE lab_request_items SET result = $2, unit = coalesce($3, unit), reference_range = coalesce($4, reference_range),
           ref_min = $6, ref_max = $7, technician_id = $5, result_at = now() WHERE id = $1`,
        [it.id, encJson(next), it.unit ?? null, it.reference_range ?? null, req.user.id, min ?? null, max ?? null]);
      const norm = (x) => JSON.stringify({ value: x.value ?? null, text: x.text ?? null, abnormal: x.abnormal ?? null });
      if (wasCompleted && norm(prev) !== norm(next)) corrected++;
    }
    if (corrected && r.validated_at) {
      await db.query('UPDATE lab_requests SET validated_at = NULL, validated_by = NULL WHERE id = $1', [id]);
      await audit(db, req.ctx, { action: 'lab.validation_reset', entityType: 'lab_request', entityId: id, summary: `Validation levée après correction — ${r.number}`, feed: false });
    }
    // Correction après validation : tracée, sans recopier les résultats en clair dans le journal
    if (corrected) {
      await audit(db, req.ctx, {
        action: 'lab.result_correction', entityType: 'lab_request', entityId: id, summary: `Correction de résultat — ${r.number}`,
        oldValue: { results: '[résultat médical]' }, newValue: { results: '[résultat corrigé]', lines: corrected }, feed: false,
      });
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
    return presentRequest(await getRequest(db, id), req.user);
  });
  res.json(out);
}));

// Validation biologique : fige les résultats d'une demande terminée
router.post('/requests/:id/validate', requirePerm('lab.validate'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const out = await tx(async (db) => {
    const { rows: [r] } = await db.query('SELECT * FROM lab_requests WHERE id = $1 FOR UPDATE', [id]);
    if (!r) throw notFound('Demande introuvable');
    if (r.status !== 'terminee') throw badRequest('Seuls des résultats complets (demande terminée) peuvent être validés.');
    if (r.validated_at) throw badRequest('Résultats déjà validés.');
    const { rows: [{ missing }] } = await db.query('SELECT count(*)::int AS missing FROM lab_request_items WHERE request_id = $1 AND result IS NULL', [id]);
    if (missing) throw badRequest(`${missing} examen(s) sans résultat.`);
    await db.query('UPDATE lab_requests SET validated_at = now(), validated_by = $2 WHERE id = $1', [id, req.user.id]);
    await audit(db, req.ctx, { action: 'lab.validate', entityType: 'lab_request', entityId: id, summary: `Résultats validés — ${r.number}`, feed: false });
    if (r.requested_by && r.requested_by !== req.user.id) {
      await db.query(`INSERT INTO notifications (user_id, type, icon, title, body, link) VALUES ($1,'lab','✅','Résultats validés',$2,$3)`,
        [r.requested_by, r.number, `/laboratoire/${id}`]);
      req.ctx.emit(`user:${r.requested_by}`, 'notification', { title: 'Résultats validés' });
    }
    return presentRequest(await getRequest(db, id), req.user);
  });
  res.json(out);
}));

// Compte rendu d'examens (PDF A4)
router.get('/requests/:id/report.pdf', requirePerm('lab.view', 'lab.request', 'lab.results'), ah(async (req, res) => {
  if (!canLabResults(req.user)) throw forbidden('Accès aux résultats non autorisé.');
  const r = presentRequest(await getRequest({ query }, Number(req.params.id)), req.user);
  if (r.status !== 'terminee') throw badRequest('Compte rendu disponible une fois les résultats saisis (demande terminée).');
  const { clinic } = await getSettings();
  await logMedicalRead(req, { patientId: r.patient_id, patientNumber: r.patient_number, access: 'compte_rendu_pdf', ref: r.number });
  sendPdf(res, {
    filename: `compte-rendu-${r.number}.pdf`, clinic, title: 'Compte rendu d\'examens de laboratoire', type: 'compte_rendu', number: r.number,
    issuedAt: r.validated_at || r.completed_at, watermark: r.validated_at ? null : 'RÉSULTATS NON VALIDÉS',
  }, (doc, h) => {
    const age = ageOf(r.patient_birth_date, r.created_at);
    h.row('Patient :', `${r.patient_name} (${r.patient_number})`);
    h.row('Âge / sexe :', `${age !== null ? `${age} ans` : '—'} / ${r.patient_sex === 'F' ? 'Féminin' : r.patient_sex === 'M' ? 'Masculin' : '—'}`);
    h.row('Prescripteur :', r.requested_by_name ? `Dr ${r.requested_by_name}` : '—');
    h.row('Demande :', `${r.number} du ${fmtDateTime(r.created_at)}${r.priority === 'urgente' ? ' — URGENT' : ''}`);
    h.row('Résultats :', `${fmtDateTime(r.completed_at)}${r.validated_at ? ` — validés par ${r.validated_by_name} le ${fmtDateTime(r.validated_at)}` : ' — non validés'}`);
    h.section('Résultats');
    const x = [50, 235, 330, 385, 480];
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#555');
    const y0 = doc.y;
    doc.text('Examen', x[0], y0); doc.text('Résultat', x[1], y0); doc.text('Unité', x[2], y0); doc.text('Référence', x[3], y0, { width: 95 });
    doc.fillColor('#111');
    doc.y = y0 + 18; doc.x = 50;
    for (const it of r.items) {
      h.ensureSpace(34);
      const y = doc.y;
      const ref = it.ref_min != null || it.ref_max != null
        ? `${it.ref_min ?? '…'} – ${it.ref_max ?? '…'}` : (it.reference_range || it.default_range || '—');
      const bad = it.abnormal === true;
      doc.font('Helvetica-Bold').fontSize(10).text(it.name, x[0], y, { width: 180 });
      const yName = doc.y;
      doc.font(bad ? 'Helvetica-Bold' : 'Helvetica').fillColor(bad ? '#b91c1c' : '#111')
        .text(`${it.result_value ?? '—'}${it.flag === 'haut' ? ' (H)' : it.flag === 'bas' ? ' (B)' : ''}`, x[1], y, { width: 90 });
      doc.fillColor('#111').font('Helvetica').text(it.unit || it.default_unit || '', x[2], y, { width: 50 });
      doc.text(ref, x[3], y, { width: 95 });
      doc.font('Helvetica-Bold').fillColor(bad ? '#b91c1c' : '#111').text(bad ? (it.flag === 'bas' ? 'BAS' : it.flag === 'haut' ? 'ÉLEVÉ' : 'ANORMAL') : '', x[4], y, { width: 65 });
      doc.fillColor('#111');
      doc.y = Math.max(yName, doc.y); doc.x = 50;
      if (it.result_text) doc.font('Helvetica').fontSize(9.5).fillColor('#333').text(it.result_text, 60, doc.y, { width: h.W - 10 }).fillColor('#111');
      doc.moveDown(0.4);
    }
    doc.moveDown(0.5).font('Helvetica').fontSize(8.5).fillColor('#555')
      .text('(H) / (B) : valeur au-dessus / au-dessous des valeurs de référence. Les résultats doivent être interprétés par le médecin prescripteur.', 50, doc.y, { width: h.W });
    doc.fillColor('#111');
    h.ensureSpace(80);
    doc.moveDown(2).fontSize(10).text(r.validated_at ? `Validé par ${r.validated_by_name}` : 'Non validé', 50 + h.W / 2, doc.y, { width: h.W / 2, align: 'center' });
    doc.text(`le ${fmtDate(r.validated_at || r.completed_at)}`, { width: h.W / 2, align: 'center' });
  });
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
