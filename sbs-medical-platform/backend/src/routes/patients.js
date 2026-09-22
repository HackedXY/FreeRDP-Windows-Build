import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../db/pool.js';
import { ah, parse, notFound } from '../lib/errors.js';
import { requirePerm, can } from '../lib/auth.js';
import { audit, diff } from '../lib/audit.js';
import { notify } from '../lib/notify.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { nextNumber } from '../lib/numbering.js';
import { paging } from '../lib/helpers.js';

const router = Router();
const MEDICAL = ['medical_history', 'allergies', 'blood_group', 'notes'];
const IDENTITY = ['first_name', 'last_name', 'sex', 'birth_date', 'phone', 'address', 'emergency_contact'];

/** Principe du moindre privilège : sans « patients.view_medical », pas de données médicales. */
export function presentPatient(row, user) {
  if (!row) return row;
  const p = { ...row };
  if (can(user, 'patients.view_medical')) {
    for (const f of MEDICAL) p[f] = decrypt(p[f]);
  } else {
    for (const f of MEDICAL) delete p[f];
    p.medical_restricted = true;
  }
  return p;
}

const schema = z.object({
  first_name: z.string().trim().min(1).max(100),
  last_name: z.string().trim().min(1).max(100),
  sex: z.enum(['M', 'F']).optional().nullable(),
  birth_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable().or(z.literal('')),
  phone: z.string().trim().max(30).optional().nullable(),
  address: z.string().trim().max(300).optional().nullable(),
  emergency_contact: z.string().trim().max(300).optional().nullable(),
  medical_history: z.string().max(5000).optional().nullable(),
  allergies: z.string().max(2000).optional().nullable(),
  blood_group: z.string().max(5).optional().nullable(),
  notes: z.string().max(5000).optional().nullable(),
});

router.get('/', requirePerm('patients.view'), ah(async (req, res) => {
  const { limit, offset } = paging(req);
  const where = ['p.archived_at IS NULL']; const vals = [];
  if (req.query.q) {
    vals.push(`%${String(req.query.q).trim().toLowerCase()}%`);
    where.push(`(lower(p.patient_number) LIKE $1 OR lower(p.last_name || ' ' || p.first_name) LIKE $1
      OR lower(p.first_name || ' ' || p.last_name) LIKE $1 OR p.phone LIKE $1)`);
  }
  vals.push(limit, offset);
  const { rows } = await query(
    `SELECT p.id, p.patient_number, p.first_name, p.last_name, p.sex, p.birth_date, p.phone, p.address, p.created_at,
       (SELECT max(consulted_at) FROM consultations c WHERE c.patient_id = p.id AND c.status <> 'annulee') AS last_visit,
       count(*) OVER()::int AS total
     FROM patients p WHERE ${where.join(' AND ')}
     ORDER BY p.created_at DESC LIMIT $${vals.length - 1} OFFSET $${vals.length}`,
    vals,
  );
  res.json({ items: rows.map(({ total, ...r }) => r), total: rows[0]?.total || 0 });
}));

router.get('/:id', requirePerm('patients.view'), ah(async (req, res) => {
  const { rows } = await query('SELECT * FROM patients WHERE id = $1', [Number(req.params.id)]);
  if (!rows[0]) throw notFound('Patient introuvable');
  res.json(presentPatient(rows[0], req.user));
}));

// Historique complet du dossier, filtré selon les permissions de l'utilisateur
router.get('/:id/history', requirePerm('patients.view'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const u = req.user;
  const out = {};
  if (can(u, 'consultations.view')) {
    const { rows } = await query(
      `SELECT c.id, c.number, c.consulted_at, c.reason, c.status, c.amount, c.payment_status, c.diagnosis, c.treatment,
         d.first_name || ' ' || d.last_name AS doctor
       FROM consultations c LEFT JOIN users d ON d.id = c.doctor_id WHERE c.patient_id = $1 ORDER BY c.consulted_at DESC`, [id]);
    const medical = can(u, 'patients.view_medical');
    out.consultations = rows.map((r) => ({ ...r, diagnosis: medical ? decrypt(r.diagnosis) : undefined, treatment: medical ? decrypt(r.treatment) : undefined }));
    const { rows: acts } = await query(
      `SELECT ca.id, ca.performed_at, ca.quantity, ca.unit_price, a.name, c.number AS consultation_number
       FROM consultation_acts ca JOIN medical_acts a ON a.id = ca.act_id JOIN consultations c ON c.id = ca.consultation_id
       WHERE c.patient_id = $1 ORDER BY ca.performed_at DESC`, [id]);
    out.acts = acts;
  }
  if (can(u, 'patients.view_medical')) {
    const { rows } = await query(
      `SELECT pr.id, pr.created_at, pr.notes, u.first_name || ' ' || u.last_name AS prescriber,
         coalesce(json_agg(pi.* ORDER BY pi.id) FILTER (WHERE pi.id IS NOT NULL), '[]') AS items
       FROM prescriptions pr LEFT JOIN prescription_items pi ON pi.prescription_id = pr.id
       LEFT JOIN users u ON u.id = pr.prescribed_by
       WHERE pr.patient_id = $1 GROUP BY pr.id, u.id ORDER BY pr.created_at DESC`, [id]);
    out.prescriptions = rows;
  }
  if (can(u, 'lab.view') || can(u, 'patients.view_medical')) {
    const { rows } = await query(
      `SELECT lr.id, lr.number, lr.status, lr.created_at, lr.completed_at, lr.amount, lr.payment_status,
         coalesce(json_agg(json_build_object('name', t.name, 'result_value', i.result_value, 'result_text', i.result_text,
           'unit', i.unit, 'reference_range', i.reference_range, 'abnormal', i.abnormal) ORDER BY i.id), '[]') AS items
       FROM lab_requests lr JOIN lab_request_items i ON i.request_id = lr.id JOIN lab_exam_types t ON t.id = i.exam_type_id
       WHERE lr.patient_id = $1 GROUP BY lr.id ORDER BY lr.created_at DESC`, [id]);
    out.lab_requests = rows;
  }
  if (can(u, 'payments.view')) {
    const { rows } = await query(
      `SELECT id, number, receipt_number, description, amount, method, status, created_at
       FROM payments WHERE patient_id = $1 ORDER BY created_at DESC`, [id]);
    out.payments = rows;
  }
  if (can(u, 'appointments.view')) {
    const { rows } = await query(
      `SELECT a.id, a.scheduled_at, a.reason, a.status, d.first_name || ' ' || d.last_name AS doctor
       FROM appointments a LEFT JOIN users d ON d.id = a.doctor_id WHERE a.patient_id = $1 ORDER BY a.scheduled_at DESC`, [id]);
    out.appointments = rows;
  }
  res.json(out);
}));

router.post('/', requirePerm('patients.create'), ah(async (req, res) => {
  const data = parse(schema, req.body);
  const medicalAllowed = can(req.user, 'patients.view_medical');
  const patient = await tx(async (db) => {
    const number = await nextNumber(db, 'patient', 'P', { yearly: false, pad: 6 });
    const { rows: [p] } = await db.query(
      `INSERT INTO patients (site_id, patient_number, first_name, last_name, sex, birth_date, phone, address, emergency_contact,
         medical_history, allergies, blood_group, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [req.user.siteId, number, data.first_name, data.last_name, data.sex || null, data.birth_date || null,
        data.phone || null, data.address || null, data.emergency_contact || null,
        ...(medicalAllowed ? MEDICAL.map((f) => encrypt(data[f] || null)) : [null, null, null, null]), req.user.id],
    );
    await audit(db, req.ctx, {
      action: 'patient.create', entityType: 'patient', entityId: p.id,
      summary: `Nouveau patient ${number} — ${data.first_name} ${data.last_name}`,
      feed: { kind: 'patient' },
    });
    await notify(db, req.ctx, {
      permission: 'dashboard.view', type: 'patient', icon: '👤',
      title: 'Nouveau patient', body: `${number} — ${data.first_name} ${data.last_name}`, link: `/patients/${p.id}`,
    });
    req.ctx.emit('perm:dashboard.view', 'stats', { kind: 'patient' });
    return p;
  });
  res.status(201).json(presentPatient(patient, req.user));
}));

router.put('/:id', requirePerm('patients.update'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const data = parse(schema.partial(), req.body);
  const medicalAllowed = can(req.user, 'patients.view_medical');
  const patient = await tx(async (db) => {
    const { rows: [before] } = await db.query('SELECT * FROM patients WHERE id = $1 FOR UPDATE', [id]);
    if (!before) throw notFound('Patient introuvable');
    const sets = []; const vals = [];
    for (const f of IDENTITY) if (data[f] !== undefined) { vals.push(data[f] === '' ? null : data[f]); sets.push(`${f} = $${vals.length}`); }
    const medicalChanged = [];
    if (medicalAllowed) {
      for (const f of MEDICAL) {
        if (data[f] === undefined) continue;
        if ((decrypt(before[f]) || null) === (data[f] || null)) continue;
        vals.push(encrypt(data[f] || null)); sets.push(`${f} = $${vals.length}`); medicalChanged.push(f);
      }
    }
    if (!sets.length) return before;
    vals.push(id);
    const { rows: [p] } = await db.query(`UPDATE patients SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length} RETURNING *`, vals);
    const changes = diff(before, data, IDENTITY);
    // Les données médicales ne sont jamais recopiées en clair dans le journal
    await audit(db, req.ctx, {
      action: 'patient.update', entityType: 'patient', entityId: id,
      summary: `Modification du dossier ${before.patient_number}`,
      oldValue: { ...(changes?.oldValue || {}), ...Object.fromEntries(medicalChanged.map((f) => [f, '[donnée médicale]'])) },
      newValue: { ...(changes?.newValue || {}), ...Object.fromEntries(medicalChanged.map((f) => [f, '[modifiée]'])) },
      feed: false,
    });
    return p;
  });
  res.json(presentPatient(patient, req.user));
}));

router.post('/:id/archive', requirePerm('patients.update'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const { reason } = parse(z.object({ reason: z.string().trim().min(3) }), req.body);
  await tx(async (db) => {
    const { rows: [p] } = await db.query('UPDATE patients SET archived_at = now() WHERE id = $1 AND archived_at IS NULL RETURNING patient_number', [id]);
    if (!p) throw notFound('Patient introuvable ou déjà archivé');
    await audit(db, req.ctx, { action: 'patient.archive', entityType: 'patient', entityId: id, summary: `Archivage du dossier ${p.patient_number}`, reason });
  });
  res.json({ ok: true });
}));

export default router;
