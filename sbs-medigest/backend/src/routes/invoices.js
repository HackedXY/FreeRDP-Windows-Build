// Factures patient : regroupent des éléments facturables (consultations, examens,
// ventes de pharmacie). Les montants (total, remises, payé, solde) et le statut sont
// calculés à partir des paiements existants : le système de paiement et de reçus reste
// la source de vérité (chaque encaissement produit toujours son reçu).
import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../db/pool.js';
import { ah, parse, notFound, badRequest } from '../lib/errors.js';
import { requirePerm } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { nextNumber } from '../lib/numbering.js';
import { getSettings } from '../lib/settings.js';
import { fmtGNF, paging } from '../lib/helpers.js';
import { sendPdf, fmtDateTime } from '../lib/documents.js';
import { createPayment, METHOD_LABELS } from './payments.js';

const router = Router();
const SOURCES = {
  consultation: { table: 'consultations', label: 'Consultation', date: 'consulted_at', active: `status <> 'annulee'` },
  lab_request: { table: 'lab_requests', label: 'Examens de laboratoire', date: 'created_at', active: `status <> 'annulee'` },
  pharmacy_sale: { table: 'pharmacy_sales', label: 'Pharmacie', date: 'created_at', active: `status = 'valide'` },
};
export const INVOICE_STATUS = { emise: 'Émise', partielle: 'Partiellement payée', payee: 'Payée', annulee: 'Annulée' };

/** Facture complète : lignes, paiements rattachés, totaux et statut calculés. */
export async function getInvoice(db, id) {
  const { rows: [inv] } = await db.query(
    `SELECT i.*, p.patient_number, p.first_name || ' ' || p.last_name AS patient_name, p.phone AS patient_phone, p.address AS patient_address,
       u.first_name || ' ' || u.last_name AS created_by_name, c.first_name || ' ' || c.last_name AS cancelled_by_name
     FROM invoices i JOIN patients p ON p.id = i.patient_id JOIN users u ON u.id = i.created_by LEFT JOIN users c ON c.id = i.cancelled_by
     WHERE i.id = $1`, [id]);
  if (!inv) throw notFound('Facture introuvable');
  const { rows: lines } = await db.query('SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY id', [id]);
  const { rows: payments } = await db.query(
    `SELECT py.id, py.number, py.receipt_number, py.source_type, py.source_id, py.gross_amount, py.discount, py.amount, py.method,
       py.reference, py.status, py.created_at, u.first_name || ' ' || u.last_name AS received_by_name
     FROM payments py JOIN invoice_lines l ON l.source_type = py.source_type AND l.source_id = py.source_id AND l.invoice_id = $1
     JOIN users u ON u.id = py.received_by ORDER BY py.created_at, py.id`, [id]);
  const valid = payments.filter((p) => p.status === 'valide');
  const out = lines.map((l) => {
    const lp = valid.filter((p) => p.source_type === l.source_type && p.source_id === l.source_id);
    const amount = l.unit_price * l.quantity;
    const covered = lp.reduce((s, p) => s + p.gross_amount, 0);
    return {
      ...l, amount,
      discount: lp.reduce((s, p) => s + p.discount, 0),
      paid: lp.reduce((s, p) => s + p.amount, 0),
      remaining: Math.max(amount - covered, 0),
    };
  });
  const total = out.reduce((s, l) => s + l.amount, 0);
  const discount = out.reduce((s, l) => s + l.discount, 0);
  const paid = out.reduce((s, l) => s + l.paid, 0);
  const remaining = out.reduce((s, l) => s + l.remaining, 0);
  const status = inv.cancelled_at ? 'annulee' : remaining === 0 && total > 0 ? 'payee' : paid + discount > 0 ? 'partielle' : 'emise';
  return {
    ...inv, status, status_label: INVOICE_STATUS[status],
    lines: out, payments: payments.map((p) => ({ ...p, method_label: METHOD_LABELS[p.method] })),
    total, discount, paid, remaining,
  };
}

/** Éléments facturables d'un patient qui ne figurent sur aucune facture active. */
router.get('/billable', requirePerm('payments.create', 'payments.view'), ah(async (req, res) => {
  const patientId = Number(req.query.patient_id);
  if (!patientId) throw badRequest('Patient obligatoire.');
  const parts = Object.entries(SOURCES).map(([type, s]) => `
    SELECT '${type}' AS source_type, t.id AS source_id, t.number, t.${s.date} AS date, t.amount, t.paid_amount
    FROM ${s.table} t WHERE t.patient_id = $1 AND t.${s.active} AND t.amount > 0
      AND NOT EXISTS (SELECT 1 FROM invoice_lines l WHERE l.active AND l.source_type = '${type}' AND l.source_id = t.id)`);
  const { rows } = await query(`SELECT * FROM (${parts.join(' UNION ALL ')}) x ORDER BY date DESC`, [patientId]);
  res.json(rows.map((r) => ({ ...r, label: `${SOURCES[r.source_type].label} ${r.number}`, remaining: r.amount - r.paid_amount })));
}));

// Liste : totaux et statut calculés en SQL pour toute la page (une requête, pas une par facture)
router.get('/', requirePerm('payments.view'), ah(async (req, res) => {
  const { limit, offset } = paging(req);
  const where = []; const vals = [];
  if (req.query.patient_id) { vals.push(Number(req.query.patient_id)); where.push(`i.patient_id = $${vals.length}`); }
  if (req.query.q) {
    vals.push(`%${String(req.query.q).toLowerCase()}%`);
    where.push(`(lower(i.number) LIKE $${vals.length} OR lower(p.patient_number) LIKE $${vals.length} OR lower(p.first_name || ' ' || p.last_name) LIKE $${vals.length})`);
  }
  const statusFilter = INVOICE_STATUS[req.query.status] ? req.query.status : null;
  if (statusFilter) vals.push(statusFilter);
  vals.push(limit, offset);
  const { rows } = await query(
    `WITH base AS (
       SELECT i.id, i.number, i.created_at, i.cancelled_at, i.patient_id, p.patient_number, p.first_name || ' ' || p.last_name AS patient_name
       FROM invoices i JOIN patients p ON p.id = i.patient_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ${statusFilter ? '' : `ORDER BY i.created_at DESC LIMIT $${vals.length - 1} OFFSET $${vals.length}`}),
     inv AS (
       SELECT i.*, t.* FROM base i
       CROSS JOIN LATERAL (
         SELECT count(*)::int AS line_count, coalesce(sum(l.unit_price * l.quantity), 0) AS total,
           coalesce(sum(pp.discount), 0) AS discount, coalesce(sum(pp.paid), 0) AS paid,
           coalesce(sum(greatest(l.unit_price * l.quantity - pp.covered, 0)), 0) AS remaining
         FROM invoice_lines l CROSS JOIN LATERAL (
           SELECT coalesce(sum(py.discount), 0) AS discount, coalesce(sum(py.amount), 0) AS paid, coalesce(sum(py.gross_amount), 0) AS covered
           FROM payments py WHERE py.source_type = l.source_type AND py.source_id = l.source_id AND py.status = 'valide') pp
         WHERE l.invoice_id = i.id) t),
     st AS (
       SELECT inv.*, CASE WHEN cancelled_at IS NOT NULL THEN 'annulee' WHEN remaining = 0 AND total > 0 THEN 'payee'
                          WHEN paid + discount > 0 THEN 'partielle' ELSE 'emise' END AS status
       FROM inv)
     SELECT st.*, count(*) OVER()::int AS total_count FROM st
     ${statusFilter ? `WHERE status = $${vals.length - 2} ORDER BY created_at DESC LIMIT $${vals.length - 1} OFFSET $${vals.length}` : 'ORDER BY created_at DESC'}`, vals);
  // sans filtre de statut, seule la page est calculée ; le total est un simple comptage
  let total = rows[0]?.total_count || 0;
  if (!statusFilter) {
    const { rows: [c] } = await query(
      `SELECT count(*)::int AS n FROM invoices i JOIN patients p ON p.id = i.patient_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`, vals.slice(0, -2));
    total = c.n;
  }
  res.json({
    items: rows.map(({ total_count, cancelled_at, ...r }) => ({ ...r, status_label: INVOICE_STATUS[r.status] })),
    total,
  });
}));

router.get('/:id', requirePerm('payments.view'), ah(async (req, res) => {
  res.json(await getInvoice({ query }, Number(req.params.id)));
}));

router.post('/', requirePerm('payments.create'), ah(async (req, res) => {
  const d = parse(z.object({
    patient_id: z.coerce.number().int().positive(),
    items: z.array(z.object({ source_type: z.enum(Object.keys(SOURCES)), source_id: z.coerce.number().int().positive() })).min(1),
    notes: z.string().trim().max(1000).optional().nullable(),
  }), req.body);
  const out = await tx(async (db) => {
    const { rows: [p] } = await db.query('SELECT id, patient_number FROM patients WHERE id = $1', [d.patient_id]);
    if (!p) throw badRequest('Patient introuvable');
    const seen = new Set();
    const lines = [];
    for (const it of d.items) {
      const key = `${it.source_type}:${it.source_id}`;
      if (seen.has(key)) throw badRequest('Élément en double dans la facture.');
      seen.add(key);
      const s = SOURCES[it.source_type];
      const { rows: [src] } = await db.query(`SELECT id, number, patient_id, amount FROM ${s.table} WHERE id = $1 AND ${s.active} FOR UPDATE`, [it.source_id]);
      if (!src) throw badRequest(`${s.label} introuvable ou annulé(e).`);
      if (src.patient_id !== p.id) throw badRequest(`${s.label} ${src.number} : autre patient.`);
      if (!(src.amount > 0)) throw badRequest(`${s.label} ${src.number} : rien à facturer.`);
      lines.push({ ...it, description: `${s.label} ${src.number}`, unit_price: src.amount });
    }
    const number = await nextNumber(db, 'invoice', 'FAC');
    const { rows: [inv] } = await db.query(
      'INSERT INTO invoices (site_id, number, patient_id, notes, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [req.user.siteId, number, p.id, d.notes || null, req.user.id]);
    for (const l of lines) {
      await db.query(
        'INSERT INTO invoice_lines (invoice_id, source_type, source_id, description, quantity, unit_price) VALUES ($1,$2,$3,$4,1,$5)',
        [inv.id, l.source_type, l.source_id, l.description, l.unit_price]);
    }
    const full = await getInvoice(db, inv.id);
    await audit(db, req.ctx, {
      action: 'invoice.create', entityType: 'invoice', entityId: inv.id,
      summary: `Facture ${number} — ${p.patient_number} — ${fmtGNF(full.total)} (${lines.length} ligne(s))`,
      newValue: { total: full.total, lines: lines.map((l) => ({ source_type: l.source_type, source_id: l.source_id, amount: l.unit_price })) },
      feed: false,
    });
    return full;
  });
  res.status(201).json(out);
}));

/**
 * Règlement d'une facture : le montant est réparti sur les lignes non soldées (dans l'ordre),
 * chaque part étant un paiement ordinaire (avec son reçu, sa caisse, son audit).
 */
router.post('/:id/pay', requirePerm('payments.create'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const d = parse(z.object({
    amount: z.coerce.number().int().min(1).optional(),
    method: z.enum(['especes', 'orange_money', 'mtn_money', 'virement', 'autre']),
    reference: z.string().trim().max(100).optional().nullable(),
    register_id: z.coerce.number().int().positive().optional().nullable(),
  }), req.body);
  const out = await tx(async (db) => {
    await db.query('SELECT id FROM invoices WHERE id = $1 FOR UPDATE', [id]);
    const inv = await getInvoice(db, id);
    if (inv.status === 'annulee') throw badRequest('Facture annulée.');
    if (inv.remaining <= 0) throw badRequest('Cette facture est déjà soldée.');
    let left = d.amount ?? inv.remaining;
    if (left > inv.remaining) throw badRequest(`Le montant dépasse le solde de la facture (${fmtGNF(inv.remaining)}).`);
    const created = [];
    for (const l of inv.lines) {
      if (left <= 0) break;
      if (l.remaining <= 0) continue;
      const part = Math.min(left, l.remaining);
      const { payment } = await createPayment(db, req, {
        source_type: l.source_type, source_id: l.source_id, patient_id: inv.patient_id, amount: part,
        method: d.method, reference: d.reference || null, register_id: d.register_id ?? null,
        description: `${l.description} — facture ${inv.number}`,
      });
      created.push(payment);
      left -= part;
    }
    const after = await getInvoice(db, id);
    await audit(db, req.ctx, {
      action: 'invoice.pay', entityType: 'invoice', entityId: id,
      summary: `Règlement de la facture ${inv.number} — ${fmtGNF(created.reduce((s, p) => s + p.amount, 0))} (${METHOD_LABELS[d.method]})`,
      newValue: { payments: created.map((p) => p.number), remaining: after.remaining, status: after.status }, feed: false,
    });
    return { invoice: after, payments: created };
  });
  res.status(201).json(out);
}));

router.post('/:id/cancel', requirePerm('payments.cancel'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const { reason } = parse(z.object({ reason: z.string().trim().min(3).max(500) }), req.body);
  const out = await tx(async (db) => {
    await db.query('SELECT id FROM invoices WHERE id = $1 FOR UPDATE', [id]);
    const inv = await getInvoice(db, id);
    if (inv.cancelled_at) throw badRequest('Facture déjà annulée.');
    // Une facture annulée libère ses lignes (refacturables) ; les paiements et reçus ne sont pas touchés
    await db.query('UPDATE invoices SET cancelled_at = now(), cancelled_by = $2, cancel_reason = $3 WHERE id = $1', [id, req.user.id, reason]);
    await db.query('UPDATE invoice_lines SET active = FALSE WHERE invoice_id = $1', [id]);
    await audit(db, req.ctx, {
      action: 'invoice.cancel', entityType: 'invoice', entityId: id, summary: `Annulation de la facture ${inv.number}`,
      oldValue: { status: inv.status, total: inv.total, paid: inv.paid }, newValue: { status: 'annulee' }, reason,
    });
    return getInvoice(db, id);
  });
  res.json(out);
}));

router.get('/:id/pdf', requirePerm('payments.view', 'payments.create'), ah(async (req, res) => {
  const inv = await getInvoice({ query }, Number(req.params.id));
  const { clinic } = await getSettings();
  await tx((db) => audit(db, req.ctx, { action: 'document.print', entityType: 'invoice', entityId: inv.id, summary: `Impression de la facture ${inv.number}`, feed: false }));
  sendPdf(res, {
    filename: `facture-${inv.number}.pdf`, clinic, title: 'Facture', type: 'facture', number: inv.number, issuedAt: inv.created_at,
    watermark: inv.status === 'annulee' ? '*** FACTURE ANNULÉE ***' : null,
  }, (doc, h) => {
    h.row('Patient :', `${inv.patient_name} (${inv.patient_number})`);
    if (inv.patient_phone) h.row('Téléphone :', inv.patient_phone);
    h.row('Statut :', inv.status_label);
    h.section('Détail');
    const x = [50, 330, 400, 470];
    const header = (y) => {
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#555');
      doc.text('Désignation', x[0], y); doc.text('Montant', x[1], y, { width: 65, align: 'right' });
      doc.text('Payé', x[2], y, { width: 65, align: 'right' }); doc.text('Reste', x[3], y, { width: 75, align: 'right' });
      doc.fillColor('#111');
    };
    header(doc.y);
    doc.moveDown(0.6);
    for (const l of inv.lines) {
      h.ensureSpace(20);
      const y = doc.y;
      doc.font('Helvetica').fontSize(10).text(l.description, x[0], y, { width: 270 });
      const yEnd = doc.y;
      doc.text(fmtGNF(l.amount), x[1], y, { width: 65, align: 'right' });
      doc.text(fmtGNF(l.paid + l.discount), x[2], y, { width: 65, align: 'right' });
      doc.text(fmtGNF(l.remaining), x[3], y, { width: 75, align: 'right' });
      doc.y = Math.max(yEnd, doc.y) + 4; doc.x = 50;
    }
    doc.moveDown(0.5);
    const tot = (label, v, bold) => { doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 12 : 10.5).text(`${label} ${fmtGNF(v)}`, 50, doc.y, { width: h.W, align: 'right' }); };
    tot('Total :', inv.total);
    if (inv.discount) tot('Remises :', -inv.discount);
    tot('Montant payé :', inv.paid);
    tot('Solde restant :', inv.remaining, true);
    if (inv.payments.length) {
      h.section('Historique des paiements');
      for (const p of inv.payments) {
        h.ensureSpace(16);
        doc.font('Helvetica').fontSize(9.5).text(
          `${fmtDateTime(p.created_at)} — reçu ${p.receipt_number} — ${fmtGNF(p.amount)} (${p.method_label})${p.discount ? `, remise ${fmtGNF(p.discount)}` : ''}${p.status !== 'valide' ? ` — ${p.status === 'annule' ? 'ANNULÉ' : 'REMBOURSÉ'}` : ''}`,
          50, doc.y, { width: h.W });
      }
    }
    if (inv.notes) { h.section('Notes'); doc.text(inv.notes); }
    doc.moveDown(1).font('Helvetica').fontSize(8.5).fillColor('#555').text('Montants en francs guinéens (GNF). Chaque paiement fait l\'objet d\'un reçu.', { width: h.W });
  });
}));

export default router;
