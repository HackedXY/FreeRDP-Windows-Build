import { Router } from 'express';
import { query } from '../db/pool.js';
import { ah } from '../lib/errors.js';
import { requirePerm, can } from '../lib/auth.js';
import { onlineUserIds } from '../lib/presence.js';
import { sessionTotals } from './cash.js';
import { DAILY_SERIES_SQL } from '../lib/helpers.js';

/** Date locale (AAAA-MM-JJ) décalée de n jours. */
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

const router = Router();

/**
 * Tableau de bord scindé :
 *  - dashboard.view    : volet médical / opérationnel (patients, consultations, examens, rendez-vous, stock) ;
 *  - dashboard.finance : recettes, dépenses, caisse, ventes, encaissements, fil d'activité (propriétaire).
 */
router.get('/', requirePerm('dashboard.view', 'dashboard.finance'), ah(async (req, res) => {
  const today = `created_at >= CURRENT_DATE AND created_at < CURRENT_DATE + 1`;
  const [k, byMethod, openSessions, lastClosed, series, activity, users, alerts, pending, consultStatus] = await Promise.all([
    query(`SELECT
      (SELECT count(DISTINCT pid)::int FROM (
         SELECT patient_id AS pid FROM consultations WHERE consulted_at >= CURRENT_DATE AND consulted_at < CURRENT_DATE + 1 AND status <> 'annulee'
         UNION SELECT patient_id FROM lab_requests WHERE ${today} AND status <> 'annulee'
         UNION SELECT patient_id FROM pharmacy_sales WHERE ${today} AND status = 'valide' AND patient_id IS NOT NULL
         UNION SELECT patient_id FROM payments WHERE ${today} AND patient_id IS NOT NULL
         UNION SELECT id FROM patients WHERE ${today}) x) AS patients_today,
      (SELECT count(*)::int FROM patients WHERE ${today}) AS new_patients,
      (SELECT count(*)::int FROM consultations WHERE consulted_at >= CURRENT_DATE AND consulted_at < CURRENT_DATE + 1 AND status <> 'annulee') AS consultations,
      (SELECT coalesce(sum(amount), 0) FROM payments WHERE ${today} AND status = 'valide') AS revenue,
      (SELECT count(*)::int FROM payments WHERE ${today} AND status = 'valide') AS payment_count,
      (SELECT coalesce(sum(amount), 0) FROM payments WHERE cancelled_at >= CURRENT_DATE AND status = 'rembourse') AS refunds,
      (SELECT coalesce(sum(amount), 0) FROM expenses WHERE expense_date = CURRENT_DATE AND status = 'validee') AS expenses,
      (SELECT coalesce(sum(amount), 0) FROM pharmacy_sales WHERE ${today} AND status = 'valide') AS pharmacy_sales,
      (SELECT coalesce(sum(amount), 0) FROM payments WHERE ${today} AND status = 'valide' AND source_type = 'lab_request') AS lab_revenue,
      (SELECT count(*)::int FROM lab_requests WHERE ${today} AND status <> 'annulee') AS lab_requests,
      (SELECT count(*)::int FROM appointments WHERE scheduled_at >= CURRENT_DATE AND scheduled_at < CURRENT_DATE + 1 AND status <> 'annule') AS appointments`),
    query(`SELECT method, coalesce(sum(amount), 0) AS total, count(*)::int AS count FROM payments WHERE ${today} AND status = 'valide' GROUP BY method`),
    query(`SELECT s.id, s.number, s.opened_at, r.name AS register_name, u.first_name || ' ' || u.last_name AS opened_by_name
           FROM cash_sessions s JOIN cash_registers r ON r.id = s.register_id JOIN users u ON u.id = s.opened_by WHERE s.status = 'ouverte'`),
    query(`SELECT number, closed_at, declared_balance, discrepancy FROM cash_sessions WHERE status = 'cloturee' ORDER BY closed_at DESC LIMIT 1`),
    query(DAILY_SERIES_SQL, [daysAgo(6), daysAgo(-1)]),
    query(`SELECT a.id, a.created_at AS at, a.action, a.summary, coalesce(u.first_name || ' ' || u.last_name, a.username, 'Système') AS user, r.name AS role
           FROM audit_log a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN roles r ON r.id = u.role_id
           WHERE a.action NOT IN ('auth.login', 'auth.logout', 'auth.login_failed', 'access.denied', 'auth.password_changed', 'medical.read', 'document.print', 'document.verify')
             AND a.action NOT LIKE 'auth.mfa%'
           ORDER BY a.id DESC LIMIT 20`),
    query(`SELECT count(*) FILTER (WHERE status = 'active')::int AS active, count(*)::int AS total,
             count(*) FILTER (WHERE status = 'active' AND last_login_at >= CURRENT_DATE)::int AS logged_today FROM users`),
    query(`SELECT count(*)::int AS open, count(*) FILTER (WHERE category = 'stock')::int AS stock,
             count(*) FILTER (WHERE category <> 'stock')::int AS to_check, count(*) FILTER (WHERE severity = 'haute')::int AS high
           FROM alerts WHERE status IN ('nouvelle','en_verification')`),
    query(`SELECT
             (SELECT count(*)::int FROM expenses WHERE status = 'en_attente') AS expenses_to_validate,
             (SELECT count(*)::int FROM consultations WHERE status <> 'annulee' AND payment_status <> 'payee' AND amount > 0) AS unpaid_consultations,
             (SELECT count(*)::int FROM lab_requests WHERE status IN ('demandee','en_cours')) AS lab_pending,
             (SELECT count(*)::int FROM products WHERE active AND quantity <= min_threshold) AS low_stock`),
    query(`SELECT status, count(*)::int AS n FROM consultations WHERE consulted_at >= CURRENT_DATE AND consulted_at < CURRENT_DATE + 1 GROUP BY status`),
  ]);
  let cashTheoretical = 0; const sessions = [];
  for (const s of openSessions.rows) {
    const t = await sessionTotals({ query }, s.id);
    cashTheoretical += t.expected_balance;
    sessions.push({ ...s, ...t });
  }
  const k0 = k.rows[0];
  const out = {
    patients_today: k0.patients_today, new_patients: k0.new_patients, consultations: k0.consultations,
    lab_requests: k0.lab_requests, appointments: k0.appointments,
    consultations_by_status: Object.fromEntries(consultStatus.rows.map((r) => [r.status, r.n])),
    pending: { lab_pending: pending.rows[0].lab_pending, low_stock: pending.rows[0].low_stock },
    series: series.rows.map((r) => ({ day: r.day, consultations: r.consultations })),
    finance: false,
    generated_at: new Date(),
  };
  if (can(req.user, 'dashboard.finance')) {
    Object.assign(out, {
      finance: true,
      revenue: k0.revenue, payment_count: k0.payment_count, refunds: k0.refunds, expenses: k0.expenses,
      pharmacy_sales: k0.pharmacy_sales, lab_revenue: k0.lab_revenue,
      revenue_by_method: byMethod.rows,
      cash: { open_sessions: sessions, theoretical: cashTheoretical, last_closed: lastClosed.rows[0] || null },
      series: series.rows,
      activity: activity.rows,
      pending: { ...out.pending, expenses_to_validate: pending.rows[0].expenses_to_validate, unpaid_consultations: pending.rows[0].unpaid_consultations },
    });
  }
  if (can(req.user, 'dashboard.finance') || can(req.user, 'users.view')) out.employees = { ...users.rows[0], online: onlineUserIds().length };
  if (can(req.user, 'alerts.view')) out.alerts = alerts.rows[0];
  res.json(out);
}));

export default router;
