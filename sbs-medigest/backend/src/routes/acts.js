import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../db/pool.js';
import { ah, parse, notFound } from '../lib/errors.js';
import { requirePerm } from '../lib/auth.js';
import { audit, diff } from '../lib/audit.js';
import { raiseAlert } from '../lib/notify.js';
import { fmtGNF } from '../lib/helpers.js';

const router = Router();

const schema = z.object({
  code: z.string().trim().max(30).optional().nullable(),
  name: z.string().trim().min(2).max(150),
  category: z.string().trim().max(50).default('soin'),
  description: z.string().max(1000).optional().nullable(),
  price: z.coerce.number().int().min(0),
  duration_minutes: z.coerce.number().int().min(0).optional().nullable(),
  active: z.boolean().optional(),
});

router.get('/', ah(async (req, res) => {
  const where = req.query.all === '1' ? '' : 'WHERE active';
  const { rows } = await query(`SELECT * FROM medical_acts ${where} ORDER BY category, name`);
  res.json(rows);
}));

router.post('/', requirePerm('acts.manage'), ah(async (req, res) => {
  const d = parse(schema, req.body);
  const act = await tx(async (db) => {
    const { rows: [a] } = await db.query(
      `INSERT INTO medical_acts (code, name, category, description, price, duration_minutes, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [d.code || null, d.name, d.category, d.description || null, d.price, d.duration_minutes ?? null, d.active ?? true]);
    await audit(db, req.ctx, { action: 'act.create', entityType: 'medical_act', entityId: a.id, summary: `Nouvel acte : ${a.name} (${fmtGNF(a.price)})`, newValue: a, feed: false });
    return a;
  });
  res.status(201).json(act);
}));

router.put('/:id', requirePerm('acts.manage'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const d = parse(schema.partial(), req.body);
  const act = await tx(async (db) => {
    const { rows: [before] } = await db.query('SELECT * FROM medical_acts WHERE id = $1 FOR UPDATE', [id]);
    if (!before) throw notFound('Acte introuvable');
    const fields = ['code', 'name', 'category', 'description', 'price', 'duration_minutes', 'active'];
    const sets = []; const vals = [];
    for (const f of fields) if (d[f] !== undefined) { vals.push(d[f]); sets.push(`${f} = $${vals.length}`); }
    if (!sets.length) return before;
    vals.push(id);
    const { rows: [a] } = await db.query(`UPDATE medical_acts SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length} RETURNING *`, vals);
    const changes = diff(before, d, fields);
    if (changes) {
      const priceChanged = changes.newValue.price !== undefined;
      await audit(db, req.ctx, {
        action: priceChanged ? 'act.price_change' : 'act.update', entityType: 'medical_act', entityId: id,
        summary: priceChanged ? `Changement de prix — ${a.name} : ${fmtGNF(before.price)} → ${fmtGNF(a.price)}` : `Modification de l'acte ${a.name}`,
        ...changes,
      });
      if (priceChanged) {
        await raiseAlert(db, req.ctx, {
          category: 'systeme', type: 'changement_prix', severity: 'moyenne',
          title: `Changement de prix : ${a.name}`, details: { message: `${fmtGNF(before.price)} → ${fmtGNF(a.price)} par ${req.user.fullName}` },
          refType: 'medical_act', refId: id,
        });
      }
    }
    return a;
  });
  res.json(act);
}));

export default router;
