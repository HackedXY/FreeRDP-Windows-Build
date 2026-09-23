import { Router } from 'express';
import { z } from 'zod';
import PDFDocument from 'pdfkit';
import { query, tx } from '../db/pool.js';
import { ah, parse, notFound, badRequest, forbidden } from '../lib/errors.js';
import { requirePerm, can } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { notify, raiseAlert } from '../lib/notify.js';
import { nextNumber } from '../lib/numbering.js';
import { getSettings } from '../lib/settings.js';
import { fmtGNF, paging, addPeriod, refreshPaymentStatus } from '../lib/helpers.js';
import { requireOpenSession, cashMovement } from './cash.js';

const router = Router();

export const METHOD_LABELS = {
  especes: 'Espèces', orange_money: 'Orange Money', mtn_money: 'MTN Mobile Money', virement: 'Virement bancaire', autre: 'Autre',
};
const SOURCE_TABLES = { consultation: 'consultations', lab_request: 'lab_requests', pharmacy_sale: 'pharmacy_sales' };
const SOURCE_LABELS = { consultation: 'Consultation', lab_request: 'Examens de laboratoire', pharmacy_sale: 'Pharmacie', act: 'Acte médical', other: 'Autre' };

/** Éléments facturables non soldés (consultations, examens, ventes pharmacie). */
router.get('/pending', requirePerm('payments.create', 'payments.view'), ah(async (req, res) => {
  const vals = []; let pf = '';
  if (req.query.patient_id) { vals.push(Number(req.query.patient_id)); pf = `AND t.patient_id = $1`; }
  const { rows } = await query(
    `SELECT * FROM (
       SELECT 'consultation' AS source_type, t.id AS source_id, t.number, t.patient_id, t.consulted_at AS date,
         t.amount, t.paid_amount, 'Consultation ' || t.number AS description
       FROM consultations t WHERE t.status <> 'annulee' AND t.amount > t.paid_amount ${pf}
       UNION ALL
       SELECT 'lab_request', t.id, t.number, t.patient_id, t.created_at, t.amount, t.paid_amount, 'Examens ' || t.number
       FROM lab_requests t WHERE t.status <> 'annulee' AND t.amount > t.paid_amount ${pf}
       UNION ALL
       SELECT 'pharmacy_sale', t.id, t.number, t.patient_id, t.created_at, t.amount, t.paid_amount, 'Pharmacie ' || t.number
       FROM pharmacy_sales t WHERE t.status = 'valide' AND t.amount > t.paid_amount ${pf}
     ) x LEFT JOIN LATERAL (
       SELECT patient_number, first_name || ' ' || last_name AS patient_name FROM patients WHERE id = x.patient_id
     ) p ON TRUE
     ORDER BY x.date DESC LIMIT 200`, vals);
  res.json(rows.map((r) => ({ ...r, remaining: r.amount - r.paid_amount })));
}));

router.get('/', requirePerm('payments.view'), ah(async (req, res) => {
  const { limit, offset } = paging(req);
  const where = []; const vals = [];
  addPeriod(where, vals, 'py.created_at', req.query);
  for (const f of ['method', 'status', 'source_type']) {
    if (req.query[f]) { vals.push(req.query[f]); where.push(`py.${f} = $${vals.length}`); }
  }
  if (req.query.received_by) { vals.push(Number(req.query.received_by)); where.push(`py.received_by = $${vals.length}`); }
  if (req.query.cash_session_id) { vals.push(Number(req.query.cash_session_id)); where.push(`py.cash_session_id = $${vals.length}`); }
  if (req.query.q) {
    vals.push(`%${String(req.query.q).toLowerCase()}%`);
    where.push(`(lower(py.number) LIKE $${vals.length} OR lower(py.receipt_number) LIKE $${vals.length}
      OR lower(coalesce(p.first_name || ' ' || p.last_name, py.payer_name, '')) LIKE $${vals.length} OR lower(coalesce(py.reference,'')) LIKE $${vals.length})`);
  }
  vals.push(limit, offset);
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const { rows } = await query(
    `SELECT py.id, py.number, py.receipt_number, py.description, py.source_type, py.source_id, py.gross_amount, py.discount,
       py.amount, py.method, py.reference, py.status, py.created_at, py.patient_id,
       coalesce(p.first_name || ' ' || p.last_name, py.payer_name) AS patient_name,
       u.first_name || ' ' || u.last_name AS received_by_name, count(*) OVER()::int AS total
     FROM payments py LEFT JOIN patients p ON p.id = py.patient_id JOIN users u ON u.id = py.received_by
     ${w} ORDER BY py.created_at DESC LIMIT $${vals.length - 1} OFFSET $${vals.length}`, vals);
  const { rows: [sum] } = await query(
    `SELECT coalesce(sum(py.amount) FILTER (WHERE py.status = 'valide'), 0) AS total_valid
     FROM payments py LEFT JOIN patients p ON p.id = py.patient_id ${w}`, vals.slice(0, -2));
  res.json({ items: rows.map(({ total, ...r }) => r), total: rows[0]?.total || 0, total_valid: sum.total_valid });
}));

async function getPayment(db, id) {
  const { rows: [py] } = await db.query(
    `SELECT py.*, coalesce(p.first_name || ' ' || p.last_name, py.payer_name) AS patient_name, p.patient_number,
       u.first_name || ' ' || u.last_name AS received_by_name, cs.number AS cash_session_number, cs.status AS cash_session_status
     FROM payments py LEFT JOIN patients p ON p.id = py.patient_id JOIN users u ON u.id = py.received_by
     LEFT JOIN cash_sessions cs ON cs.id = py.cash_session_id WHERE py.id = $1`, [id]);
  if (!py) throw notFound('Paiement introuvable');
  return py;
}

router.get('/:id', requirePerm('payments.view'), ah(async (req, res) => {
  const py = await getPayment({ query }, Number(req.params.id));
  const { rows: history } = await query(
    `SELECT id, username, action, summary, old_value, new_value, reason, created_at FROM audit_log
     WHERE entity_type = 'payment' AND entity_id = $1 ORDER BY id`, [String(py.id)]);
  res.json({ ...py, method_label: METHOD_LABELS[py.method], history });
}));

const createSchema = z.object({
  source_type: z.enum(['consultation', 'lab_request', 'pharmacy_sale', 'act', 'other']),
  source_id: z.coerce.number().int().positive().optional().nullable(),
  act_id: z.coerce.number().int().positive().optional().nullable(),
  quantity: z.coerce.number().int().min(1).default(1),
  patient_id: z.coerce.number().int().positive().optional().nullable(),
  payer_name: z.string().trim().max(150).optional().nullable(),
  description: z.string().trim().max(300).optional().nullable(),
  amount: z.coerce.number().int().min(1).optional(),      // montant brut à régler
  discount: z.coerce.number().int().min(0).default(0),
  method: z.enum(['especes', 'orange_money', 'mtn_money', 'virement', 'autre']),
  reference: z.string().trim().max(100).optional().nullable(),
  register_id: z.coerce.number().int().positive().optional().nullable(),
});

/** Encaissement. Protégé contre les doublons via l'en-tête Idempotency-Key. */
export async function createPayment(db, req, input) {
  const d = parse(createSchema, input);
  const settings = await getSettings();
  const key = req.get?.('Idempotency-Key') || input.idempotency_key || null;
  if (key) {
    const { rows } = await db.query('SELECT id FROM payments WHERE idempotency_key = $1', [key]);
    if (rows[0]) return { payment: await getPayment(db, rows[0].id), duplicate: true };
  }
  if (d.discount > 0 && !can(req.user, 'payments.discount')) throw forbidden('Vous n\'êtes pas autorisé à accorder une remise.');
  if (['orange_money', 'mtn_money', 'virement'].includes(d.method) && !d.reference) {
    throw badRequest('La référence de transaction est obligatoire pour ce mode de paiement.');
  }

  let patientId = d.patient_id ?? null; let description = d.description; let gross = d.amount;
  if (SOURCE_TABLES[d.source_type]) {
    if (!d.source_id) throw badRequest('Élément à payer manquant.');
    const { rows: [src] } = await db.query(
      `SELECT id, number, patient_id, amount, paid_amount, status
       FROM ${SOURCE_TABLES[d.source_type]} WHERE id = $1 FOR UPDATE`, [d.source_id]);
    if (!src) throw notFound('Élément à payer introuvable');
    if (['annulee'].includes(src.status)) throw badRequest('Élément annulé.');
    const remaining = src.amount - src.paid_amount;
    if (remaining <= 0) throw badRequest('Cet élément est déjà entièrement payé.');
    gross = gross ?? remaining;
    if (gross > remaining) throw badRequest(`Le montant dépasse le reste à payer (${fmtGNF(remaining)}).`);
    patientId = src.patient_id ?? patientId;
    description = description || `${SOURCE_LABELS[d.source_type]} ${src.number}`;
  } else if (d.source_type === 'act') {
    if (!d.act_id) throw badRequest('Acte manquant.');
    const { rows: [act] } = await db.query('SELECT * FROM medical_acts WHERE id = $1 AND active', [d.act_id]);
    if (!act) throw badRequest('Acte inconnu');
    gross = act.price * d.quantity;
    description = description || `${act.name}${d.quantity > 1 ? ` × ${d.quantity}` : ''}`;
  } else {
    if (!gross) throw badRequest('Montant obligatoire.');
    if (!description) throw badRequest('Libellé obligatoire.');
  }
  if (!patientId && !d.payer_name && d.source_type !== 'pharmacy_sale') throw badRequest('Patient ou nom du payeur obligatoire.');
  if (d.discount > gross) throw badRequest('La remise ne peut dépasser le montant.');
  const net = gross - d.discount;

  let session = null;
  if (d.method === 'especes') session = await requireOpenSession(db, d.register_id ?? null);
  else {
    const { rows } = await db.query(`SELECT * FROM cash_sessions WHERE status = 'ouverte' ORDER BY id LIMIT 1`);
    session = rows[0] || null;
  }

  const number = await nextNumber(db, 'payment', 'PAY');
  const receipt = await nextNumber(db, 'receipt', 'REC');
  const { rows: [py] } = await db.query(
    `INSERT INTO payments (site_id, number, receipt_number, patient_id, payer_name, source_type, source_id, description,
       gross_amount, discount, amount, method, reference, cash_session_id, received_by, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
    [req.user.siteId, number, receipt, patientId, d.payer_name || null, d.source_type,
      d.source_type === 'act' ? d.act_id : d.source_id ?? null, description, gross, d.discount, net, d.method,
      d.reference || null, session?.id ?? null, req.user.id, key]);
  if (d.method === 'especes' && net > 0) {
    await cashMovement(db, req, { sessionId: session.id, direction: 'in', category: 'paiement', amount: net, refType: 'payment', refId: py.id });
  }
  await refreshPaymentStatus(db, d.source_type, d.source_id);

  await audit(db, req.ctx, {
    action: 'payment.create', entityType: 'payment', entityId: py.id,
    summary: `Paiement ${fmtGNF(net)} — ${description} (${METHOD_LABELS[d.method]})`,
    newValue: { number, gross_amount: gross, discount: d.discount, amount: net, method: d.method, reference: d.reference || null },
    feed: { kind: 'payment', amount: net },
  });
  await notify(db, req.ctx, {
    permission: 'dashboard.finance', type: 'payment', icon: '🔔', title: 'Nouveau paiement enregistré',
    body: `+${fmtGNF(net)} — ${description} (${req.user.fullName})`, link: `/paiements/${py.id}`,
  });
  req.ctx.emit('perm:dashboard.finance', 'stats', { kind: 'payment' });
  if (d.discount > 0 && (d.discount / gross) * 100 >= settings.finance.discount_alert_percent) {
    await raiseAlert(db, req.ctx, {
      category: 'financiere', type: 'remise_importante', severity: 'moyenne',
      title: `Remise importante : ${fmtGNF(d.discount)} sur ${fmtGNF(gross)} (${number})`,
      details: { message: `${Math.round((d.discount / gross) * 100)} % accordés par ${req.user.fullName}` },
      refType: 'payment', refId: py.id, userId: req.user.id, link: `/paiements/${py.id}`,
    });
  }
  return { payment: await getPayment(db, py.id), duplicate: false };
}

router.post('/', requirePerm('payments.create'), ah(async (req, res) => {
  const { payment, duplicate } = await tx((db) => createPayment(db, req, req.body));
  res.status(duplicate ? 200 : 201).json(payment);
}));

const reasonSchema = z.string().trim().min(3, 'motif obligatoire').max(500);

router.put('/:id', requirePerm('payments.update'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const d = parse(z.object({
    amount: z.coerce.number().int().min(0).optional(),
    method: z.enum(['especes', 'orange_money', 'mtn_money', 'virement', 'autre']).optional(),
    reference: z.string().trim().max(100).optional().nullable(),
    reason: reasonSchema,
  }), req.body);
  const out = await tx(async (db) => {
    const { rows: [before] } = await db.query('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [id]);
    if (!before) throw notFound('Paiement introuvable');
    if (before.status !== 'valide') throw badRequest('Seul un paiement valide peut être modifié.');
    const newNet = d.amount ?? before.amount;
    const newMethod = d.method ?? before.method;
    const newGross = newNet + before.discount;
    if (SOURCE_TABLES[before.source_type] && newGross > before.gross_amount) {
      const { rows: [src] } = await db.query(`SELECT amount, paid_amount FROM ${SOURCE_TABLES[before.source_type]} WHERE id = $1`, [before.source_id]);
      const maxGross = src.amount - (src.paid_amount - before.gross_amount);
      if (newGross > maxGross) throw badRequest(`Le montant dépasse le reste à payer (${fmtGNF(maxGross - before.discount)}).`);
    }
    const cashBefore = before.method === 'especes' ? before.amount : 0;
    const cashAfter = newMethod === 'especes' ? newNet : 0;
    if (cashBefore !== cashAfter) {
      const { rows: [s] } = await db.query('SELECT status FROM cash_sessions WHERE id = $1', [before.cash_session_id]);
      if (before.method === 'especes' && s?.status !== 'ouverte') throw badRequest('La caisse de ce paiement est clôturée : utilisez un remboursement.');
      const session = before.method === 'especes' ? { id: before.cash_session_id } : await requireOpenSession(db);
      const delta = cashAfter - cashBefore;
      await cashMovement(db, req, {
        sessionId: session.id, direction: delta > 0 ? 'in' : 'out', category: 'correction', amount: Math.abs(delta),
        refType: 'payment', refId: id, note: d.reason,
      });
      if (!before.cash_session_id) await db.query('UPDATE payments SET cash_session_id = $1 WHERE id = $2', [session.id, id]);
    }
    await db.query(
      'UPDATE payments SET amount = $2, gross_amount = $3, method = $4, reference = $5, updated_at = now() WHERE id = $1',
      [id, newNet, newGross, newMethod, d.reference !== undefined ? d.reference : before.reference]);
    await refreshPaymentStatus(db, before.source_type, before.source_id);
    const oldValue = { amount: before.amount, method: before.method, reference: before.reference };
    const newValue = { amount: newNet, method: newMethod, reference: d.reference !== undefined ? d.reference : before.reference };
    await audit(db, req.ctx, {
      action: 'payment.update', entityType: 'payment', entityId: id,
      summary: `Modification du paiement ${before.number} : ${fmtGNF(before.amount)} → ${fmtGNF(newNet)}`,
      oldValue, newValue, reason: d.reason, feed: { kind: 'payment_update' },
    });
    await raiseAlert(db, req.ctx, {
      category: 'financiere', type: 'paiement_modifie', severity: 'moyenne',
      title: `Paiement modifié : ${before.number}`,
      details: { message: `${fmtGNF(before.amount)} (${METHOD_LABELS[before.method]}) → ${fmtGNF(newNet)} (${METHOD_LABELS[newMethod]}) par ${req.user.fullName} — motif : ${d.reason}`, oldValue, newValue },
      refType: 'payment', refId: id, userId: req.user.id, link: `/paiements/${id}`,
    });
    req.ctx.emit('perm:dashboard.finance', 'stats', { kind: 'payment' });
    return getPayment(db, id);
  });
  res.json(out);
}));

async function reversePayment(req, id, kind) {
  const { reason } = parse(z.object({ reason: reasonSchema }), req.body);
  return tx(async (db) => {
    const { rows: [before] } = await db.query('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [id]);
    if (!before) throw notFound('Paiement introuvable');
    if (before.status !== 'valide') throw badRequest('Ce paiement est déjà annulé ou remboursé.');
    if (before.method === 'especes' && before.amount > 0) {
      let sessionId;
      if (kind === 'cancel') {
        const { rows: [s] } = await db.query('SELECT status FROM cash_sessions WHERE id = $1', [before.cash_session_id]);
        if (s?.status !== 'ouverte') throw badRequest('La caisse de ce paiement est clôturée : effectuez un remboursement.');
        sessionId = before.cash_session_id;
      } else {
        sessionId = (await requireOpenSession(db)).id;
      }
      await cashMovement(db, req, {
        sessionId, direction: 'out', category: kind === 'cancel' ? 'annulation' : 'remboursement', amount: before.amount,
        refType: 'payment', refId: id, note: reason,
      });
    }
    const status = kind === 'cancel' ? 'annule' : 'rembourse';
    await db.query(
      `UPDATE payments SET status = $2, cancel_reason = $3, cancelled_by = $4, cancelled_at = now(), updated_at = now() WHERE id = $1`,
      [id, status, reason, req.user.id]);
    await refreshPaymentStatus(db, before.source_type, before.source_id);
    const label = kind === 'cancel' ? 'Annulation' : 'Remboursement';
    await audit(db, req.ctx, {
      action: kind === 'cancel' ? 'payment.cancel' : 'payment.refund', entityType: 'payment', entityId: id,
      summary: `${label} du paiement ${before.number} — ${fmtGNF(before.amount)}`,
      oldValue: { status: 'valide', amount: before.amount }, newValue: { status }, reason,
      feed: { kind: 'payment_reverse', amount: -before.amount },
    });
    await raiseAlert(db, req.ctx, {
      category: 'financiere', type: kind === 'cancel' ? 'paiement_annule' : 'remboursement', severity: 'moyenne',
      title: `${label} : ${fmtGNF(before.amount)} (${before.number})`,
      details: { message: `Par ${req.user.fullName} — motif : ${reason}` },
      refType: 'payment', refId: id, userId: req.user.id, link: `/paiements/${id}`,
    });
    req.ctx.emit('perm:dashboard.finance', 'stats', { kind: 'payment' });
    return getPayment(db, id);
  });
}

router.post('/:id/cancel', requirePerm('payments.cancel'), ah(async (req, res) => {
  res.json(await reversePayment(req, Number(req.params.id), 'cancel'));
}));
router.post('/:id/refund', requirePerm('payments.refund'), ah(async (req, res) => {
  res.json(await reversePayment(req, Number(req.params.id), 'refund'));
}));

// ---------------------------------------------------------------- Reçu PDF
router.get('/:id/receipt.pdf', requirePerm('payments.view', 'payments.create'), ah(async (req, res) => {
  const py = await getPayment({ query }, Number(req.params.id));
  const { clinic } = await getSettings();
  const doc = new PDFDocument({ size: [226, 460], margin: 14 }); // format ticket 80 mm
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="recu-${py.receipt_number}.pdf"`);
  doc.pipe(res);
  const dt = new Date(py.created_at);
  const line = () => { doc.moveDown(0.3); doc.moveTo(14, doc.y).lineTo(212, doc.y).dash(2, { space: 2 }).stroke().undash(); doc.moveDown(0.4); };
  const row = (k, v) => { doc.font('Helvetica').fontSize(8).text(k, { continued: true }).font('Helvetica-Bold').text(` ${v}`, { align: 'left' }); };
  doc.font('Helvetica-Bold').fontSize(12).text(clinic.name, { align: 'center' });
  doc.font('Helvetica').fontSize(7).text(clinic.address, { align: 'center' });
  if (clinic.phone) doc.text(`Tél. ${clinic.phone}`, { align: 'center' });
  line();
  doc.font('Helvetica-Bold').fontSize(10).text('REÇU DE PAIEMENT', { align: 'center' });
  if (py.status !== 'valide') doc.fillColor('#b91c1c').text(py.status === 'annule' ? '*** ANNULÉ ***' : '*** REMBOURSÉ ***', { align: 'center' }).fillColor('black');
  doc.moveDown(0.4);
  row('N° reçu :', py.receipt_number);
  row('Référence :', py.number);
  row('Date :', dt.toLocaleDateString('fr-FR'));
  row('Heure :', dt.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }));
  row('Patient :', `${py.patient_name || '—'}${py.patient_number ? ` (${py.patient_number})` : ''}`);
  line();
  row('Prestation :', py.description);
  if (py.discount > 0) { row('Montant :', fmtGNF(py.gross_amount)); row('Remise :', `- ${fmtGNF(py.discount)}`); }
  doc.moveDown(0.3).font('Helvetica-Bold').fontSize(11).text(`TOTAL PAYÉ : ${fmtGNF(py.amount)}`, { align: 'center' });
  doc.moveDown(0.3);
  row('Mode de paiement :', METHOD_LABELS[py.method]);
  if (py.reference) row('Réf. transaction :', py.reference);
  row('Caissier :', py.received_by_name);
  line();
  doc.font('Helvetica').fontSize(7).text('Merci de votre confiance. Conservez ce reçu.', { align: 'center' });
  doc.end();
}));

export default router;
