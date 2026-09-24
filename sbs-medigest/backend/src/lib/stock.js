import { badRequest, notFound } from './errors.js';
import { raiseAlert, notify } from './notify.js';
import { getSettings } from './settings.js';

export const REASON_LABELS = {
  achat: 'Achat', livraison: 'Livraison', retour: 'Retour', vente: 'Vente', utilisation: 'Utilisation',
  perte: 'Perte', expiration: 'Expiration', inventaire: 'Correction d\'inventaire', annulation_vente: 'Annulation de vente',
};

/**
 * Mouvement de stock unique point d'entrée : met à jour le produit, les lots
 * (sorties en FEFO : premier expiré, premier sorti) et l'historique.
 */
export async function moveStock(db, ctx, {
  productId, delta, reason, lotNumber = null, expiryDate = null, lotId = null, unitCost = null,
  supplierId = null, documentRef = null, refType = null, refId = null, note = null,
}) {
  if (!Number.isInteger(delta) || delta === 0) throw badRequest('Quantité invalide');
  const { rows: [p] } = await db.query('SELECT * FROM products WHERE id = $1 FOR UPDATE', [productId]);
  if (!p) throw notFound('Produit introuvable');
  const after = p.quantity + delta;
  if (after < 0) throw badRequest(`Stock insuffisant pour ${p.name} (disponible : ${p.quantity})`);

  let movementLotId = lotId;
  if (delta > 0) {
    const num = lotNumber || (lotId ? null : 'SANS-LOT');
    if (lotId) {
      await db.query('UPDATE product_lots SET quantity = quantity + $2 WHERE id = $1 AND product_id = $3', [lotId, delta, productId]);
    } else {
      const { rows: [lot] } = await db.query(
        `INSERT INTO product_lots (product_id, lot_number, expiry_date, quantity) VALUES ($1,$2,$3,$4)
         ON CONFLICT (product_id, lot_number) DO UPDATE SET quantity = product_lots.quantity + EXCLUDED.quantity,
           expiry_date = coalesce(EXCLUDED.expiry_date, product_lots.expiry_date)
         RETURNING id`, [productId, num, expiryDate, delta]);
      movementLotId = lot.id;
    }
  } else {
    let toTake = -delta;
    if (lotId) {
      const { rows: [lot] } = await db.query('SELECT * FROM product_lots WHERE id = $1 AND product_id = $2 FOR UPDATE', [lotId, productId]);
      if (!lot) throw notFound('Lot introuvable');
      if (lot.quantity < toTake) throw badRequest(`Quantité insuffisante dans le lot ${lot.lot_number} (${lot.quantity})`);
      await db.query('UPDATE product_lots SET quantity = quantity - $2 WHERE id = $1', [lotId, toTake]);
    } else {
      const { rows: lots } = await db.query(
        `SELECT id, quantity FROM product_lots WHERE product_id = $1 AND quantity > 0
         ORDER BY expiry_date NULLS LAST, id FOR UPDATE`, [productId]);
      for (const lot of lots) {
        if (!toTake) break;
        const take = Math.min(lot.quantity, toTake);
        await db.query('UPDATE product_lots SET quantity = quantity - $2 WHERE id = $1', [lot.id, take]);
        toTake -= take;
      }
    }
  }
  await db.query('UPDATE products SET quantity = $2, updated_at = now() WHERE id = $1', [productId, after]);
  const direction = reason === 'inventaire' ? 'adjust' : delta > 0 ? 'in' : 'out';
  const { rows: [m] } = await db.query(
    `INSERT INTO stock_movements (product_id, lot_id, direction, reason, quantity, qty_before, qty_after, unit_cost,
       supplier_id, document_ref, ref_type, ref_id, note, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [productId, movementLotId, direction, reason, delta, p.quantity, after, unitCost, supplierId, documentRef, refType, refId, note, ctx.user?.id ?? null]);
  await checkStockLevel(db, ctx, { ...p, quantity: after });
  return { movement: m, product: { ...p, quantity: after } };
}

export async function checkStockLevel(db, ctx, p) {
  if (p.quantity > p.min_threshold) {
    // Réapprovisionné : les alertes de niveau ouvertes sont résolues automatiquement
    await db.query(
      `UPDATE alerts SET status = 'resolue', resolved_at = now(), resolution_note = 'Résolue automatiquement : stock réapprovisionné'
       WHERE dedupe_key IN ($1, $2) AND status IN ('nouvelle','en_verification')`, [`stock_out:${p.id}`, `stock_low:${p.id}`]);
    return;
  }
  if (!p.active) return;
  if (p.quantity === 0) {
    const a = await raiseAlert(db, ctx, {
      category: 'stock', type: 'stock_epuise', severity: 'haute', title: `Stock épuisé : ${p.name}`,
      details: { message: `${p.reference} — seuil minimal ${p.min_threshold}` }, refType: 'product', refId: p.id,
      dedupeKey: `stock_out:${p.id}`, link: `/pharmacie/produits/${p.id}`,
    });
    if (a) await notify(db, ctx, { permission: 'pharmacy.manage', type: 'stock', icon: '📦', title: 'Stock épuisé', body: p.name, link: `/pharmacie/produits/${p.id}` });
  } else {
    const a = await raiseAlert(db, ctx, {
      category: 'stock', type: 'stock_faible', severity: 'moyenne', title: `Stock faible : ${p.name} (${p.quantity})`,
      details: { message: `${p.reference} — quantité ${p.quantity} ≤ seuil ${p.min_threshold}` }, refType: 'product', refId: p.id,
      dedupeKey: `stock_low:${p.id}`, link: `/pharmacie/produits/${p.id}`,
    });
    if (a) await notify(db, ctx, { permission: 'pharmacy.manage', type: 'stock', icon: '📦', title: 'Stock faible', body: `${p.name} : ${p.quantity} restant(s)`, link: `/pharmacie/produits/${p.id}` });
  }
}

/** Contrôle périodique des dates d'expiration. */
export async function checkExpiries(db, ctx) {
  const { stock } = await getSettings();
  const { rows } = await db.query(
    `SELECT l.id, l.lot_number, l.expiry_date, l.quantity, p.id AS product_id, p.name, p.reference,
       (l.expiry_date < CURRENT_DATE) AS expired
     FROM product_lots l JOIN products p ON p.id = l.product_id
     WHERE l.quantity > 0 AND p.active AND l.expiry_date IS NOT NULL
       AND l.expiry_date <= CURRENT_DATE + ($1 || ' days')::interval`, [String(stock.expiry_warning_days)]);
  let created = 0;
  for (const l of rows) {
    const a = await raiseAlert(db, ctx, {
      category: 'stock', type: l.expired ? 'produit_expire' : 'expiration_proche', severity: l.expired ? 'haute' : 'moyenne',
      title: `${l.expired ? 'Produit expiré' : 'Expiration proche'} : ${l.name} — lot ${l.lot_number} (${l.expiry_date})`,
      details: { message: `${l.quantity} unité(s) concernée(s)` }, refType: 'product', refId: l.product_id,
      dedupeKey: `${l.expired ? 'expired' : 'expiry'}:${l.id}`, link: `/pharmacie/produits/${l.product_id}`,
    });
    if (a) {
      created++;
      await notify(db, ctx, { permission: 'pharmacy.manage', type: 'stock', icon: '💊', title: 'Produit proche de l\'expiration', body: `${l.name} — lot ${l.lot_number} : ${l.expiry_date}`, link: `/pharmacie/produits/${l.product_id}` });
    }
  }
  return created;
}
