import { Router } from 'express';
import { query } from '../db/pool.js';
import { ah, notFound, badRequest } from '../lib/errors.js';
import { requirePerm } from '../lib/auth.js';
import { periodRange, DAILY_SERIES_SQL } from '../lib/helpers.js';

const router = Router();

function range(req) {
  const { from, to } = periodRange(req.query);
  if (!from || !to) throw badRequest('Période invalide : précisez period=… ou from=YYYY-MM-DD&to=YYYY-MM-DD');
  if (to - from > 800 * 86400000) throw badRequest('Période trop longue (max. ~2 ans).');
  return { from, to };
}

async function totals(from, to) {
  const { rows: [t] } = await query(
    `SELECT
       (SELECT coalesce(sum(amount), 0) FROM payments WHERE status = 'valide' AND created_at >= $1 AND created_at < $2) AS revenue,
       (SELECT coalesce(sum(amount), 0) FROM expenses WHERE status = 'validee' AND expense_date >= $1::date AND expense_date < $2::date) AS expenses,
       (SELECT count(*)::int FROM consultations WHERE status <> 'annulee' AND consulted_at >= $1 AND consulted_at < $2) AS consultations,
       (SELECT count(*)::int FROM patients WHERE created_at >= $1 AND created_at < $2) AS new_patients,
       (SELECT count(DISTINCT patient_id)::int FROM consultations WHERE status <> 'annulee' AND consulted_at >= $1 AND consulted_at < $2) AS patients_seen,
       (SELECT coalesce(sum(amount), 0) FROM pharmacy_sales WHERE status = 'valide' AND created_at >= $1 AND created_at < $2) AS pharmacy_sales,
       (SELECT count(*)::int FROM lab_requests WHERE status <> 'annulee' AND created_at >= $1 AND created_at < $2) AS lab_requests`,
    [from, to]);
  return t;
}

router.get('/summary', requirePerm('reports.view'), ah(async (req, res) => {
  const { from, to } = range(req);
  const len = to - from;
  const prevFrom = new Date(from.getTime() - len);
  const p = [from, to];
  const [current, previous, bySource, byMethod, reversals, expByCat, acts, exams, topProducts, cogs, sessions, series, doctors, consultStatus] = await Promise.all([
    totals(from, to),
    totals(prevFrom, from),
    query(`SELECT source_type, count(*)::int AS count, coalesce(sum(amount), 0) AS total, coalesce(sum(discount), 0) AS discounts
           FROM payments WHERE status = 'valide' AND created_at >= $1 AND created_at < $2 GROUP BY source_type ORDER BY total DESC`, p),
    query(`SELECT method, count(*)::int AS count, coalesce(sum(amount), 0) AS total
           FROM payments WHERE status = 'valide' AND created_at >= $1 AND created_at < $2 GROUP BY method ORDER BY total DESC`, p),
    query(`SELECT status, count(*)::int AS count, coalesce(sum(amount), 0) AS total
           FROM payments WHERE status <> 'valide' AND cancelled_at >= $1 AND cancelled_at < $2 GROUP BY status`, p),
    query(`SELECT category, count(*)::int AS count, coalesce(sum(amount), 0) AS total
           FROM expenses WHERE status = 'validee' AND expense_date >= $1::date AND expense_date < $2::date GROUP BY category ORDER BY total DESC`, p),
    query(`SELECT a.name, sum(ca.quantity)::int AS count, sum(ca.quantity * ca.unit_price) AS total
           FROM consultation_acts ca JOIN medical_acts a ON a.id = ca.act_id JOIN consultations c ON c.id = ca.consultation_id
           WHERE c.status <> 'annulee' AND ca.performed_at >= $1 AND ca.performed_at < $2 GROUP BY a.name ORDER BY total DESC`, p),
    query(`SELECT t.name, count(*)::int AS count, sum(i.price) AS total
           FROM lab_request_items i JOIN lab_exam_types t ON t.id = i.exam_type_id JOIN lab_requests r ON r.id = i.request_id
           WHERE r.status <> 'annulee' AND r.created_at >= $1 AND r.created_at < $2 GROUP BY t.name ORDER BY count DESC`, p),
    query(`SELECT pr.name, sum(i.quantity)::int AS quantity, sum(i.quantity * i.unit_price) AS total
           FROM pharmacy_sale_items i JOIN pharmacy_sales s ON s.id = i.sale_id JOIN products pr ON pr.id = i.product_id
           WHERE s.status = 'valide' AND s.created_at >= $1 AND s.created_at < $2 GROUP BY pr.name ORDER BY total DESC LIMIT 15`, p),
    query(`SELECT coalesce(sum(i.quantity * pr.purchase_price), 0) AS cost, coalesce(sum(i.quantity * i.unit_price), 0) AS sales
           FROM pharmacy_sale_items i JOIN pharmacy_sales s ON s.id = i.sale_id JOIN products pr ON pr.id = i.product_id
           WHERE s.status = 'valide' AND s.created_at >= $1 AND s.created_at < $2`, p),
    query(`SELECT s.id, s.number, s.opened_at, s.closed_at, s.opening_balance, s.expected_balance, s.declared_balance, s.discrepancy, s.justification,
             u.first_name || ' ' || u.last_name AS closed_by_name
           FROM cash_sessions s LEFT JOIN users u ON u.id = s.closed_by
           WHERE s.status = 'cloturee' AND s.closed_at >= $1 AND s.closed_at < $2 ORDER BY s.closed_at`, p),
    query(DAILY_SERIES_SQL, p),
    query(`SELECT coalesce(u.first_name || ' ' || u.last_name, 'Non assigné') AS doctor, count(*)::int AS count, coalesce(sum(c.amount), 0) AS total
           FROM consultations c LEFT JOIN users u ON u.id = c.doctor_id
           WHERE c.status <> 'annulee' AND c.consulted_at >= $1 AND c.consulted_at < $2 GROUP BY 1 ORDER BY count DESC`, p),
    query(`SELECT status, count(*)::int AS count FROM consultations WHERE consulted_at >= $1 AND consulted_at < $2 GROUP BY status`, p),
  ]);
  const evolution = {};
  for (const k of Object.keys(current)) {
    evolution[k] = previous[k] ? Math.round(((current[k] - previous[k]) / previous[k]) * 1000) / 10 : null;
  }
  const s = sessions.rows;
  res.json({
    period: { from, to },
    totals: { ...current, net: current.revenue - current.expenses },
    previous, evolution,
    revenue_by_source: bySource.rows,
    revenue_by_method: byMethod.rows,
    reversals: reversals.rows,
    expenses_by_category: expByCat.rows,
    acts: acts.rows,
    exams: exams.rows,
    pharmacy: { top_products: topProducts.rows, ...cogs.rows[0], margin: cogs.rows[0].sales - cogs.rows[0].cost },
    cash: {
      sessions: s,
      total_discrepancy: s.reduce((a, x) => a + (x.discrepancy || 0), 0),
      sessions_with_discrepancy: s.filter((x) => x.discrepancy).length,
    },
    consultations_by_doctor: doctors.rows,
    consultations_by_status: consultStatus.rows,
    series: series.rows,
  });
}));

router.get('/employee/:id', requirePerm('reports.employee'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const { from, to } = range(req);
  const { rows: [u] } = await query(
    `SELECT u.id, u.employee_number, u.first_name, u.last_name, u.job_title, u.status, r.name AS role_name
     FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`, [id]);
  if (!u) throw notFound('Employé introuvable');
  const p = [id, from, to];
  const [logins, payments, reversals, consultations, closings, stock, actions, recent] = await Promise.all([
    query(`SELECT event, count(*)::int AS count, max(created_at) AS last FROM login_events
           WHERE user_id = $1 AND created_at >= $2 AND created_at < $3 GROUP BY event`, p),
    query(`SELECT count(*)::int AS count, coalesce(sum(amount), 0) AS total, coalesce(sum(discount), 0) AS discounts,
             count(*) FILTER (WHERE discount > 0)::int AS with_discount
           FROM payments WHERE received_by = $1 AND status = 'valide' AND created_at >= $2 AND created_at < $3`, p),
    query(`SELECT status, count(*)::int AS count, coalesce(sum(amount), 0) AS total FROM payments
           WHERE cancelled_by = $1 AND cancelled_at >= $2 AND cancelled_at < $3 GROUP BY status`, p),
    query(`SELECT count(*)::int AS count FROM consultations
           WHERE (doctor_id = $1 OR created_by = $1) AND consulted_at >= $2 AND consulted_at < $3 AND status <> 'annulee'`, p),
    query(`SELECT id, number, closed_at, expected_balance, declared_balance, discrepancy, justification FROM cash_sessions
           WHERE closed_by = $1 AND closed_at >= $2 AND closed_at < $3 ORDER BY closed_at DESC`, p),
    query(`SELECT reason, count(*)::int AS count, sum(quantity)::int AS quantity FROM stock_movements
           WHERE created_by = $1 AND created_at >= $2 AND created_at < $3 GROUP BY reason ORDER BY count DESC`, p),
    query(`SELECT action, count(*)::int AS count FROM audit_log
           WHERE user_id = $1 AND created_at >= $2 AND created_at < $3 GROUP BY action ORDER BY count DESC`, p),
    query(`SELECT id, action, summary, reason, created_at FROM audit_log
           WHERE user_id = $1 AND created_at >= $2 AND created_at < $3 ORDER BY id DESC LIMIT 100`, p),
  ]);
  const modifications = actions.rows.filter((a) => /\.(update|price_change|permissions_change|result_correction|acts_remove)$/.test(a.action))
    .reduce((s, a) => s + a.count, 0);
  const cancellations = actions.rows.filter((a) => /\.(cancel|refund|sale_cancel|reject)$/.test(a.action)).reduce((s, a) => s + a.count, 0);
  res.json({
    employee: u, period: { from, to },
    logins: logins.rows, payments: payments.rows[0], reversals: reversals.rows,
    consultations: consultations.rows[0].count, cash_closings: closings.rows, stock_movements: stock.rows,
    actions: actions.rows, modifications, cancellations, recent: recent.rows,
  });
}));

export default router;
