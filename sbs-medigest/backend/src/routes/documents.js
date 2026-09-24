// Certificats médicaux et vérification d'authenticité des documents émis.
import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../db/pool.js';
import { ah, parse, notFound, badRequest, forbidden } from '../lib/errors.js';
import { requirePerm } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { nextNumber } from '../lib/numbering.js';
import { getSettings } from '../lib/settings.js';
import { encJson, decJson, logMedicalRead } from '../lib/medical.js';
import { sendPdf, fmtDate, ageOf, checkVerificationCode, DOC_TYPES } from '../lib/documents.js';

const router = Router();

export const CERT_TYPES = {
  aptitude: 'Certificat d\'aptitude',
  inaptitude: 'Certificat d\'inaptitude',
  repos: 'Certificat d\'arrêt / de repos',
  presence: 'Certificat de présence / de consultation',
  autre: 'Certificat médical',
};
const CERT_VIEW = ['certificates.create', 'patients.view_medical'];
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable().or(z.literal('').transform(() => null));

async function loadCertificate(db, id) {
  const { rows: [c] } = await db.query(
    `SELECT c.*, p.patient_number, p.first_name || ' ' || p.last_name AS patient_name, p.sex AS patient_sex, p.birth_date AS patient_birth_date,
       u.first_name || ' ' || u.last_name AS doctor_name, u.job_title AS doctor_title, u.professional_id AS doctor_professional_id, k.number AS consultation_number,
       x.first_name || ' ' || x.last_name AS cancelled_by_name
     FROM medical_certificates c JOIN patients p ON p.id = c.patient_id JOIN users u ON u.id = c.doctor_id
     LEFT JOIN consultations k ON k.id = c.consultation_id LEFT JOIN users x ON x.id = c.cancelled_by WHERE c.id = $1`, [id]);
  if (!c) throw notFound('Certificat introuvable');
  return c;
}
const present = (c) => {
  const { content, ...rest } = c;
  return { ...rest, type_label: CERT_TYPES[c.cert_type], ...decJson(content, {}) };
};

// Liste (sans contenu médical) : numéro, type, patient, médecin, date, statut
router.get('/certificates', requirePerm(...CERT_VIEW), ah(async (req, res) => {
  const where = []; const vals = [];
  if (req.query.patient_id) { vals.push(Number(req.query.patient_id)); where.push(`c.patient_id = $${vals.length}`); }
  if (req.query.consultation_id) { vals.push(Number(req.query.consultation_id)); where.push(`c.consultation_id = $${vals.length}`); }
  const { rows } = await query(
    `SELECT c.id, c.number, c.cert_type, c.issued_at, c.cancelled_at, c.patient_id, c.consultation_id, p.patient_number,
       p.first_name || ' ' || p.last_name AS patient_name, u.first_name || ' ' || u.last_name AS doctor_name
     FROM medical_certificates c JOIN patients p ON p.id = c.patient_id JOIN users u ON u.id = c.doctor_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.issued_at DESC LIMIT 200`, vals);
  res.json(rows.map((r) => ({ ...r, type_label: CERT_TYPES[r.cert_type] })));
}));

router.get('/certificates/:id', requirePerm(...CERT_VIEW), ah(async (req, res) => {
  const c = await loadCertificate({ query }, Number(req.params.id));
  await logMedicalRead(req, { patientId: c.patient_id, patientNumber: c.patient_number, access: 'certificat', ref: c.number });
  res.json(present(c));
}));

router.post('/certificates', requirePerm('certificates.create'), ah(async (req, res) => {
  const d = parse(z.object({
    patient_id: z.coerce.number().int().positive(),
    consultation_id: z.coerce.number().int().positive().optional().nullable(),
    cert_type: z.enum(Object.keys(CERT_TYPES)),
    body: z.string().trim().min(5).max(5000),
    rest_days: z.coerce.number().int().min(1).max(365).optional().nullable(),
    start_date: dateStr,
    end_date: dateStr,
  }), req.body);
  if (d.cert_type === 'repos' && !d.rest_days) throw badRequest('Durée du repos obligatoire pour un certificat de repos.');
  if (d.start_date && d.end_date && d.end_date < d.start_date) throw badRequest('La date de fin précède la date de début.');
  const out = await tx(async (db) => {
    const { rows: [p] } = await db.query('SELECT id, patient_number FROM patients WHERE id = $1 AND archived_at IS NULL', [d.patient_id]);
    if (!p) throw badRequest('Patient introuvable');
    if (d.consultation_id) {
      const { rows: [c] } = await db.query('SELECT patient_id, status FROM consultations WHERE id = $1', [d.consultation_id]);
      if (!c || c.patient_id !== p.id) throw badRequest('Consultation introuvable pour ce patient.');
      if (c.status === 'annulee') throw badRequest('Consultation annulée.');
    }
    const number = await nextNumber(db, 'certificate', 'CERT');
    // Tout le contenu (texte, durée, dates) est chiffré : seuls le type et les dates d'émission sont en clair
    const content = { body: d.body, rest_days: d.rest_days ?? null, start_date: d.start_date ?? null, end_date: d.end_date ?? null };
    const { rows: [c] } = await db.query(
      `INSERT INTO medical_certificates (site_id, number, patient_id, consultation_id, doctor_id, cert_type, content)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [req.user.siteId, number, p.id, d.consultation_id ?? null, req.user.id, d.cert_type, encJson(content)]);
    await audit(db, req.ctx, {
      action: 'certificate.create', entityType: 'certificate', entityId: c.id,
      summary: `Certificat médical ${number} — ${p.patient_number}`, newValue: { number, cert_type: d.cert_type }, feed: false,
    });
    return present(await loadCertificate(db, c.id));
  });
  res.status(201).json(out);
}));

router.post('/certificates/:id/cancel', requirePerm('certificates.create'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const { reason } = parse(z.object({ reason: z.string().trim().min(3).max(500) }), req.body);
  const out = await tx(async (db) => {
    const { rows: [c] } = await db.query('SELECT * FROM medical_certificates WHERE id = $1 FOR UPDATE', [id]);
    if (!c) throw notFound('Certificat introuvable');
    if (c.cancelled_at) throw badRequest('Certificat déjà annulé.');
    // Seul l'auteur (ou le propriétaire) annule un certificat
    if (c.doctor_id !== req.user.id && !req.user.superadmin) throw forbidden('Seul le médecin signataire peut annuler ce certificat.');
    await db.query('UPDATE medical_certificates SET cancelled_at = now(), cancelled_by = $2, cancel_reason = $3 WHERE id = $1', [id, req.user.id, reason]);
    await audit(db, req.ctx, { action: 'certificate.cancel', entityType: 'certificate', entityId: id, summary: `Annulation du certificat ${c.number}`, reason, feed: false });
    return present(await loadCertificate(db, id));
  });
  res.json(out);
}));

router.get('/certificates/:id/pdf', requirePerm(...CERT_VIEW), ah(async (req, res) => {
  const c = await loadCertificate({ query }, Number(req.params.id));
  const x = decJson(c.content, {});
  const { clinic } = await getSettings();
  await logMedicalRead(req, { patientId: c.patient_id, patientNumber: c.patient_number, access: 'certificat_pdf', ref: c.number });
  sendPdf(res, {
    filename: `certificat-${c.number}.pdf`, clinic, title: CERT_TYPES[c.cert_type], type: 'certificat', number: c.number, issuedAt: c.issued_at,
    watermark: c.cancelled_at ? '*** CERTIFICAT ANNULÉ ***' : null,
  }, (doc, h) => {
    const age = ageOf(c.patient_birth_date, c.issued_at);
    const civ = c.patient_sex === 'F' ? 'Mme' : c.patient_sex === 'M' ? 'M.' : 'M./Mme';
    doc.moveDown(0.5).font('Helvetica').fontSize(11.5).text(
      `Je soussigné(e), Dr ${c.doctor_name}${c.doctor_title ? `, ${c.doctor_title}` : ''}, certifie avoir examiné ce jour ${civ} ${c.patient_name}`
      + `${c.patient_birth_date ? `, né(e) le ${fmtDate(c.patient_birth_date)}${age !== null ? ` (${age} ans)` : ''}` : ''}, dossier ${c.patient_number}.`,
      { align: 'justify', lineGap: 3 });
    doc.moveDown(0.8).text(x.body || '', { align: 'justify', lineGap: 3 });
    if (x.rest_days) {
      doc.moveDown(0.8).font('Helvetica-Bold').text(
        `Repos médical : ${x.rest_days} jour${x.rest_days > 1 ? 's' : ''}${x.start_date ? ` à compter du ${fmtDate(x.start_date)}` : ''}${x.end_date ? ` jusqu'au ${fmtDate(x.end_date)} inclus` : ''}.`);
      doc.font('Helvetica');
    }
    doc.moveDown(0.8).text('Certificat établi à la demande de l\'intéressé(e) et remis en main propre pour servir et valoir ce que de droit.', { align: 'justify' });
    h.ensureSpace(110);
    doc.moveDown(1.5).text(`Fait à ${clinic.city || (clinic.address || 'Siguiri').split(',')[0]}, le ${fmtDate(c.issued_at)}`, 50 + h.W / 2, doc.y, { width: h.W / 2, align: 'center' });
    doc.moveDown(0.5).font('Helvetica-Bold').text(`Dr ${c.doctor_name}`, { width: h.W / 2, align: 'center' });
    if (c.doctor_professional_id) doc.font('Helvetica').fontSize(9).text(`N° Ordre : ${c.doctor_professional_id}`, { width: h.W / 2, align: 'center' }).fontSize(11.5);
    doc.font('Helvetica').fontSize(9).fillColor('#555').text('Signature et cachet', { width: h.W / 2, align: 'center' }).fillColor('#111');
    doc.moveDown(3);
  });
}));

/**
 * Vérification d'un document présenté (numéro + code imprimé en pied de page).
 * Réservée au personnel connecté ; ne renvoie aucune donnée médicale.
 */
router.get('/verify', ah(async (req, res) => {
  const d = parse(z.object({
    type: z.enum(Object.keys(DOC_TYPES)), number: z.string().trim().min(3).max(40), code: z.string().trim().min(4).max(20),
  }), req.query);
  const sql = {
    ordonnance: `SELECT d.number, d.created_at AS issued_at, p.patient_number, NULL::timestamptz AS cancelled_at FROM prescriptions d JOIN patients p ON p.id = d.patient_id WHERE d.number = $1`,
    certificat: `SELECT d.number, d.issued_at, p.patient_number, d.cancelled_at FROM medical_certificates d JOIN patients p ON p.id = d.patient_id WHERE d.number = $1`,
    compte_rendu: `SELECT d.number, coalesce(d.validated_at, d.completed_at) AS issued_at, p.patient_number, NULL::timestamptz AS cancelled_at FROM lab_requests d JOIN patients p ON p.id = d.patient_id WHERE d.number = $1 AND d.status = 'terminee'`,
    facture: `SELECT d.number, d.created_at AS issued_at, p.patient_number, d.cancelled_at FROM invoices d JOIN patients p ON p.id = d.patient_id WHERE d.number = $1`,
  }[d.type];
  const { rows: [doc] } = await query(sql, [d.number]);
  const valid = !!doc && !!doc.issued_at && checkVerificationCode(d.type, doc.number, doc.issued_at, d.code);
  await tx((db) => audit(db, req.ctx, {
    action: 'document.verify', entityType: 'document', entityId: d.number,
    summary: `Vérification ${DOC_TYPES[d.type]} ${d.number} : ${valid ? 'authentique' : 'non reconnu'}`, newValue: { type: d.type, valid }, feed: false,
  }));
  if (!valid) return res.json({ valid: false });
  res.json({ valid: true, type: d.type, type_label: DOC_TYPES[d.type], number: doc.number, issued_at: doc.issued_at, patient_number: doc.patient_number, cancelled: !!doc.cancelled_at });
}));

export default router;
