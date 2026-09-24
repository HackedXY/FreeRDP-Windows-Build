// Phase 4 : solde de caisse jamais négatif, contrôle des dépenses en espèces,
// report explicite de l'argent d'une session à la suivante.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, adminAgent, employee, pool, closePools } from './helpers.js';
import { invalidateSettings } from '../src/lib/settings.js';

let admin, cashier, reg;
const session = async () => (await pool.query(`SELECT * FROM cash_sessions WHERE register_id = $1 AND status = 'ouverte'`, [reg.id])).rows[0];
const balance = async (id) => (await admin.get(`/api/cash/sessions/${id}`)).body.expected_balance;

before(async () => {
  await resetDb();
  admin = await adminAgent();
  cashier = await employee(admin, 'caissier', 'caisseCtl');
  reg = (await admin.get('/api/cash/registers')).body[0];
  assert.equal((await cashier.post('/api/cash/open').send({ register_id: reg.id, opening_balance: 20000 })).status, 201);
});
after(async () => { await closePools(); });

test('solde négatif impossible : dépense en espèces supérieure au contenu de la caisse refusée', async () => {
  const r = await cashier.post('/api/expenses').send({ category: 'Carburant', amount: 25000, reason: 'Groupe électrogène', pay_from_cash: true });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'INSUFFICIENT_CASH');
  assert.match(r.body.error, /20 000 GNF disponibles/);
  const s = await session();
  assert.equal(await balance(s.id), 20000, 'aucun mouvement enregistré');
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM expenses`)).rows[0].n, 0, 'dépense annulée avec la transaction');
});

test('solde négatif impossible : remboursement en espèces sans fonds suffisants refusé', async () => {
  // encaissement de 30 000, puis dépense de 45 000 : il ne reste que 5 000 pour rembourser 30 000
  const p = (await cashier.post('/api/payments').send({ source_type: 'other', payer_name: 'Client', description: 'Soin', amount: 30000, method: 'especes' })).body;
  const e = (await cashier.post('/api/expenses').send({ category: 'Eau', amount: 45000, reason: 'Bidons', pay_from_cash: true })).body;
  assert.equal(e.disbursed, true, 'solde 50 000 → 5 000');
  const r = await admin.post(`/api/payments/${p.id}/refund`).send({ reason: 'Erreur de facturation' });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'INSUFFICIENT_CASH');
  assert.equal((await admin.get(`/api/payments/${p.id}`)).body.status, 'valide');
});

test('solde négatif impossible : garanti aussi par la base (écriture directe du rôle applicatif)', async () => {
  const s = await session();
  await assert.rejects(pool.query(
    `INSERT INTO cash_movements (cash_session_id, direction, category, amount, created_by) VALUES ($1, 'out', 'correction', 999999, $2)`,
    [s.id, cashier.user.id]), /Solde de caisse insuffisant/);
});

test('sorties concurrentes : jamais de solde négatif', async () => {
  const s = await session();
  const before = await balance(s.id); // 5 000
  const results = await Promise.all([1, 2, 3, 4].map((i) => cashier.post('/api/expenses').send({ category: 'Fournitures', amount: 2000, reason: `Achat ${i}`, pay_from_cash: true })));
  const ok = results.filter((r) => r.status === 201).length;
  assert.equal(ok, 2, '2 × 2 000 possibles sur 5 000');
  assert.equal(await balance(s.id), before - ok * 2000);
  assert.ok((await balance(s.id)) >= 0);
});

test('dépenses en espèces : plafond journalier — refus pour le caissier, dépassement tracé pour le responsable', async () => {
  await pool.query(`INSERT INTO settings (key, value) VALUES ('finance', '{"cash_expense_daily_limit": 60000}')
                    ON CONFLICT (key) DO UPDATE SET value = settings.value || EXCLUDED.value`);
  invalidateSettings();
  await cashier.post('/api/payments').send({ source_type: 'other', payer_name: 'Client', description: 'Soin', amount: 100000, method: 'especes' });
  // déjà 49 000 GNF de dépenses en espèces aujourd'hui (45 000 + 2 × 2 000)
  const r = await cashier.post('/api/expenses').send({ category: 'Entretien', amount: 15000, reason: 'Réparation porte', pay_from_cash: true });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'CASH_EXPENSE_LIMIT');
  const e = (await cashier.post('/api/expenses').send({ category: 'Entretien', amount: 15000, reason: 'Réparation porte' })).body;
  assert.equal(e.disbursed, false);
  assert.equal((await cashier.post(`/api/expenses/${e.id}/disburse`).send({})).body.code, 'CASH_EXPENSE_LIMIT');
  const d = await admin.post(`/api/expenses/${e.id}/disburse`).send({});
  assert.equal(d.status, 200, 'le responsable (expenses.validate) peut dépasser');
  const alerts = (await admin.get('/api/alerts?type=plafond_depenses_especes')).body.items;
  assert.equal(alerts.length, 1);
  // une dépense sous le plafond restant passe normalement le lendemain (ici : plafond relevé)
  await pool.query(`UPDATE settings SET value = value || '{"cash_expense_daily_limit": 10000000}' WHERE key = 'finance'`);
  invalidateSettings();
  assert.equal((await cashier.post('/api/expenses').send({ category: 'Eau', amount: 1000, reason: 'Eau', pay_from_cash: true })).status, 201);
});

let closed;
test('report : clôture avec montant laissé en caisse et retrait tracé (destination obligatoire)', async () => {
  const s = await session();
  const expected = await balance(s.id);
  let r = await cashier.post('/api/cash/close').send({ session_id: s.id, declared_balance: expected, carry_over: 20000 });
  assert.equal(r.status, 400, 'destination du retrait obligatoire');
  r = await cashier.post('/api/cash/close').send({ session_id: s.id, declared_balance: expected, carry_over: expected + 1, withdrawal_note: 'Coffre' });
  assert.equal(r.status, 400, 'report > solde déclaré');
  r = await cashier.post('/api/cash/close').send({ session_id: s.id, declared_balance: expected, carry_over: 20000, withdrawal_note: 'Dépôt au coffre du cabinet' });
  assert.equal(r.status, 200);
  closed = r.body;
  assert.deepEqual([closed.carry_over, closed.withdrawn, closed.withdrawal_note], [20000, expected - 20000, 'Dépôt au coffre du cabinet']);
  const { rows: [a] } = await pool.query(`SELECT new_value FROM audit_log WHERE action = 'cash.close' ORDER BY id DESC LIMIT 1`);
  assert.equal(a.new_value.carry_over, 20000);
  assert.equal(a.new_value.withdrawn, expected - 20000);
  await assert.rejects(pool.query('UPDATE cash_sessions SET carry_over = 0 WHERE id = $1', [closed.id]), /clôturée/);
});

test('report : ouverture suivante contrôlée (report exact accepté, écart justifié + alerte)', async () => {
  const regs = (await cashier.get('/api/cash/registers')).body;
  assert.equal(regs.find((x) => x.id === reg.id).expected_opening, 20000, 'report attendu affiché au caissier');
  let r = await cashier.post('/api/cash/open').send({ register_id: reg.id, opening_balance: 15000 });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'OPENING_MISMATCH');
  r = await cashier.post('/api/cash/open').send({ register_id: reg.id, opening_balance: 20000 });
  assert.equal(r.status, 201);
  assert.deepEqual([r.body.carried_from_session_id, r.body.expected_opening, r.body.opening_justification], [closed.id, 20000, null]);
  // session suivante : clôture sans retrait (tout reporté), puis ouverture avec écart justifié
  const s2 = r.body;
  await cashier.post('/api/cash/close').send({ session_id: s2.id, declared_balance: 20000 });
  r = await cashier.post('/api/cash/open').send({ register_id: reg.id, opening_balance: 18000, justification: 'Billet déchiré retiré' });
  assert.equal(r.status, 201);
  assert.equal(r.body.opening_justification, 'Billet déchiré retiré');
  const alerts = (await admin.get('/api/alerts?type=ecart_report_caisse')).body.items;
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].severity, 'haute');
  // le montant de report n'est pas exposé aux rôles sans accès caisse
  const nurse = await employee(admin, 'infirmier', 'infCaisse');
  assert.equal((await nurse.get('/api/cash/registers')).body[0].expected_opening, undefined);
});
