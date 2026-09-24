import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../db/pool.js';
import { ah, parse, notFound, badRequest, conflict } from '../lib/errors.js';
import { requirePerm, can } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { notify, raiseAlert } from '../lib/notify.js';
import { nextNumber } from '../lib/numbering.js';
import { getSettings } from '../lib/settings.js';
import { fmtGNF, paging, addPeriod } from '../lib/helpers.js';

const router = Router();

export async function sessionTotals(db, sessionId) {
  const { rows: [t] } = await db.query(
    `SELECT s.opening_balance,
       coalesce(sum(m.amount) FILTER (WHERE m.direction = 'in'), 0) AS total_in,
       coalesce(sum(m.amount) FILTER (WHERE m.direction = 'out'), 0) AS total_out,
       coalesce(sum(m.amount) FILTER (WHERE m.category = 'paiement'), 0) AS payments_in,
       coalesce(sum(m.amount) FILTER (WHERE m.category = 'depense'), 0) AS expenses_out,
       coalesce(sum(m.amount) FILTER (WHERE m.category = 'remboursement'), 0) AS refunds_out,
       coalesce(sum(m.amount) FILTER (WHERE m.category = 'annulation'), 0) AS cancellations_out,
       coalesce(sum(CASE WHEN m.category = 'correction' THEN CASE WHEN m.direction = 'in' THEN m.amount ELSE -m.amount END END), 0) AS corrections
     FROM cash_sessions s LEFT JOIN cash_movements m ON m.cash_session_id = s.id
     WHERE s.id = $1 GROUP BY s.id`, [sessionId]);
  return { ...t, expected_balance: t.opening_balance + t.total_in - t.total_out };
}

/**
 * Session ouverte à utiliser pour un mouvement d'espèces (lève une erreur sinon).
 * Sans caisse précisée, la session n'est choisie automatiquement que si UNE seule
 * caisse est ouverte : avec plusieurs caisses ouvertes, le choix doit être explicite.
 */
export async function requireOpenSession(db, registerId = null) {
  const { rows: open } = await db.query(
    `SELECT id FROM cash_sessions WHERE status = 'ouverte' AND ($1::int IS NULL OR register_id = $1) ORDER BY id`, [registerId]);
  if (!open.length) {
    throw badRequest(registerId ? 'Cette caisse n\'est pas ouverte.' : 'Aucune caisse ouverte : ouvrez la caisse avant toute opération en espèces.');
  }
  if (open.length > 1) throw registerRequired();
  // verrou : une clôture concurrente attend la fin de l'opération (ou l'inverse)
  const { rows: [s] } = await db.query(`SELECT * FROM cash_sessions WHERE id = $1 AND status = 'ouverte' FOR UPDATE`, [open[0].id]);
  if (!s) throw conflict('La caisse vient d\'être clôturée : réessayez.');
  return s;
}

/**
 * Session de rattachement d'un encaissement hors espèces (suivi par caisse) :
 * la caisse choisie, sinon l'unique caisse ouverte, sinon aucune.
 */
export async function sessionForNonCash(db, registerId = null) {
  if (registerId) {
    const { rows: [s] } = await db.query(
      `SELECT * FROM cash_sessions WHERE register_id = $1 AND status = 'ouverte' FOR SHARE`, [registerId]);
    if (!s) throw badRequest('Cette caisse n\'est pas ouverte.');
    return s;
  }
  const { rows } = await db.query(`SELECT id FROM cash_sessions WHERE status = 'ouverte' ORDER BY id`);
  if (rows.length !== 1) return null;
  const { rows: [s] } = await db.query(`SELECT * FROM cash_sessions WHERE id = $1 AND status = 'ouverte' FOR SHARE`, [rows[0].id]);
  return s || null;
}

/** Verrouille la session d'un élément existant et indique si elle est encore ouverte. */
export async function lockSessionState(db, sessionId) {
  if (!sessionId) return null;
  const { rows: [s] } = await db.query('SELECT id, status FROM cash_sessions WHERE id = $1 FOR UPDATE', [sessionId]);
  return s?.status || null;
}

function registerRequired() {
  const e = badRequest('Plusieurs caisses sont ouvertes : choisissez la caisse concernée.');
  e.code = 'REGISTER_REQUIRED';
  return e;
}

export async function cashMovement(db, req, { sessionId, direction, category, amount, refType, refId, note }) {
  if (!amount) return;
  // Solde jamais négatif (également garanti par la base) : message explicite pour l'utilisateur
  if (direction === 'out') {
    const t = await sessionTotals(db, sessionId);
    if (t.expected_balance - amount < 0) {
      const e = badRequest(`Solde de caisse insuffisant : ${fmtGNF(t.expected_balance)} disponibles pour une sortie de ${fmtGNF(amount)}.`);
      e.code = 'INSUFFICIENT_CASH';
      throw e;
    }
  }
  await db.query(
    `INSERT INTO cash_movements (cash_session_id, direction, category, amount, ref_type, ref_id, note, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [sessionId, direction, category, amount, refType, refId, note || null, req.user.id]);
}

router.get('/registers', ah(async (req, res) => {
  const { rows } = await query(
    `SELECT r.*, (SELECT s.carry_over FROM cash_sessions s WHERE s.register_id = r.id AND s.status = 'cloturee'
                  ORDER BY s.closed_at DESC LIMIT 1) AS expected_opening
     FROM cash_registers r WHERE r.active ORDER BY r.id`);
  // le montant reporté est une donnée financière : réservé aux opérateurs de caisse
  const money = can(req.user, 'cash.operate') || can(req.user, 'cash.view_all');
  res.json(rows.map(({ expected_opening, ...r }) => (money ? { ...r, expected_opening } : r)));
}));

// Caisses ouvertes (sans montants) : sélection de la caisse lors d'un encaissement, d'une dépense ou d'un remboursement
router.get('/open-registers', requirePerm('cash.operate', 'payments.create', 'payments.update', 'payments.refund', 'expenses.create', 'expenses.disburse', 'pharmacy.sell'), ah(async (_req, res) => {
  const { rows } = await query(
    `SELECT s.id AS session_id, s.number, s.register_id, r.name AS register_name, s.opened_at,
       u.first_name || ' ' || u.last_name AS opened_by_name
     FROM cash_sessions s JOIN cash_registers r ON r.id = s.register_id JOIN users u ON u.id = s.opened_by
     WHERE s.status = 'ouverte' ORDER BY r.name, s.id`);
  res.json(rows);
}));

router.get('/current', requirePerm('cash.operate', 'cash.view_all', 'payments.create', 'dashboard.finance'), ah(async (req, res) => {
  const { rows } = await query(
    `SELECT s.*, r.name AS register_name, u.first_name || ' ' || u.last_name AS opened_by_name
     FROM cash_sessions s JOIN cash_registers r ON r.id = s.register_id JOIN users u ON u.id = s.opened_by
     WHERE s.status = 'ouverte' ORDER BY s.id`);
  const sessions = [];
  for (const s of rows) sessions.push({ ...s, ...(await sessionTotals({ query }, s.id)) });
  res.json(sessions);
}));

router.post('/open', requirePerm('cash.operate'), ah(async (req, res) => {
  const d = parse(z.object({
    register_id: z.coerce.number().int().positive().optional(),
    opening_balance: z.coerce.number().int().min(0),
    justification: z.string().trim().max(2000).optional().nullable(),
  }), req.body);
  const session = await tx(async (db) => {
    const { rows: [reg] } = await db.query(
      'SELECT * FROM cash_registers WHERE active AND ($1::int IS NULL OR id = $1) ORDER BY id LIMIT 1', [d.register_id ?? null]);
    if (!reg) throw badRequest('Caisse introuvable');
    const { rows: open } = await db.query(`SELECT id FROM cash_sessions WHERE register_id = $1 AND status = 'ouverte'`, [reg.id]);
    if (open.length) throw conflict('Cette caisse est déjà ouverte.');
    // Report : le solde d'ouverture doit correspondre à l'argent laissé dans la caisse à la dernière clôture
    const { rows: [last] } = await db.query(
      `SELECT id, number, declared_balance, carry_over FROM cash_sessions WHERE register_id = $1 AND status = 'cloturee'
       ORDER BY closed_at DESC LIMIT 1`, [reg.id]);
    const expected = last ? (last.carry_over ?? null) : null;
    const gap = expected === null ? 0 : d.opening_balance - expected;
    if (gap !== 0 && (!d.justification || d.justification.length < 5)) {
      const e = badRequest(`Le solde d'ouverture (${fmtGNF(d.opening_balance)}) diffère du report de la clôture ${last.number} (${fmtGNF(expected)}) : une justification est obligatoire.`);
      e.code = 'OPENING_MISMATCH';
      throw e;
    }
    const number = await nextNumber(db, 'cash_session', 'CAI');
    const { rows: [s] } = await db.query(
      `INSERT INTO cash_sessions (register_id, number, opening_balance, opened_by, carried_from_session_id, expected_opening, opening_justification)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [reg.id, number, d.opening_balance, req.user.id, last?.id ?? null, expected, gap ? d.justification : null]);
    await audit(db, req.ctx, {
      action: 'cash.open', entityType: 'cash_session', entityId: s.id,
      summary: `Ouverture de caisse ${number} — solde initial ${fmtGNF(d.opening_balance)}${expected !== null ? ` (report attendu ${fmtGNF(expected)} de ${last.number})` : ''}`,
      newValue: { opening_balance: d.opening_balance, expected_opening: expected, carried_from: last?.number ?? null, gap },
      reason: gap ? d.justification : null,
      feed: { kind: 'cash' },
    });
    if (gap !== 0) {
      await raiseAlert(db, req.ctx, {
        category: 'financiere', type: 'ecart_report_caisse', severity: 'haute',
        title: `Écart de report de caisse : ${fmtGNF(gap)} (${number})`,
        details: { message: `Report attendu ${fmtGNF(expected)} (clôture ${last.number}), ouverture ${fmtGNF(d.opening_balance)} — ${req.user.fullName}. Justification : ${d.justification}` },
        refType: 'cash_session', refId: s.id, userId: req.user.id, link: `/caisse/sessions/${s.id}`,
      });
    }
    req.ctx.emit('perm:dashboard.finance', 'stats', { kind: 'cash' });
    return s;
  });
  res.status(201).json(session);
}));

router.post('/close', requirePerm('cash.operate'), ah(async (req, res) => {
  const d = parse(z.object({
    session_id: z.coerce.number().int().positive().optional(),
    declared_balance: z.coerce.number().int().min(0),
    justification: z.string().trim().max(2000).optional().nullable(),
    // argent laissé dans le tiroir pour la session suivante (défaut : tout le solde déclaré)
    carry_over: z.coerce.number().int().min(0).optional().nullable(),
    withdrawal_note: z.string().trim().max(500).optional().nullable(),
  }), req.body);
  const carry = d.carry_over ?? d.declared_balance;
  if (carry > d.declared_balance) throw badRequest('Le montant reporté ne peut dépasser le solde déclaré.');
  const withdrawn = d.declared_balance - carry;
  if (withdrawn > 0 && (!d.withdrawal_note || d.withdrawal_note.length < 3)) {
    throw badRequest(`Retrait de ${fmtGNF(withdrawn)} : indiquez sa destination (coffre, banque, propriétaire…).`);
  }
  const settings = await getSettings();
  const result = await tx(async (db) => {
    let sessionId = d.session_id ?? null;
    if (!sessionId) {
      const { rows: open } = await db.query(`SELECT id FROM cash_sessions WHERE status = 'ouverte' ORDER BY id`);
      if (open.length > 1) throw registerRequired();
      sessionId = open[0]?.id ?? null;
    }
    const { rows: [s] } = await db.query(`SELECT * FROM cash_sessions WHERE status = 'ouverte' AND id = $1 FOR UPDATE`, [sessionId]);
    if (!s) throw badRequest('Aucune caisse ouverte.');
    const totals = await sessionTotals(db, s.id);
    const discrepancy = d.declared_balance - totals.expected_balance;
    if (discrepancy !== 0 && (!d.justification || d.justification.length < 5)) {
      throw badRequest(`Écart de ${fmtGNF(discrepancy)} : une justification est obligatoire.`);
    }
    const { rows: [closed] } = await db.query(
      `UPDATE cash_sessions SET status = 'cloturee', expected_balance = $2, declared_balance = $3, discrepancy = $4,
         justification = $5, closed_by = $6, closed_at = now(), carry_over = $7, withdrawn = $8, withdrawal_note = $9 WHERE id = $1 RETURNING *`,
      [s.id, totals.expected_balance, d.declared_balance, discrepancy, d.justification || null, req.user.id, carry, withdrawn, withdrawn ? d.withdrawal_note : null]);
    await audit(db, req.ctx, {
      action: 'cash.close', entityType: 'cash_session', entityId: s.id,
      summary: `Clôture de caisse ${s.number} — théorique ${fmtGNF(totals.expected_balance)}, déclarée ${fmtGNF(d.declared_balance)}, écart ${fmtGNF(discrepancy)}`,
      newValue: { ...totals, declared_balance: d.declared_balance, discrepancy, carry_over: carry, withdrawn, withdrawal_note: withdrawn ? d.withdrawal_note : null }, reason: d.justification || null,
      feed: { kind: 'cash', amount: discrepancy },
    });
    if (Math.abs(discrepancy) > (settings.finance.cash_tolerance || 0)) {
      await raiseAlert(db, req.ctx, {
        category: 'financiere', type: 'ecart_caisse', severity: 'haute',
        title: `Écart de caisse : ${fmtGNF(discrepancy)} (${s.number})`,
        details: {
          message: `Théorique ${fmtGNF(totals.expected_balance)} / déclarée ${fmtGNF(d.declared_balance)} — ${req.user.fullName}. Justification : ${d.justification}`,
          expected: totals.expected_balance, declared: d.declared_balance, discrepancy,
        },
        refType: 'cash_session', refId: s.id, userId: req.user.id, link: `/caisse/sessions/${s.id}`,
      });
    }
    await notify(db, req.ctx, {
      permission: 'cash.view_all', type: 'cash_closed', icon: discrepancy ? '⚠️' : '🏦',
      title: discrepancy ? 'Écart de caisse détecté' : 'Caisse clôturée',
      body: `${s.number} — déclarée ${fmtGNF(d.declared_balance)}${discrepancy ? `, écart ${fmtGNF(discrepancy)}` : ''}`,
      link: `/caisse/sessions/${s.id}`,
    });
    req.ctx.emit('perm:dashboard.finance', 'stats', { kind: 'cash' });
    return { ...closed, ...totals, expected_balance: totals.expected_balance };
  });
  res.json(result);
}));

router.get('/sessions', requirePerm('cash.operate', 'cash.view_all'), ah(async (req, res) => {
  const { limit, offset } = paging(req);
  const where = []; const vals = [];
  addPeriod(where, vals, 's.opened_at', req.query);
  if (!can(req.user, 'cash.view_all')) { vals.push(req.user.id); where.push(`(s.opened_by = $${vals.length} OR s.closed_by = $${vals.length})`); }
  if (req.query.discrepancy === '1') where.push('s.discrepancy <> 0');
  vals.push(limit, offset);
  const { rows } = await query(
    `SELECT s.*, r.name AS register_name, o.first_name || ' ' || o.last_name AS opened_by_name,
       c.first_name || ' ' || c.last_name AS closed_by_name, count(*) OVER()::int AS total
     FROM cash_sessions s JOIN cash_registers r ON r.id = s.register_id JOIN users o ON o.id = s.opened_by
     LEFT JOIN users c ON c.id = s.closed_by
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY s.opened_at DESC LIMIT $${vals.length - 1} OFFSET $${vals.length}`, vals);
  res.json({ items: rows.map(({ total, ...r }) => r), total: rows[0]?.total || 0 });
}));

router.get('/sessions/:id', requirePerm('cash.operate', 'cash.view_all'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const { rows: [s] } = await query(
    `SELECT s.*, r.name AS register_name, o.first_name || ' ' || o.last_name AS opened_by_name,
       c.first_name || ' ' || c.last_name AS closed_by_name
     FROM cash_sessions s JOIN cash_registers r ON r.id = s.register_id JOIN users o ON o.id = s.opened_by
     LEFT JOIN users c ON c.id = s.closed_by WHERE s.id = $1`, [id]);
  if (!s) throw notFound('Session de caisse introuvable');
  if (!can(req.user, 'cash.view_all') && s.opened_by !== req.user.id && s.closed_by !== req.user.id) throw notFound('Session de caisse introuvable');
  const { rows: movements } = await query(
    `SELECT m.*, u.first_name || ' ' || u.last_name AS user_name,
       CASE WHEN m.ref_type = 'payment' THEN (SELECT number FROM payments WHERE id = m.ref_id)
            WHEN m.ref_type = 'expense' THEN (SELECT number FROM expenses WHERE id = m.ref_id) END AS ref_number
     FROM cash_movements m JOIN users u ON u.id = m.created_by WHERE m.cash_session_id = $1 ORDER BY m.id`, [id]);
  const { rows: byMethod } = await query(
    `SELECT method, count(*)::int AS count, sum(amount) AS total FROM payments
     WHERE cash_session_id = $1 AND status = 'valide' GROUP BY method`, [id]);
  res.json({ ...s, ...(await sessionTotals({ query }, id)), movements, payments_by_method: byMethod });
}));

export default router;
