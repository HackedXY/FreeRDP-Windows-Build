import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../db/pool.js';
import { ah, parse, notFound, badRequest, forbidden } from '../lib/errors.js';
import { requirePerm, can } from '../lib/auth.js';
import { audit, diff } from '../lib/audit.js';
import { raiseAlert } from '../lib/notify.js';
import { nextNumber } from '../lib/numbering.js';
import { fmtGNF, paging, addPeriod, refreshPaymentStatus } from '../lib/helpers.js';
import { moveStock, checkStockLevel, REASON_LABELS } from '../lib/stock.js';
import { createPayment } from './payments.js';

const router = Router();

// ------------------------------------------------------------------ Produits
const productSchema = z.object({
  reference: z.string().trim().min(1).max(50),
  name: z.string().trim().min(2).max(200),
  category: z.enum(['medicament', 'consommable', 'produit_medical']),
  form: z.string().trim().max(80).optional().nullable(),
  supplier_id: z.coerce.number().int().positive().optional().nullable(),
  purchase_price: z.coerce.number().int().min(0),
  sale_price: z.coerce.number().int().min(0),
  min_threshold: z.coerce.number().int().min(0),
  active: z.boolean().optional(),
});
const PRODUCT_FIELDS = Object.keys(productSchema.shape);

router.get('/products', requirePerm('pharmacy.view', 'pharmacy.sell', 'prescriptions.create'), ah(async (req, res) => {
  const where = []; const vals = [];
  if (req.query.all !== '1') where.push('p.active');
  if (req.query.q) { vals.push(`%${String(req.query.q).toLowerCase()}%`); where.push(`(lower(p.name) LIKE $${vals.length} OR lower(p.reference) LIKE $${vals.length})`); }
  if (req.query.category) { vals.push(req.query.category); where.push(`p.category = $${vals.length}`); }
  if (req.query.low === '1') where.push('p.quantity <= p.min_threshold');
  const { rows } = await query(
    `SELECT p.*, s.name AS supplier_name,
       (SELECT min(expiry_date) FROM product_lots l WHERE l.product_id = p.id AND l.quantity > 0) AS next_expiry
     FROM products p LEFT JOIN suppliers s ON s.id = p.supplier_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.name LIMIT 1000`, vals);
  res.json(rows.map((p) => ({ ...p, stock_status: p.quantity === 0 ? 'epuise' : p.quantity <= p.min_threshold ? 'faible' : 'ok' })));
}));

router.get('/products/:id', requirePerm('pharmacy.view'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const { rows: [p] } = await query(
    'SELECT p.*, s.name AS supplier_name FROM products p LEFT JOIN suppliers s ON s.id = p.supplier_id WHERE p.id = $1', [id]);
  if (!p) throw notFound('Produit introuvable');
  const { rows: lots } = await query('SELECT * FROM product_lots WHERE product_id = $1 ORDER BY quantity > 0 DESC, expiry_date NULLS LAST', [id]);
  const { rows: movements } = await query(
    `SELECT m.*, u.first_name || ' ' || u.last_name AS user_name, l.lot_number
     FROM stock_movements m LEFT JOIN users u ON u.id = m.created_by LEFT JOIN product_lots l ON l.id = m.lot_id
     WHERE m.product_id = $1 ORDER BY m.id DESC LIMIT 300`, [id]);
  res.json({ ...p, lots, movements });
}));

router.post('/products', requirePerm('pharmacy.manage'), ah(async (req, res) => {
  const d = parse(productSchema.extend({
    initial_quantity: z.coerce.number().int().min(0).optional(),
    lot_number: z.string().trim().max(50).optional().nullable(),
    expiry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable().or(z.literal('').transform(() => null)),
  }), req.body);
  const out = await tx(async (db) => {
    const { rows: dup } = await db.query('SELECT 1 FROM products WHERE lower(reference) = lower($1)', [d.reference]);
    if (dup.length) throw badRequest('Cette référence existe déjà.');
    const { rows: [p] } = await db.query(
      `INSERT INTO products (site_id, reference, name, category, form, supplier_id, purchase_price, sale_price, min_threshold)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.user.siteId, d.reference, d.name, d.category, d.form || null, d.supplier_id || null, d.purchase_price, d.sale_price, d.min_threshold]);
    await audit(db, req.ctx, {
      action: 'product.create', entityType: 'product', entityId: p.id, summary: `Nouveau produit : ${p.name} (${fmtGNF(p.sale_price)})`,
      newValue: { reference: p.reference, purchase_price: p.purchase_price, sale_price: p.sale_price }, feed: false,
    });
    if (d.initial_quantity) {
      await moveStock(db, req.ctx, {
        productId: p.id, delta: d.initial_quantity, reason: 'achat', lotNumber: d.lot_number || null, expiryDate: d.expiry_date || null,
        unitCost: d.purchase_price, supplierId: d.supplier_id || null, note: 'Stock initial',
      });
    }
    return p;
  });
  res.status(201).json(out);
}));

router.put('/products/:id', requirePerm('pharmacy.manage'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const d = parse(productSchema.partial(), req.body);
  const out = await tx(async (db) => {
    const { rows: [before] } = await db.query('SELECT * FROM products WHERE id = $1 FOR UPDATE', [id]);
    if (!before) throw notFound('Produit introuvable');
    const sets = []; const vals = [];
    for (const f of PRODUCT_FIELDS) if (d[f] !== undefined) { vals.push(d[f]); sets.push(`${f} = $${vals.length}`); }
    if (!sets.length) return before;
    vals.push(id);
    const { rows: [p] } = await db.query(`UPDATE products SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length} RETURNING *`, vals);
    const ch = diff(before, d, PRODUCT_FIELDS);
    if (ch) {
      const priceChanged = ch.newValue.sale_price !== undefined || ch.newValue.purchase_price !== undefined;
      await audit(db, req.ctx, {
        action: priceChanged ? 'product.price_change' : 'product.update', entityType: 'product', entityId: id,
        summary: priceChanged ? `Changement de prix — ${p.name} : ${fmtGNF(before.sale_price)} → ${fmtGNF(p.sale_price)}` : `Modification du produit ${p.name}`,
        ...ch,
      });
      if (priceChanged) {
        await raiseAlert(db, req.ctx, {
          category: 'systeme', type: 'changement_prix', severity: 'moyenne', title: `Changement de prix : ${p.name}`,
          details: { message: `Vente ${fmtGNF(before.sale_price)} → ${fmtGNF(p.sale_price)}, achat ${fmtGNF(before.purchase_price)} → ${fmtGNF(p.purchase_price)} — par ${req.user.fullName}` },
          refType: 'product', refId: id, link: `/pharmacie/produits/${id}`,
        });
      }
      if (ch.newValue.min_threshold !== undefined) await checkStockLevel(db, req.ctx, p);
    }
    return p;
  });
  res.json(out);
}));

// ------------------------------------------------------------------ Mouvements
router.get('/movements', requirePerm('pharmacy.view'), ah(async (req, res) => {
  const { limit, offset } = paging(req, 100);
  const where = []; const vals = [];
  addPeriod(where, vals, 'm.created_at', req.query);
  for (const f of ['reason', 'direction']) if (req.query[f]) { vals.push(req.query[f]); where.push(`m.${f} = $${vals.length}`); }
  if (req.query.product_id) { vals.push(Number(req.query.product_id)); where.push(`m.product_id = $${vals.length}`); }
  if (req.query.user_id) { vals.push(Number(req.query.user_id)); where.push(`m.created_by = $${vals.length}`); }
  vals.push(limit, offset);
  const { rows } = await query(
    `SELECT m.*, p.name AS product_name, p.reference, u.first_name || ' ' || u.last_name AS user_name, l.lot_number,
       count(*) OVER()::int AS total
     FROM stock_movements m JOIN products p ON p.id = m.product_id LEFT JOIN users u ON u.id = m.created_by
     LEFT JOIN product_lots l ON l.id = m.lot_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY m.id DESC LIMIT $${vals.length - 1} OFFSET $${vals.length}`, vals);
  res.json({ items: rows.map(({ total, ...r }) => r), total: rows[0]?.total || 0 });
}));

router.post('/stock/in', requirePerm('stock.move'), ah(async (req, res) => {
  const d = parse(z.object({
    product_id: z.coerce.number().int().positive(),
    quantity: z.coerce.number().int().min(1),
    reason: z.enum(['achat', 'livraison', 'retour']),
    lot_number: z.string().trim().max(50).optional().nullable(),
    expiry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable().or(z.literal('').transform(() => null)),
    unit_cost: z.coerce.number().int().min(0).optional().nullable(),
    supplier_id: z.coerce.number().int().positive().optional().nullable(),
    document_ref: z.string().trim().max(100).optional().nullable(),
    note: z.string().trim().max(500).optional().nullable(),
  }), req.body);
  const out = await tx(async (db) => {
    const r = await moveStock(db, req.ctx, {
      productId: d.product_id, delta: d.quantity, reason: d.reason, lotNumber: d.lot_number, expiryDate: d.expiry_date,
      unitCost: d.unit_cost ?? null, supplierId: d.supplier_id ?? null, documentRef: d.document_ref ?? null, note: d.note ?? null,
    });
    await audit(db, req.ctx, {
      action: 'stock.in', entityType: 'product', entityId: d.product_id,
      summary: `Entrée de stock — ${r.product.name} : +${d.quantity} (${REASON_LABELS[d.reason]})`,
      oldValue: { quantity: r.movement.qty_before }, newValue: { quantity: r.movement.qty_after }, feed: { kind: 'stock' },
    });
    return r.movement;
  });
  res.status(201).json(out);
}));

router.post('/stock/out', requirePerm('stock.move'), ah(async (req, res) => {
  const d = parse(z.object({
    product_id: z.coerce.number().int().positive(),
    quantity: z.coerce.number().int().min(1),
    reason: z.enum(['utilisation', 'perte', 'expiration', 'retour']),
    lot_id: z.coerce.number().int().positive().optional().nullable(),
    note: z.string().trim().max(500).optional().nullable(),
  }), req.body);
  if (['perte', 'expiration'].includes(d.reason) && !d.note) throw badRequest('Une justification est obligatoire pour une perte ou une expiration.');
  const out = await tx(async (db) => {
    const r = await moveStock(db, req.ctx, { productId: d.product_id, delta: -d.quantity, reason: d.reason, lotId: d.lot_id ?? null, note: d.note ?? null });
    await audit(db, req.ctx, {
      action: 'stock.out', entityType: 'product', entityId: d.product_id,
      summary: `Sortie de stock — ${r.product.name} : -${d.quantity} (${REASON_LABELS[d.reason]})`,
      oldValue: { quantity: r.movement.qty_before }, newValue: { quantity: r.movement.qty_after }, reason: d.note ?? null, feed: { kind: 'stock' },
    });
    return r.movement;
  });
  res.status(201).json(out);
}));

// ------------------------------------------------------------------ Ventes
router.get('/sales', requirePerm('pharmacy.view', 'pharmacy.sell', 'payments.view'), ah(async (req, res) => {
  const { limit, offset } = paging(req);
  const where = []; const vals = [];
  addPeriod(where, vals, 's.created_at', req.query);
  if (req.query.payment_status) { vals.push(req.query.payment_status); where.push(`s.payment_status = $${vals.length}`); }
  vals.push(limit, offset);
  const { rows } = await query(
    `SELECT s.*, coalesce(p.first_name || ' ' || p.last_name, s.customer_name) AS customer, u.first_name || ' ' || u.last_name AS sold_by_name,
       (SELECT string_agg(pr.name || ' × ' || i.quantity, ', ') FROM pharmacy_sale_items i JOIN products pr ON pr.id = i.product_id WHERE i.sale_id = s.id) AS items_summary,
       count(*) OVER()::int AS total
     FROM pharmacy_sales s LEFT JOIN patients p ON p.id = s.patient_id LEFT JOIN users u ON u.id = s.sold_by
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY s.created_at DESC LIMIT $${vals.length - 1} OFFSET $${vals.length}`, vals);
  res.json({ items: rows.map(({ total, ...r }) => r), total: rows[0]?.total || 0 });
}));

router.post('/sales', requirePerm('pharmacy.sell'), ah(async (req, res) => {
  const d = parse(z.object({
    patient_id: z.coerce.number().int().positive().optional().nullable(),
    customer_name: z.string().trim().max(150).optional().nullable(),
    prescription_id: z.coerce.number().int().positive().optional().nullable(),
    items: z.array(z.object({ product_id: z.coerce.number().int().positive(), quantity: z.coerce.number().int().min(1) })).min(1),
    payment: z.object({
      method: z.enum(['especes', 'orange_money', 'mtn_money', 'virement', 'autre']),
      reference: z.string().trim().max(100).optional().nullable(),
      discount: z.coerce.number().int().min(0).optional(),
    }).optional().nullable(),
  }), req.body);
  if (d.payment && !can(req.user, 'payments.create')) throw forbidden('Vous n\'êtes pas autorisé à encaisser : la vente sera réglée en caisse.');
  const out = await tx(async (db) => {
    const number = await nextNumber(db, 'pharmacy_sale', 'VTE');
    let amount = 0; const lines = [];
    for (const it of d.items) {
      const { rows: [p] } = await db.query('SELECT id, name, sale_price, active FROM products WHERE id = $1', [it.product_id]);
      if (!p || !p.active) throw badRequest(`Produit introuvable ou inactif (#${it.product_id})`);
      amount += p.sale_price * it.quantity; lines.push({ ...it, unit_price: p.sale_price, name: p.name });
    }
    const { rows: [s] } = await db.query(
      `INSERT INTO pharmacy_sales (site_id, number, patient_id, customer_name, prescription_id, amount, sold_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.user.siteId, number, d.patient_id || null, d.customer_name || null, d.prescription_id || null, amount, req.user.id]);
    for (const l of lines) {
      await db.query('INSERT INTO pharmacy_sale_items (sale_id, product_id, quantity, unit_price) VALUES ($1,$2,$3,$4)', [s.id, l.product_id, l.quantity, l.unit_price]);
      await moveStock(db, req.ctx, { productId: l.product_id, delta: -l.quantity, reason: 'vente', refType: 'pharmacy_sale', refId: s.id });
    }
    await audit(db, req.ctx, {
      action: 'pharmacy.sale', entityType: 'pharmacy_sale', entityId: s.id,
      // les médicaments délivrés à un patient sont une information médicale : pas de libellé dans le fil
      summary: `Vente médicament ${number} — ${fmtGNF(amount)} (${lines.length} article(s))`,
      newValue: { amount, items: lines.map((l) => ({ product_id: l.product_id, quantity: l.quantity, unit_price: l.unit_price })) },
      feed: { kind: 'pharmacy', amount },
    });
    let payment = null;
    if (d.payment) {
      ({ payment } = await createPayment(db, req, {
        source_type: 'pharmacy_sale', source_id: s.id, patient_id: d.patient_id, payer_name: d.customer_name,
        method: d.payment.method, reference: d.payment.reference, discount: d.payment.discount || 0,
      }));
    }
    req.ctx.emit('perm:dashboard.view', 'stats', { kind: 'pharmacy' });
    return { ...s, items: lines, payment };
  });
  res.status(201).json(out);
}));

router.post('/sales/:id/cancel', requirePerm('pharmacy.cancel_sale'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const { reason } = parse(z.object({ reason: z.string().trim().min(3) }), req.body);
  await tx(async (db) => {
    const { rows: [s] } = await db.query('SELECT * FROM pharmacy_sales WHERE id = $1 FOR UPDATE', [id]);
    if (!s) throw notFound('Vente introuvable');
    if (s.status === 'annulee') throw badRequest('Vente déjà annulée.');
    await refreshPaymentStatus(db, 'pharmacy_sale', id);
    const { rows: [fresh] } = await db.query('SELECT paid_amount FROM pharmacy_sales WHERE id = $1', [id]);
    if (fresh.paid_amount > 0) throw badRequest('Vente payée : annulez ou remboursez d\'abord le paiement.');
    const { rows: items } = await db.query('SELECT * FROM pharmacy_sale_items WHERE sale_id = $1', [id]);
    for (const it of items) {
      await moveStock(db, req.ctx, { productId: it.product_id, delta: it.quantity, reason: 'annulation_vente', refType: 'pharmacy_sale', refId: id, note: reason });
    }
    await db.query(`UPDATE pharmacy_sales SET status = 'annulee', cancel_reason = $2 WHERE id = $1`, [id, reason]);
    await audit(db, req.ctx, {
      action: 'pharmacy.sale_cancel', entityType: 'pharmacy_sale', entityId: id, summary: `Annulation de la vente ${s.number} — ${fmtGNF(s.amount)}`,
      oldValue: { status: 'valide' }, newValue: { status: 'annulee' }, reason,
    });
  });
  res.json({ ok: true });
}));

// ------------------------------------------------------------------ Inventaires
router.get('/inventories', requirePerm('stock.inventory', 'pharmacy.view'), ah(async (_req, res) => {
  const { rows } = await query(
    `SELECT i.*, u.first_name || ' ' || u.last_name AS started_by_name, v.first_name || ' ' || v.last_name AS validated_by_name,
       (SELECT count(*)::int FROM inventory_lines l WHERE l.inventory_id = i.id) AS line_count,
       (SELECT count(*)::int FROM inventory_lines l WHERE l.inventory_id = i.id AND l.counted_qty IS NOT NULL AND l.counted_qty <> l.theoretical_qty) AS diff_count
     FROM inventories i LEFT JOIN users u ON u.id = i.started_by LEFT JOIN users v ON v.id = i.validated_by ORDER BY i.id DESC`);
  res.json(rows);
}));

router.get('/inventories/:id', requirePerm('stock.inventory', 'pharmacy.view'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const { rows: [inv] } = await query('SELECT * FROM inventories WHERE id = $1', [id]);
  if (!inv) throw notFound('Inventaire introuvable');
  const { rows: lines } = await query(
    `SELECT l.*, p.name, p.reference, p.quantity AS current_qty, p.purchase_price
     FROM inventory_lines l JOIN products p ON p.id = l.product_id WHERE l.inventory_id = $1 ORDER BY p.name`, [id]);
  res.json({ ...inv, lines });
}));

router.post('/inventories', requirePerm('stock.inventory'), ah(async (req, res) => {
  const { notes } = parse(z.object({ notes: z.string().max(1000).optional().nullable() }), req.body);
  const out = await tx(async (db) => {
    const { rows: open } = await db.query(`SELECT id FROM inventories WHERE status = 'en_cours'`);
    if (open.length) throw badRequest('Un inventaire est déjà en cours.');
    const number = await nextNumber(db, 'inventory', 'INV');
    const { rows: [inv] } = await db.query('INSERT INTO inventories (number, notes, started_by) VALUES ($1,$2,$3) RETURNING *', [number, notes || null, req.user.id]);
    await db.query(
      `INSERT INTO inventory_lines (inventory_id, product_id, theoretical_qty) SELECT $1, id, quantity FROM products WHERE active`, [inv.id]);
    await audit(db, req.ctx, { action: 'inventory.start', entityType: 'inventory', entityId: inv.id, summary: `Début de l'inventaire ${number}` });
    return inv;
  });
  res.status(201).json(out);
}));

router.put('/inventories/:id/lines', requirePerm('stock.inventory'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const { lines } = parse(z.object({
    lines: z.array(z.object({
      product_id: z.coerce.number().int().positive(),
      counted_qty: z.coerce.number().int().min(0).nullable(),
      justification: z.string().max(500).optional().nullable(),
    })),
  }), req.body);
  await tx(async (db) => {
    const { rows: [inv] } = await db.query('SELECT status FROM inventories WHERE id = $1', [id]);
    if (!inv || inv.status !== 'en_cours') throw badRequest('Inventaire non modifiable.');
    for (const l of lines) {
      await db.query('UPDATE inventory_lines SET counted_qty = $3, justification = $4 WHERE inventory_id = $1 AND product_id = $2',
        [id, l.product_id, l.counted_qty, l.justification || null]);
    }
  });
  res.json({ ok: true });
}));

router.post('/inventories/:id/validate', requirePerm('stock.inventory'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const out = await tx(async (db) => {
    const { rows: [inv] } = await db.query('SELECT * FROM inventories WHERE id = $1 FOR UPDATE', [id]);
    if (!inv || inv.status !== 'en_cours') throw badRequest('Inventaire non validable.');
    const { rows: lines } = await db.query(
      `SELECT l.*, p.name, p.purchase_price FROM inventory_lines l JOIN products p ON p.id = l.product_id
       WHERE l.inventory_id = $1 AND l.counted_qty IS NOT NULL AND l.counted_qty <> l.theoretical_qty`, [id]);
    const missing = lines.filter((l) => !l.justification || l.justification.trim().length < 3);
    if (missing.length) throw badRequest(`Justification obligatoire pour les écarts : ${missing.map((l) => l.name).join(', ')}`);
    let value = 0;
    for (const l of lines) {
      const delta = l.counted_qty - l.theoretical_qty;
      value += delta * l.purchase_price;
      await moveStock(db, req.ctx, { productId: l.product_id, delta, reason: 'inventaire', refType: 'inventory', refId: id, note: l.justification });
    }
    await db.query(`UPDATE inventories SET status = 'valide', validated_by = $2, validated_at = now() WHERE id = $1`, [id, req.user.id]);
    await audit(db, req.ctx, {
      action: 'inventory.validate', entityType: 'inventory', entityId: id,
      summary: `Validation de l'inventaire ${inv.number} — ${lines.length} écart(s), valeur ${fmtGNF(value)}`,
      newValue: { corrections: lines.map((l) => ({ product: l.name, theoretical: l.theoretical_qty, counted: l.counted_qty, justification: l.justification })) },
    });
    if (lines.length) {
      await raiseAlert(db, req.ctx, {
        category: 'stock', type: 'correction_inventaire', severity: 'moyenne',
        title: `Correction d'inventaire ${inv.number} : ${lines.length} écart(s)`,
        details: { message: `Valeur des écarts : ${fmtGNF(value)} — par ${req.user.fullName}` },
        refType: 'inventory', refId: id, userId: req.user.id, link: `/pharmacie/inventaires/${id}`,
      });
    }
    return { corrections: lines.length, value };
  });
  res.json(out);
}));

export default router;
