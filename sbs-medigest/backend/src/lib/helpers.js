import { can } from './auth.js';
import { resolveUnpaidSaleAlert } from './receivables.js';

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

/**
 * Série journalière recettes / dépenses / consultations sur [from, to) : un seul passage
 * agrégé par table (et non trois sous-requêtes par jour, coûteuses sur une longue période).
 * $1 = début (date), $2 = fin exclue (date).
 */
export const DAILY_SERIES_SQL = `
  WITH days AS (SELECT generate_series($1::date, $2::date - 1, interval '1 day')::date AS day),
  pay AS (SELECT created_at::date AS day, sum(amount) AS revenue FROM payments
          WHERE status = 'valide' AND created_at >= $1::date AND created_at < $2::date GROUP BY 1),
  exp AS (SELECT expense_date AS day, sum(amount) AS expenses FROM expenses
          WHERE status = 'validee' AND expense_date >= $1::date AND expense_date < $2::date GROUP BY 1),
  con AS (SELECT consulted_at::date AS day, count(*)::int AS consultations FROM consultations
          WHERE status <> 'annulee' AND consulted_at >= $1::date AND consulted_at < $2::date GROUP BY 1)
  SELECT days.day, coalesce(pay.revenue, 0) AS revenue, coalesce(exp.expenses, 0) AS expenses, coalesce(con.consultations, 0) AS consultations
  FROM days LEFT JOIN pay USING (day) LEFT JOIN exp USING (day) LEFT JOIN con USING (day) ORDER BY days.day`;

/** Met à jour le statut de paiement d'un élément facturable. */
export async function refreshPaymentStatus(db, sourceType, sourceId) {
  const table = { consultation: 'consultations', lab_request: 'lab_requests', pharmacy_sale: 'pharmacy_sales' }[sourceType];
  if (!table || !sourceId) return;
  if (sourceType === 'pharmacy_sale') {
    const { rows: [s] } = await db.query(
      `SELECT (coalesce(sum(gross_amount), 0) >= (SELECT amount FROM pharmacy_sales WHERE id = $1)) AS paid
       FROM payments WHERE source_type = 'pharmacy_sale' AND source_id = $1 AND status = 'valide'`, [sourceId]);
    if (s?.paid) await resolveUnpaidSaleAlert(db, sourceId, 'Résolue automatiquement : vente soldée');
  }
  await db.query(
    `UPDATE ${table} t SET paid_amount = p.total,
       payment_status = CASE WHEN p.total <= 0 THEN 'non_payee' WHEN p.total >= t.amount THEN 'payee' ELSE 'partielle' END
     FROM (SELECT coalesce(sum(gross_amount), 0) AS total FROM payments
           WHERE source_type = $1 AND source_id = $2 AND status = 'valide') p
     WHERE t.id = $2`,
    [sourceType, sourceId],
  );
}
