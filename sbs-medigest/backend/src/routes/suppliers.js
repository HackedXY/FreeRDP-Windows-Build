import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../db/pool.js';
import { ah, parse, notFound } from '../lib/errors.js';
import { requirePerm } from '../lib/auth.js';
import { audit, diff } from '../lib/audit.js';

const router = Router();
const schema = z.object({
  name: z.string().trim().min(2).max(150),
  phone: z.string().trim().max(30).optional().nullable(),
  email: z.string().trim().max(150).optional().nullable(),
  address: z.string().trim().max(300).optional().nullable(),
  products: z.string().max(1000).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  active: z.boolean().optional(),
});
const FIELDS = Object.keys(schema.shape);

router.get('/', requirePerm('suppliers.view', 'pharmacy.view', 'expenses.create'), ah(async (_req, res) => {
  const { rows } = await query(
    `SELECT s.*, (SELECT count(*)::int FROM products p WHERE p.supplier_id = s.id) AS product_count,
       (SELECT coalesce(sum(m.quantity * coalesce(m.unit_cost,0)), 0) FROM stock_movements m WHERE m.supplier_id = s.id AND m.reason IN ('achat','livraison')) AS purchases_total,
       (SELECT coalesce(sum(e.amount), 0) FROM expenses e WHERE e.supplier_id = s.id AND e.status = 'validee') AS paid_total
     FROM suppliers s ORDER BY s.active DESC, s.name`);
  res.json(rows);
}));

router.get('/:id', requirePerm('suppliers.view'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const { rows: [s] } = await query('SELECT * FROM suppliers WHERE id = $1', [id]);
  if (!s) throw notFound('Fournisseur introuvable');
  const { rows: products } = await query('SELECT id, reference, name, purchase_price, quantity FROM products WHERE supplier_id = $1 ORDER BY name', [id]);
  const { rows: purchases } = await query(
    `SELECT m.id, m.created_at, m.quantity, m.unit_cost, m.document_ref, m.reason, p.name AS product_name
     FROM stock_movements m JOIN products p ON p.id = m.product_id WHERE m.supplier_id = $1 ORDER BY m.created_at DESC LIMIT 200`, [id]);
  const { rows: payments } = await query(
    `SELECT id, number, amount, reason, status, expense_date, attachment_name FROM expenses WHERE supplier_id = $1 ORDER BY created_at DESC LIMIT 200`, [id]);
  res.json({ ...s, product_list: products, purchases, payments });
}));

router.post('/', requirePerm('suppliers.manage'), ah(async (req, res) => {
  const d = parse(schema, req.body);
  const s = await tx(async (db) => {
    const { rows: [s] } = await db.query(
      `INSERT INTO suppliers (name, phone, email, address, products, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [d.name, d.phone || null, d.email || null, d.address || null, d.products || null, d.notes || null]);
    await audit(db, req.ctx, { action: 'supplier.create', entityType: 'supplier', entityId: s.id, summary: `Nouveau fournisseur : ${s.name}`, feed: false });
    return s;
  });
  res.status(201).json(s);
}));

router.put('/:id', requirePerm('suppliers.manage'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const d = parse(schema.partial(), req.body);
  const s = await tx(async (db) => {
    const { rows: [before] } = await db.query('SELECT * FROM suppliers WHERE id = $1 FOR UPDATE', [id]);
    if (!before) throw notFound('Fournisseur introuvable');
    const sets = []; const vals = [];
    for (const f of FIELDS) if (d[f] !== undefined) { vals.push(d[f]); sets.push(`${f} = $${vals.length}`); }
    if (!sets.length) return before;
    vals.push(id);
    const { rows: [s] } = await db.query(`UPDATE suppliers SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length} RETURNING *`, vals);
    const ch = diff(before, d, FIELDS);
    if (ch) await audit(db, req.ctx, { action: 'supplier.update', entityType: 'supplier', entityId: id, summary: `Modification du fournisseur ${s.name}`, ...ch, feed: false });
    return s;
  });
  res.json(s);
}));

export default router;
