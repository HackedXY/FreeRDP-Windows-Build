import { can } from './auth.js';

/** Pagination standard ?page=&limit= */
export function paging(req, def = 50, max = 200) {
  const limit = Math.min(Math.max(Number(req.query.limit) || def, 1), max);
  const page = Math.max(Number(req.query.page) || 1, 1);
  return { limit, offset: (page - 1) * limit, page };
}

/**
 * Filtre de période : ?period=today|yesterday|week|month|year ou ?from=&to= (YYYY-MM-DD).
 * Retourne des bornes [from, to) en timestamps (fuseau du serveur de base de données).
 */
export function periodRange(q) {
  const now = new Date();
  const d0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  switch (q.period) {
    case 'today': return { from: d0, to: addDays(d0, 1) };
    case 'yesterday': return { from: addDays(d0, -1), to: d0 };
    case 'week': return { from: addDays(d0, -6), to: addDays(d0, 1) };
    case 'month': return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: addDays(d0, 1) };
    case 'year': return { from: new Date(now.getFullYear(), 0, 1), to: addDays(d0, 1) };
    default: {
      const from = q.from ? new Date(`${q.from}T00:00:00`) : null;
      const to = q.to ? addDays(new Date(`${q.to}T00:00:00`), 1) : null;
      return { from: from && !isNaN(from) ? from : null, to: to && !isNaN(to) ? to : null };
    }
  }
}

/** Ajoute des conditions de période à un tableau de clauses WHERE. */
export function addPeriod(where, vals, column, q) {
  const { from, to } = periodRange(q);
  if (from) { vals.push(from); where.push(`${column} >= $${vals.length}`); }
  if (to) { vals.push(to); where.push(`${column} < $${vals.length}`); }
}

export const fmtGNF = (n) => `${Math.round(Number(n) || 0).toLocaleString('fr-FR').replace(/[  ]/g, ' ')} GNF`;

export { can };

/** Met à jour le statut de paiement d'un élément facturable. */
export async function refreshPaymentStatus(db, sourceType, sourceId) {
  const table = { consultation: 'consultations', lab_request: 'lab_requests', pharmacy_sale: 'pharmacy_sales' }[sourceType];
  if (!table || !sourceId) return;
  await db.query(
    `UPDATE ${table} t SET paid_amount = p.total,
       payment_status = CASE WHEN p.total <= 0 THEN 'non_payee' WHEN p.total >= t.amount THEN 'payee' ELSE 'partielle' END
     FROM (SELECT coalesce(sum(gross_amount), 0) AS total FROM payments
           WHERE source_type = $1 AND source_id = $2 AND status = 'valide') p
     WHERE t.id = $2`,
    [sourceType, sourceId],
  );
}
