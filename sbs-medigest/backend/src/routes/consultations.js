import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../db/pool.js';
import { ah, parse, notFound, badRequest, forbidden } from '../lib/errors.js';
import { requirePerm, can } from '../lib/auth.js';
import { audit, diff } from '../lib/audit.js';
import { notify } from '../lib/notify.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { nextNumber } from '../lib/numbering.js';
import { paging, addPeriod, fmtGNF, refreshPaymentStatus } from '../lib/helpers.js';
import { canClinical, canPrescriptions, canLabResults, encJson, decJson, VITALS as VITAL_FIELDS, patientRef, logMedicalRead } from '../lib/medical.js';
import { loadPrescription, dispensingLines, PRESCRIPTION_STATUS } from '../lib/prescriptions.js';
import { getSettings } from '../lib/settings.js';
import { sendPdf, fmtDate, ageOf } from '../lib/documents.js';

const router = Router();
const VITALS = VITAL_FIELDS;
const CLINICAL = ['observations', 'diagnosis', 'treatment'];
const STATUS_LABEL = { en_attente: 'En attente', en_cours: 'En cours', terminee: 'Terminée', annulee: 'Annulée' };

const num = (min, max) => z.coerce.number().min(min).max(max).optional().nullable();
const baseSchema = z.object({
  patient_id: z.coerce.number().int().positive(),
  doctor_id: z.coerce.number().int().positive().optional().nullable(),
  consulted_at: z.string().datetime({ offset: true }).optional().nullable().or(z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)),
  reason: z.string().trim().max(500).optional().nullable(),
  weight_kg: num(0, 400), temperature_c: num(25, 45), bp_systolic: num(40, 300), bp_diastolic: num(20, 200),
  heart_rate: num(20, 300), spo2: num(40, 100),
  observations: z.string().max(10000).optional().nullable(),
  diagnosis: z.string().max(5000).optional().nullable(),
  treatment: z.string().max(5000).optional().nullable(),
  status: z.enum(['en_attente', 'en_cours', 'terminee']).optional(),
  acts: z.array(z.object({ act_id: z.coerce.number().int().positive(), quantity: z.coerce.number().int().min(1).default(1) })).optional(),
});

/**
 * Données renvoyées selon la fonction :
 *  - observations / diagnostic / traitement : dossier médical ou diagnostic ;
 *  - motif et constantes : personnel soignant (médecin, infirmier) ;
 *  - rien de clinique pour les autres rôles.
 */
function present(c, user) {
  const { vitals, ...out } = c;
  const medical = can(user, 'patients.view_medical') || can(user, 'consultations.diagnose');
  for (const f of CLINICAL) out[f] = medical ? decrypt(c[f]) : undefined;
  if (canClinical(user)) {
    out.reason = decrypt(c.reason);
    Object.assign(out, Object.fromEntries(VITALS.map((k) => [k, null])), decJson(vitals, {}));
  } else {
    out.reason = undefined;
  }
  if (!medical) out.clinical_restricted = true;
  return out;
}

export function presentPrescription(pr) {
  return { ...pr, notes: decrypt(pr.notes), items: decJson(pr.items, []).map((it, i) => ({ id: i + 1, ...it })), status_label: PRESCRIPTION_STATUS[pr.status] };
}

async function recomputeAmount(db, id) {
  await db.query(
    `UPDATE consultations SET amount = coalesce((SELECT sum(quantity * unit_price) FROM consultation_acts WHERE consultation_id = $1), 0),
       updated_at = now() WHERE id = $1`, [id]);
  await refreshPaymentStatus(db, 'consultation', id);
}

async function addActs(db, req, consultationId, acts) {
  for (const a of acts) {
    const { rows: [act] } = await db.query('SELECT id, name, price FROM medical_acts WHERE id = $1 AND active', [a.act_id]);
    if (!act) throw badRequest(`Acte inconnu ou inactif (#${a.act_id})`);
    await db.query(
      `INSERT INTO consultation_acts (consultation_id, act_id, quantity, unit_price, performed_by) VALUES ($1,$2,$3,$4,$5)`,
      [consultationId, act.id, a.quantity, act.price, req.user.id]);
  }
  await recomputeAmount(db, consultationId);
}

async function getFull(db, id, user) {
  const { rows: [c] } = await db.query(
    `SELECT c.*, p.patient_number, p.first_name || ' ' || p.last_name AS patient_name, p.sex AS patient_sex, p.birth_date AS patient_birth_date,
       d.first_name || ' ' || d.last_name AS doctor_name
     FROM consultations c JOIN patients p ON p.id = c.patient_id LEFT JOIN users d ON d.id = c.doctor_id WHERE c.id = $1`, [id]);
  if (!c) throw notFound('Consultation introuvable');
  const { rows: acts } = await db.query(
    `SELECT ca.*, a.name, u.first_name || ' ' || u.last_name AS performed_by_name
     FROM consultation_acts ca JOIN medical_acts a ON a.id = ca.act_id LEFT JOIN users u ON u.id = ca.performed_by
     WHERE ca.consultation_id = $1 ORDER BY ca.id`, [id]);
  const out = present(c, user);
  out.acts = acts;
  if (canPrescriptions(user)) {
    const { rows } = await db.query('SELECT * FROM prescriptions WHERE consultation_id = $1 ORDER BY id', [id]);
    out.prescriptions = rows.map(presentPrescription);
  }
  if (canLabResults(user)) {
    const { rows } = await db.query(
      `SELECT lr.id, lr.number, lr.status, lr.amount, lr.payment_status, string_agg(t.name, ', ' ORDER BY t.name) AS exams
       FROM lab_requests lr JOIN lab_request_items i ON i.request_id = lr.id JOIN lab_exam_types t ON t.id = i.exam_type_id
       WHERE lr.consultation_id = $1 GROUP BY lr.id ORDER BY lr.id`, [id]);
    out.lab_requests = rows;
  }
  if (can(user, 'payments.view')) {
    const { rows } = await db.query(
      `SELECT id, number, receipt_number, amount, method, status, created_at FROM payments
       WHERE source_type = 'consultation' AND source_id = $1 ORDER BY id`, [id]);
    out.payments = rows;
  }
  return out;
}

router.get('/', requirePerm('consultations.view'), ah(async (req, res) => {
  const { limit, offset } = paging(req);
  const where = []; const vals = [];
  addPeriod(where, vals, 'c.consulted_at', req.query);
  if (req.query.status) { vals.push(req.query.status); where.push(`c.status = $${vals.length}`); }
  if (req.query.payment_status) { vals.push(req.query.payment_status); where.push(`c.payment_status = $${vals.length}`); }
  if (req.query.doctor_id) { vals.push(Number(req.query.doctor_id)); where.push(`c.doctor_id = $${vals.length}`); }
  if (req.query.patient_id) { vals.push(Number(req.query.patient_id)); where.push(`c.patient_id = $${vals.length}`); }
  if (req.query.q) {
    vals.push(`%${String(req.query.q).toLowerCase()}%`);
    where.push(`(lower(c.number) LIKE $${vals.length} OR lower(p.first_name || ' ' || p.last_name) LIKE $${vals.length} OR lower(p.patient_number) LIKE $${vals.length})`);
  }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  // Page (index sur la date) et total calculés séparément : un total par fenêtre (count OVER)
  // obligeait à joindre toutes les consultations avant d'en garder 50 (mesuré : 190 ms → < 10 ms).
  const [{ rows }, { rows: [{ total }] }] = await Promise.all([
    query(
      `SELECT c.id, c.number, c.consulted_at, c.reason, c.status, c.amount, c.paid_amount, c.payment_status,
         c.patient_id, p.patient_number, p.first_name || ' ' || p.last_name AS patient_name,
         d.first_name || ' ' || d.last_name AS doctor_name
       FROM consultations c JOIN patients p ON p.id = c.patient_id LEFT JOIN users d ON d.id = c.doctor_id
       ${w} ORDER BY c.consulted_at DESC LIMIT $${vals.length + 1} OFFSET $${vals.length + 2}`, [...vals, limit, offset]),
    query(`SELECT count(*)::int AS total FROM consultations c${req.query.q ? ' JOIN patients p ON p.id = c.patient_id' : ''} ${w}`, vals),
  ]);
  const clinical = canClinical(req.user);
  if (clinical && rows.length) await logMedicalRead(req, { access: 'liste_consultations', count: rows.length });
  res.json({ items: rows.map((r) => ({ ...r, reason: clinical ? decrypt(r.reason) : undefined })), total });
}));

router.get('/:id', requirePerm('consultations.view'), ah(async (req, res) => {
  const c = await getFull({ query }, Number(req.params.id), req.user);
  if (canClinical(req.user) || !c.clinical_restricted) {
    await logMedicalRead(req, { patientId: c.patient_id, patientNumber: c.patient_number, access: 'consultation', ref: c.number });
  }
  res.json(c);
}));

router.post('/', requirePerm('consultations.create'), ah(async (req, res) => {
  const d = parse(baseSchema, req.body);
  if (CLINICAL.some((f) => d[f]) && !can(req.user, 'consultations.diagnose')) throw forbidden('Saisie du diagnostic non autorisée.');
  if (VITALS.some((f) => d[f] != null) && !can(req.user, 'consultations.vitals')) throw forbidden('Saisie des constantes non autorisée.');
  const out = await tx(async (db) => {
    const { rows: [p] } = await db.query('SELECT id, patient_number, first_name, last_name FROM patients WHERE id = $1 AND archived_at IS NULL', [d.patient_id]);
    if (!p) throw badRequest('Patient introuvable');
    if (d.reason && !canClinical(req.user)) throw forbidden('Saisie du motif réservée au personnel soignant.');
    const doctorId = d.doctor_id ?? (req.user.roleCode === 'medecin' ? req.user.id : null);
    const number = await nextNumber(db, 'consultation', 'CONS');
    const { rows: [c] } = await db.query(
      `INSERT INTO consultations (site_id, number, patient_id, doctor_id, consulted_at, reason, vitals,
         observations, diagnosis, treatment, status, created_by)
       VALUES ($1,$2,$3,$4,coalesce($5::timestamptz, now()),$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [req.user.siteId, number, p.id, doctorId, d.consulted_at || null, encrypt(d.reason || null),
        VITALS.some((f) => d[f] != null) ? encJson(Object.fromEntries(VITALS.map((f) => [f, d[f] ?? null]))) : null,
        ...CLINICAL.map((f) => encrypt(d[f] || null)), d.status || 'en_attente', req.user.id]);
    if (d.acts?.length) await addActs(db, req, c.id, d.acts);
    await audit(db, req.ctx, {
      action: 'consultation.create', entityType: 'consultation', entityId: c.id,
      summary: `Consultation ${number} — ${patientRef(p)}`, feed: { kind: 'consultation' },
    });
    req.ctx.emit('perm:dashboard.view', 'stats', { kind: 'consultation' }); req.ctx.emit('perm:dashboard.finance', 'stats', { kind: 'consultation' });
    return getFull(db, c.id, req.user);
  });
  res.status(201).json(out);
}));

router.put('/:id', requirePerm('consultations.update', 'consultations.vitals', 'consultations.diagnose'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const d = parse(baseSchema.omit({ patient_id: true, acts: true }).partial(), req.body);
  const out = await tx(async (db) => {
    const { rows: [before] } = await db.query('SELECT * FROM consultations WHERE id = $1 FOR UPDATE', [id]);
    if (!before) throw notFound('Consultation introuvable');
    if (before.status === 'annulee') throw badRequest('Consultation annulée : modification impossible.');
    const sets = []; const vals = [];
    const set = (f, v) => { vals.push(v); sets.push(`${f} = $${vals.length}`); };
    const general = ['doctor_id', 'consulted_at', 'status'];
    if ([...general, 'reason'].some((f) => d[f] !== undefined) && !can(req.user, 'consultations.update')) throw forbidden('Modification de la consultation non autorisée.');
    if (VITALS.some((f) => d[f] !== undefined) && !can(req.user, 'consultations.vitals')) throw forbidden('Saisie des constantes non autorisée.');
    if (CLINICAL.some((f) => d[f] !== undefined) && !can(req.user, 'consultations.diagnose')) throw forbidden('Saisie du diagnostic non autorisée.');
    for (const f of general) if (d[f] !== undefined) set(f, d[f]);
    const clinicalChanged = [];
    if (d.reason !== undefined && (decrypt(before.reason) || null) !== (d.reason || null)) { set('reason', encrypt(d.reason || null)); clinicalChanged.push('reason'); }
    if (VITALS.some((f) => d[f] !== undefined)) {
      const cur = decJson(before.vitals, {});
      const next = { ...Object.fromEntries(VITALS.map((k) => [k, cur[k] ?? null])) };
      for (const f of VITALS) if (d[f] !== undefined) next[f] = d[f] === null || d[f] === '' ? null : Number(d[f]);
      if (JSON.stringify(next) !== JSON.stringify({ ...Object.fromEntries(VITALS.map((k) => [k, cur[k] ?? null])) })) {
        set('vitals', encJson(next)); clinicalChanged.push('vitals');
      }
    }
    for (const f of CLINICAL) {
      if (d[f] === undefined || (decrypt(before[f]) || null) === (d[f] || null)) continue;
      set(f, encrypt(d[f] || null)); clinicalChanged.push(f);
    }
    if (!sets.length) return getFull(db, id, req.user);
    vals.push(id);
    await db.query(`UPDATE consultations SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length}`, vals);
    const changes = diff(before, d, general);
    const statusChanged = d.status && d.status !== before.status;
    const { rows: [p] } = await db.query('SELECT id, patient_number FROM patients WHERE id = $1', [before.patient_id]);
    await audit(db, req.ctx, {
      action: statusChanged ? 'consultation.status' : 'consultation.update', entityType: 'consultation', entityId: id,
      summary: statusChanged
        ? `Consultation ${STATUS_LABEL[d.status].toLowerCase()} — ${patientRef(p)} (${before.number})`
        : `Mise à jour de la consultation ${before.number}`,
      oldValue: { ...(changes?.oldValue || {}), ...Object.fromEntries(clinicalChanged.map((f) => [f, '[donnée médicale]'])) },
      newValue: { ...(changes?.newValue || {}), ...Object.fromEntries(clinicalChanged.map((f) => [f, '[modifiée]'])) },
      feed: statusChanged ? { kind: 'consultation' } : false,
    });
    if (statusChanged && d.status === 'terminee') {
      const { rows: [c] } = await db.query('SELECT amount, payment_status FROM consultations WHERE id = $1', [id]);
      if (c.amount > 0 && c.payment_status !== 'payee') {
        await notify(db, req.ctx, {
          permission: 'payments.create', type: 'to_pay', icon: '💳', title: 'Consultation à encaisser',
          body: `${before.number} — ${patientRef(p)} — ${fmtGNF(c.amount)}`, link: `/paiements/nouveau?source=consultation&id=${id}`,
        });
      }
      req.ctx.emit('perm:dashboard.view', 'stats', { kind: 'consultation' }); req.ctx.emit('perm:dashboard.finance', 'stats', { kind: 'consultation' });
    }
    return getFull(db, id, req.user);
  });
  res.json(out);
}));

router.post('/:id/acts', requirePerm('acts.perform'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const { acts } = parse(z.object({ acts: baseSchema.shape.acts.unwrap().min(1) }), req.body);
  const out = await tx(async (db) => {
    const { rows: [c] } = await db.query('SELECT * FROM consultations WHERE id = $1 FOR UPDATE', [id]);
    if (!c) throw notFound('Consultation introuvable');
    if (c.status === 'annulee') throw badRequest('Consultation annulée.');
    await addActs(db, req, id, acts);
    const { rows: [after] } = await db.query('SELECT amount FROM consultations WHERE id = $1', [id]);
    await audit(db, req.ctx, {
      action: 'consultation.acts_add', entityType: 'consultation', entityId: id,
      summary: `Actes ajoutés à ${c.number}`, oldValue: { amount: c.amount }, newValue: { amount: after.amount, acts }, feed: false,
    });
    return getFull(db, id, req.user);
  });
  res.json(out);
}));

router.delete('/:id/acts/:actLineId', requirePerm('acts.perform'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const { reason } = parse(z.object({ reason: z.string().trim().min(3, 'motif obligatoire') }), req.body);
  const out = await tx(async (db) => {
    const { rows: [c] } = await db.query('SELECT * FROM consultations WHERE id = $1 FOR UPDATE', [id]);
    if (!c) throw notFound('Consultation introuvable');
    if (c.paid_amount > 0) throw badRequest('Des paiements existent : annulez d\'abord le paiement pour retirer un acte.');
    const { rows: [line] } = await db.query(
      `DELETE FROM consultation_acts ca USING medical_acts a WHERE ca.id = $1 AND ca.consultation_id = $2 AND a.id = ca.act_id
       RETURNING ca.*, a.name`, [Number(req.params.actLineId), id]);
    if (!line) throw notFound('Acte introuvable');
    await recomputeAmount(db, id);
    await audit(db, req.ctx, {
      action: 'consultation.acts_remove', entityType: 'consultation', entityId: id,
      summary: `Acte retiré de ${c.number} : ${line.name}`, oldValue: line, reason,
    });
    return getFull(db, id, req.user);
  });
  res.json(out);
}));

router.post('/:id/cancel', requirePerm('consultations.cancel'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const { reason } = parse(z.object({ reason: z.string().trim().min(3, 'motif obligatoire') }), req.body);
  await tx(async (db) => {
    const { rows: [c] } = await db.query('SELECT * FROM consultations WHERE id = $1 FOR UPDATE', [id]);
    if (!c) throw notFound('Consultation introuvable');
    if (c.status === 'annulee') throw badRequest('Déjà annulée.');
    if (c.paid_amount > 0) throw badRequest('Consultation déjà (partiellement) payée : annulez ou remboursez d\'abord le paiement.');
    await db.query(`UPDATE consultations SET status = 'annulee', cancel_reason = $2, updated_at = now() WHERE id = $1`, [id, reason]);
    await audit(db, req.ctx, {
      action: 'consultation.cancel', entityType: 'consultation', entityId: id, summary: `Annulation de la consultation ${c.number}`,
      oldValue: { status: c.status }, newValue: { status: 'annulee' }, reason,
    });
  });
  res.json({ ok: true });
}));

const prescriptionSchema = z.object({
  notes: z.string().max(2000).optional().nullable(),
  items: z.array(z.object({
    product_id: z.coerce.number().int().positive().optional().nullable(),
    drug_name: z.string().trim().min(1).max(200),
    dosage: z.string().max(100).optional().nullable(),
    frequency: z.string().max(100).optional().nullable(),
    duration: z.string().max(100).optional().nullable(),
    quantity: z.coerce.number().int().min(0).optional().nullable(),
    instructions: z.string().max(500).optional().nullable(),
  })).min(1),
});

router.post('/:id/prescriptions', requirePerm('prescriptions.create'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const d = parse(prescriptionSchema, req.body);
  const out = await tx(async (db) => {
    const { rows: [c] } = await db.query('SELECT id, number, patient_id, status FROM consultations WHERE id = $1', [id]);
    if (!c) throw notFound('Consultation introuvable');
    if (c.status === 'annulee') throw badRequest('Consultation annulée.');
    const items = d.items.map((it) => ({
      product_id: it.product_id || null, drug_name: it.drug_name, dosage: it.dosage || null, frequency: it.frequency || null,
      duration: it.duration || null, quantity: it.quantity ?? null, instructions: it.instructions || null,
    }));
    const number = await nextNumber(db, 'prescription', 'ORD');
    const { rows: [pr] } = await db.query(
      'INSERT INTO prescriptions (consultation_id, patient_id, prescribed_by, notes, items, number) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [id, c.patient_id, req.user.id, encrypt(d.notes || null), encJson(items), number]);
    await audit(db, req.ctx, {
      action: 'prescription.create', entityType: 'prescription', entityId: pr.id,
      summary: `Prescription ${number} (${d.items.length} ligne(s)) — consultation ${c.number}`, feed: false,
    });
    return getFull(db, id, req.user);
  });
  res.status(201).json(out);
}));

// Prescription pour la pharmacie (sans données cliniques de la consultation), avec l'état de délivrance par ligne
router.get('/prescriptions/:pid', requirePerm('pharmacy.sell', 'prescriptions.create', 'patients.view_medical'), ah(async (req, res) => {
  const pr = await loadPrescription({ query }, Number(req.params.pid));
  const lines = await dispensingLines({ query }, pr);
  await logMedicalRead(req, { patientId: pr.patient_id, patientNumber: pr.patient_number, access: 'prescription', ref: pr.number });
  res.json({
    id: pr.id, number: pr.number, status: pr.status, status_label: PRESCRIPTION_STATUS[pr.status],
    patient_id: pr.patient_id, patient_name: pr.patient_name, patient_number: pr.patient_number,
    prescribed_by: pr.prescribed_by, prescriber: pr.prescriber, consultation_id: pr.consultation_id, consultation_number: pr.consultation_number,
    created_at: pr.created_at, notes: decrypt(pr.notes),
    items: lines.map((l) => ({ id: l.line, ...l })),
  });
}));

// Ordonnance imprimable (PDF A4)
router.get('/prescriptions/:pid/pdf', requirePerm('pharmacy.sell', 'prescriptions.create', 'patients.view_medical'), ah(async (req, res) => {
  const pr = await loadPrescription({ query }, Number(req.params.pid));
  const items = decJson(pr.items, []);
  const { clinic } = await getSettings();
  await logMedicalRead(req, { patientId: pr.patient_id, patientNumber: pr.patient_number, access: 'ordonnance_pdf', ref: pr.number });
  sendPdf(res, {
    filename: `ordonnance-${pr.number}.pdf`, clinic, title: 'Ordonnance', type: 'ordonnance', number: pr.number, issuedAt: pr.created_at,
  }, (doc, h) => {
    const age = ageOf(pr.patient_birth_date, pr.created_at);
    h.row('Patient :', `${pr.patient_name} (${pr.patient_number})`);
    h.row('Âge / sexe :', `${age !== null ? `${age} an${age > 1 ? 's' : ''}` : '—'} / ${pr.patient_sex === 'F' ? 'Féminin' : pr.patient_sex === 'M' ? 'Masculin' : '—'}`);
    h.row('Prescripteur :', `Dr ${pr.prescriber || '—'}${pr.prescriber_title ? ` — ${pr.prescriber_title}` : ''}`);
    if (pr.prescriber_professional_id) h.row('N° d\'inscription à l\'Ordre :', pr.prescriber_professional_id);
    h.row('Date :', fmtDate(pr.created_at));
    if (pr.consultation_number) h.row('Consultation :', pr.consultation_number);
    h.section('Prescription');
    items.forEach((it, i) => {
      h.ensureSpace(60);
      doc.font('Helvetica-Bold').fontSize(11.5).text(`${i + 1}. ${it.drug_name}${it.quantity ? `   — Qté : ${it.quantity}` : ''}`);
      const posology = [it.dosage, it.frequency].filter(Boolean).join(' — ');
      doc.font('Helvetica').fontSize(10.5);
      if (posology) doc.text(`Posologie : ${posology}`, { indent: 14 });
      if (it.duration) doc.text(`Durée : ${it.duration}`, { indent: 14 });
      if (it.instructions) doc.text(`Instructions : ${it.instructions}`, { indent: 14 });
      doc.moveDown(0.5);
    });
    const notes = decrypt(pr.notes);
    if (notes) { h.section('Recommandations'); doc.text(notes); }
    h.ensureSpace(90);
    doc.moveDown(2).font('Helvetica').fontSize(10).text('Signature et cachet du prescripteur', 50 + h.W / 2, doc.y, { width: h.W / 2, align: 'center' });
    doc.moveDown(3);
  });
}));

export default router;
