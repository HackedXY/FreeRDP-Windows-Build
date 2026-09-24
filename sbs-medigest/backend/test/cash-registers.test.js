// Remédiation phase 1 : choix explicite de la caisse (plusieurs caisses ouvertes)
// et immuabilité des périodes clôturées (y compris en cas d'opérations concurrentes).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, adminAgent, employee, pool, closePools } from './helpers.js';

let admin, cashier1, cashier2, main, annex;

const sessionOf = async (registerId) => (await pool.query(`SELECT * FROM cash_sessions WHERE register_id = $1 AND status = 'ouverte'`, [registerId])).rows[0];
const movements = async (sessionId) => (await pool.query('SELECT category, direction, amount FROM cash_movements WHERE cash_session_id = $1 ORDER BY id', [sessionId])).rows;
const pay = (agent, body) => agent.post('/api/payments').send({ source_type: 'other', payer_name: 'Client test', description: 'Prestation', amount: 10000, method: 'especes', ...body });

before(async () => {
  await resetDb();
  admin = await adminAgent();
  cashier1 = await employee(admin, 'caissier', 'caisse01');
  cashier2 = await employee(admin, 'caissier', 'caisse02');
  const regs = (await admin.get('/api/cash/registers')).body;
  main = regs[0];
  annex = (await admin.post('/api/settings/registers').send({ name: 'Caisse pharmacie' })).body;
});
after(async () => { await closePools(); });

test('une seule caisse ouverte : sélection automatique (comportement inchangé)', async () => {
  assert.equal((await cashier1.post('/api/cash/open').send({ register_id: main.id, opening_balance: 100000 })).status, 201);
  const r = await pay(cashier1, {});
  assert.equal(r.status, 201);
  const s = await sessionOf(main.id);
  assert.equal(r.body.cash_session_id, s.id);
  const list = (await cashier1.get('/api/cash/open-registers')).body;
  assert.equal(list.length, 1);
  assert.equal(list[0].register_id, main.id);
  assert.equal(list[0].expected_balance, undefined, 'aucun montant dans la liste de sélection');
});

test('plusieurs caisses ouvertes : sans caisse précisée, paiement refusé (plus de choix implicite)', async () => {
  assert.equal((await cashier2.post('/api/cash/open').send({ register_id: annex.id, opening_balance: 50000 })).status, 201);
  const r = await pay(cashier1, {});
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'REGISTER_REQUIRED');
  // hors espèces, le paiement reste possible mais n'est rattaché à aucune caisse devinée
  const om = await pay(cashier1, { method: 'orange_money', reference: 'OM-1' });
  assert.equal(om.status, 201);
  assert.equal(om.body.cash_session_id, null);
});

test('paiement en espèces : la caisse choisie reçoit le mouvement', async () => {
  const sAnnex = await sessionOf(annex.id);
  const sMain = await sessionOf(main.id);
  const before = (await movements(sMain.id)).length;
  const r = await pay(cashier1, { register_id: annex.id, amount: 25000 });
  assert.equal(r.status, 201);
  assert.equal(r.body.cash_session_id, sAnnex.id);
  assert.deepEqual(await movements(sAnnex.id), [{ category: 'paiement', direction: 'in', amount: 25000 }]);
  assert.equal((await movements(sMain.id)).length, before, 'la caisse principale n\'est pas touchée');
  // paiement mobile rattaché à la caisse choisie
  const om = await pay(cashier1, { method: 'mtn_money', reference: 'MTN-1', register_id: annex.id });
  assert.equal(om.body.cash_session_id, sAnnex.id);
  // caisse choisie fermée : refus explicite
  const regs = (await admin.get('/api/settings')).body.registers;
  const closed = regs.find((x) => x.id !== main.id && x.id !== annex.id);
  if (closed) assert.equal((await pay(cashier1, { register_id: closed.id })).status, 400);
});

test('remboursement en espèces : caisse obligatoire si plusieurs ouvertes, puis sortie dans la caisse choisie', async () => {
  const p = (await pay(cashier1, { register_id: main.id, amount: 8000 })).body;
  let r = await admin.post(`/api/payments/${p.id}/refund`).send({ reason: 'Erreur de facturation' });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'REGISTER_REQUIRED');
  r = await admin.post(`/api/payments/${p.id}/refund`).send({ reason: 'Erreur de facturation', register_id: annex.id });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'rembourse');
  const sAnnex = await sessionOf(annex.id);
  assert.ok((await movements(sAnnex.id)).some((m) => m.category === 'remboursement' && m.amount === 8000));
});

test('dépenses : décaissement dans la caisse choisie (création et décaissement différé)', async () => {
  let r = await cashier1.post('/api/expenses').send({ category: 'Carburant', amount: 5000, reason: 'Groupe', pay_from_cash: true });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'REGISTER_REQUIRED');
  r = await cashier1.post('/api/expenses').send({ category: 'Carburant', amount: 5000, reason: 'Groupe', pay_from_cash: true, register_id: main.id });
  assert.equal(r.status, 201);
  assert.equal(r.body.cash_session_id, (await sessionOf(main.id)).id);
  const e = (await cashier1.post('/api/expenses').send({ category: 'Eau', amount: 3000, reason: 'Bidons' })).body;
  assert.equal((await cashier1.post(`/api/expenses/${e.id}/disburse`).send({})).body.code, 'REGISTER_REQUIRED');
  r = await cashier1.post(`/api/expenses/${e.id}/disburse`).send({ register_id: annex.id });
  assert.equal(r.status, 200);
  assert.equal(r.body.cash_session_id, (await sessionOf(annex.id)).id);
});

test('vente pharmacie encaissée : caisse choisie transmise au paiement', async () => {
  const pharma = await employee(admin, 'pharmacien', 'pharmaCaisse');
  const prod = (await pharma.post('/api/pharmacy/products').send({ reference: 'PARA1', name: 'Paracétamol', category: 'medicament', purchase_price: 100, sale_price: 500, min_threshold: 0, initial_quantity: 20 })).body;
  const r = await admin.post('/api/pharmacy/sales').send({ customer_name: 'Client', items: [{ product_id: prod.id, quantity: 2 }], payment: { method: 'especes', register_id: annex.id } });
  assert.equal(r.status, 201);
  assert.equal(r.body.payment.cash_session_id, (await sessionOf(annex.id)).id);
});

test('clôture : sans session précisée et plusieurs caisses ouvertes, refus (plus de clôture de la mauvaise caisse)', async () => {
  const r = await cashier1.post('/api/cash/close').send({ declared_balance: 0, justification: 'test test' });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'REGISTER_REQUIRED');
});

// ------------------------------------------------------------------ périodes clôturées
let closedPayment, closedMobile, closedSession;

test('période clôturée : paiements d\'une caisse clôturée non modifiables ni annulables (tous modes), remboursement possible', async () => {
  closedPayment = (await pay(cashier1, { register_id: main.id, amount: 12000 })).body;
  closedMobile = (await pay(cashier1, { register_id: main.id, method: 'orange_money', reference: 'OM-CLOS', amount: 7000 })).body;
  closedSession = await sessionOf(main.id);
  const t = (await cashier1.get(`/api/cash/sessions/${closedSession.id}`)).body;
  const c = await cashier1.post('/api/cash/close').send({ session_id: closedSession.id, declared_balance: t.expected_balance, carry_over: 0, withdrawal_note: 'Remis au coffre' });
  assert.equal(c.status, 200);

  for (const p of [closedPayment, closedMobile]) {
    const cancel = await admin.post(`/api/payments/${p.id}/cancel`).send({ reason: 'Après clôture' });
    assert.equal(cancel.status, 400, `annulation ${p.method}`);
    const upd = await admin.put(`/api/payments/${p.id}`).send({ amount: 1, reason: 'Après clôture' });
    assert.equal(upd.status, 400, `modification ${p.method}`);
  }
  // méthode modifiée hors espèces → espèces : refusé aussi (caisse clôturée)
  assert.equal((await admin.put(`/api/payments/${closedMobile.id}`).send({ method: 'especes', reason: 'Correction' })).status, 400);
  const still = (await admin.get(`/api/payments/${closedMobile.id}`)).body;
  assert.equal(still.status, 'valide');
  assert.equal(still.amount, 7000);
  // le remboursement passe par la caisse ouverte (seule restante → choix automatique)
  const refund = await admin.post(`/api/payments/${closedPayment.id}/refund`).send({ reason: 'Remboursement après clôture' });
  assert.equal(refund.status, 200);
  const sAnnex = await sessionOf(annex.id);
  assert.ok((await movements(sAnnex.id)).some((m) => m.category === 'remboursement' && m.amount === 12000));
  // totaux de la session clôturée inchangés
  const after = (await cashier1.get(`/api/cash/sessions/${closedSession.id}`)).body;
  assert.equal(after.expected_balance, t.expected_balance);
});

test('période clôturée : la base refuse aussi toute écriture directe (défense en profondeur)', async () => {
  const uid = cashier1.user.id;
  await assert.rejects(pool.query(
    `INSERT INTO cash_movements (cash_session_id, direction, category, amount, created_by) VALUES ($1,'in','correction',1,$2)`, [closedSession.id, uid]), /clôturée/);
  await assert.rejects(pool.query('UPDATE cash_sessions SET declared_balance = 0 WHERE id = $1', [closedSession.id]), /clôturée/);
  await assert.rejects(pool.query(`UPDATE payments SET status = 'annule' WHERE id = $1`, [closedMobile.id]), /clôturée/);
  await assert.rejects(pool.query('UPDATE payments SET amount = 1 WHERE id = $1', [closedMobile.id]), /clôturée/);
  await assert.rejects(pool.query('UPDATE cash_movements SET amount = 1 WHERE cash_session_id = $1', [closedSession.id]), /immuable/);
  const e = (await pool.query('SELECT id FROM expenses WHERE disbursed LIMIT 1')).rows[0];
  await assert.rejects(pool.query('UPDATE expenses SET amount = 1 WHERE id = $1', [e.id]), /décaissée/);
  await assert.rejects(pool.query(`UPDATE expenses SET status = 'annulee' WHERE id = $1`, [e.id]), /décaissée/);
});

test('concurrence : annulation et clôture simultanées — jamais de mouvement dans une caisse clôturée', async () => {
  for (let i = 0; i < 6; i++) {
    const open = await cashier1.post('/api/cash/open').send({ register_id: main.id, opening_balance: 0 });
    assert.equal(open.status, 201);
    const sid = open.body.id;
    const p = (await pay(cashier1, { register_id: main.id, amount: 1000 + i })).body;
    const mobile = (await pay(cashier1, { register_id: main.id, method: 'orange_money', reference: `OM-C${i}`, amount: 500 })).body;
    const [cancel, cancelMobile, close] = await Promise.all([
      admin.post(`/api/payments/${p.id}/cancel`).send({ reason: 'Concurrence' }),
      admin.post(`/api/payments/${mobile.id}/cancel`).send({ reason: 'Concurrence' }),
      cashier1.post('/api/cash/close').send({ session_id: sid, declared_balance: 1000 + i, justification: 'Contrôle concurrent', carry_over: 0, withdrawal_note: 'Remis au coffre' }),
    ]);
    assert.equal(close.status, 200);
    assert.ok([200, 400].includes(cancel.status), `annulation : ${cancel.status}`);
    assert.ok([200, 400].includes(cancelMobile.status), `annulation mobile : ${cancelMobile.status}`);
    // invariant : le solde théorique figé à la clôture = solde recalculé depuis les mouvements
    const { rows: [s] } = await pool.query('SELECT * FROM cash_sessions WHERE id = $1', [sid]);
    const { rows: [m] } = await pool.query(
      `SELECT coalesce(sum(CASE WHEN direction = 'in' THEN amount ELSE -amount END), 0)::bigint AS net FROM cash_movements WHERE cash_session_id = $1`, [sid]);
    assert.equal(s.expected_balance, s.opening_balance + Number(m.net), `itération ${i}`);
    // une annulation acceptée est comptée dans la clôture (mouvement présent) ; refusée, le paiement reste valide
    const { rows: [pp] } = await pool.query('SELECT status FROM payments WHERE id = $1', [p.id]);
    const { rows: [mv] } = await pool.query(`SELECT count(*)::int AS n FROM cash_movements WHERE cash_session_id = $1 AND category = 'annulation' AND ref_id = $2`, [sid, p.id]);
    assert.equal(pp.status === 'annule' ? 1 : 0, mv.n, `itération ${i}`);
    assert.equal(pp.status, cancel.status === 200 ? 'annule' : 'valide');
    const { rows: [pm] } = await pool.query('SELECT status FROM payments WHERE id = $1', [mobile.id]);
    assert.equal(pm.status, cancelMobile.status === 200 ? 'annule' : 'valide');
  }
});

test('concurrence : encaissements pendant la clôture — comptés dans la clôture ou refusés', async () => {
  const open = await cashier1.post('/api/cash/open').send({ register_id: main.id, opening_balance: 0 });
  const sid = open.body.id;
  const results = await Promise.all([
    ...[1, 2, 3].map((k) => pay(cashier1, { register_id: main.id, amount: 100 * k })),
    cashier1.post('/api/cash/close').send({ session_id: sid, declared_balance: 0, justification: 'Contrôle concurrent' }),
  ]);
  const close = results[3];
  assert.equal(close.status, 200);
  for (const r of results.slice(0, 3)) assert.ok([201, 400, 409].includes(r.status), String(r.status));
  const { rows: [s] } = await pool.query('SELECT * FROM cash_sessions WHERE id = $1', [sid]);
  const { rows: [m] } = await pool.query(`SELECT coalesce(sum(amount), 0)::bigint AS n FROM cash_movements WHERE cash_session_id = $1`, [sid]);
  assert.equal(s.expected_balance, Number(m.n));
});
