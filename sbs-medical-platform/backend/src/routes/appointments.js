import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../db/pool.js';
import { ah, parse, notFound, badRequest } from '../lib/errors.js';
import { requirePerm } from '../lib/auth.js';
import { audit, diff } from '../lib/audit.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { canAppointmentDetails } from '../lib/medical.js';

// Motif et notes chiffrés ; visibles seulement par le personnel habilité
const present = (a, user) => (canAppointmentDetails(user)
  ? { ...a, reason: decrypt(a.reason), notes: decrypt(a.notes) }
  : { ...a, reason: undefined, notes: undefined, details_restricted: true });

const router = Router();
const schema = z.object({
  patient_id: z.coerce.number().int().positive(),
  doctor_id: z.coerce.number().int().positive().optional().nullable(),
  scheduled_at: z.string().min(10),
  duration_minutes: z.coerce.number().int().min(5).max(480).default(20),
  reason: z.string().trim().max(300).optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
  reminder_at: z.string().optional().nullable().or(z.literal('').transform(() => null)),
  status: z.enum(['planifie', 'confirme', 'honore', 'absent']).optional(),
});
const FIELDS = ['doctor_id', 'scheduled_at', 'duration_minutes', 'reason', 'notes', 'reminder_at', 'status'];

const SELECT = `SELECT a.*, p.patient_number, p.first_name || ' ' || p.last_name AS patient_name, p.phone AS patient_phone,
  d.first_name || ' ' || d.last_name AS doctor_name
  FROM appointments a JOIN patients p ON p.id = a.patient_id LEFT JOIN users d ON d.id = a.doctor_id`;

router.get('/', requirePerm('appointments.view'), ah(async (req, res) => {
  const where = []; const vals = [];
  if (req.query.from) { vals.push(req.query.from); where.push(`a.scheduled_at >= $${vals.length}::date`); }
  if (req.query.to) { vals.push(req.query.to); where.push(`a.scheduled_at < $${vals.length}::date + 1`); }
  for (const f of ['status']) if (req.query[f]) { vals.push(req.query[f]); where.push(`a.${f} = $${vals.length}`); }
  if (req.query.doctor_id) { vals.push(Number(req.query.doctor_id)); where.push(`a.doctor_id = $${vals.length}`); }
  if (req.query.patient_id) { vals.push(Number(req.query.patient_id)); where.push(`a.patient_id = $${vals.length}`); }
  // le motif étant chiffré, la recherche porte sur le patient (nom, téléphone, n° de dossier)
  if (req.query.q) { vals.push(`%${String(req.query.q).toLowerCase()}%`); where.push(`(lower(p.first_name || ' ' || p.last_name) LIKE $${vals.length} OR lower(p.patient_number) LIKE $${vals.length} OR p.phone LIKE $${vals.length})`); }
  const { rows } = await query(`${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.scheduled_at LIMIT 1000`, vals);
  res.json(rows.map((a) => present(a, req.user)));
}));

// Rappels : rendez-vous des prochaines 24 h non encore rappelés
router.get('/reminders', requirePerm('appointments.view'), ah(async (req, res) => {
  const { rows } = await query(
    `${SELECT} WHERE a.status IN ('planifie','confirme') AND a.reminder_sent_at IS NULL
       AND ((a.reminder_at IS NOT NULL AND a.reminder_at <= now()) OR a.scheduled_at <= now() + interval '24 hours')
       AND a.scheduled_at >= now() ORDER BY a.scheduled_at`);
  res.json(rows.map((a) => present(a, req.user)));
}));

router.post('/', requirePerm('appointments.manage'), ah(async (req, res) => {
  const d = parse(schema, req.body);
  const out = await tx(async (db) => {
    const { rows: [p] } = await db.query('SELECT patient_number FROM patients WHERE id = $1', [d.patient_id]);
    if (!p) throw badRequest('Patient introuvable');
    if (d.doctor_id) {
      const { rows: clash } = await db.query(
        `SELECT 1 FROM appointments WHERE doctor_id = $1 AND status IN ('planifie','confirme')
           AND tstzrange(scheduled_at, scheduled_at + duration_minutes * interval '1 minute') &&
               tstzrange($2::timestamptz, $2::timestamptz + $3 * interval '1 minute')`, [d.doctor_id, d.scheduled_at, d.duration_minutes]);
      if (clash.length) throw badRequest('Ce médecin a déjà un rendez-vous sur ce créneau.');
    }
    const { rows: [a] } = await db.query(
      `INSERT INTO appointments (site_id, patient_id, doctor_id, scheduled_at, duration_minutes, reason, notes, reminder_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [req.user.siteId, d.patient_id, d.doctor_id || null, d.scheduled_at, d.duration_minutes, encrypt(d.reason || null), encrypt(d.notes || null), d.reminder_at || null, req.user.id]);
    await audit(db, req.ctx, { action: 'appointment.create', entityType: 'appointment', entityId: a.id, summary: `Rendez-vous — ${p.patient_number} le ${new Date(d.scheduled_at).toLocaleString('fr-FR')}`, feed: false });
    const { rows: [full] } = await db.query(`${SELECT} WHERE a.id = $1`, [a.id]);
    return present(full, req.user);
  });
  res.status(201).json(out);
}));

router.put('/:id', requirePerm('appointments.manage'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const d = parse(schema.omit({ patient_id: true }).partial(), req.body);
  const out = await tx(async (db) => {
    const { rows: [before] } = await db.query('SELECT * FROM appointments WHERE id = $1 FOR UPDATE', [id]);
    if (!before) throw notFound('Rendez-vous introuvable');
    const sets = []; const vals = [];
    for (const f of FIELDS) if (d[f] !== undefined) { vals.push(['reason', 'notes'].includes(f) ? encrypt(d[f] || null) : d[f]); sets.push(`${f} = $${vals.length}`); }
    if (d.scheduled_at) sets.push('reminder_sent_at = NULL');
    if (sets.length) {
      vals.push(id);
      await db.query(`UPDATE appointments SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length}`, vals);
      const ch = diff(before, d, FIELDS.filter((f) => !['reason', 'notes'].includes(f)));
      if (ch) await audit(db, req.ctx, { action: 'appointment.update', entityType: 'appointment', entityId: id, summary: 'Modification d\'un rendez-vous', ...ch, feed: false });
    }
    const { rows: [full] } = await db.query(`${SELECT} WHERE a.id = $1`, [id]);
    return present(full, req.user);
  });
  res.json(out);
}));

router.post('/:id/cancel', requirePerm('appointments.manage'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const { reason } = parse(z.object({ reason: z.string().trim().min(3) }), req.body);
  await tx(async (db) => {
    const { rows: [a] } = await db.query(`UPDATE appointments SET status = 'annule', cancel_reason = $2, updated_at = now() WHERE id = $1 AND status <> 'annule' RETURNING *`, [id, reason]);
    if (!a) throw notFound('Rendez-vous introuvable ou déjà annulé');
    await audit(db, req.ctx, { action: 'appointment.cancel', entityType: 'appointment', entityId: id, summary: 'Annulation d\'un rendez-vous', reason, feed: false });
  });
  res.json({ ok: true });
}));

router.post('/:id/reminded', requirePerm('appointments.manage'), ah(async (req, res) => {
  const id = Number(req.params.id);
  await tx(async (db) => {
    await db.query('UPDATE appointments SET reminder_sent_at = now() WHERE id = $1', [id]);
    await audit(db, req.ctx, { action: 'appointment.reminded', entityType: 'appointment', entityId: id, summary: 'Rappel de rendez-vous effectué', feed: false });
  });
  res.json({ ok: true });
}));

export default router;
