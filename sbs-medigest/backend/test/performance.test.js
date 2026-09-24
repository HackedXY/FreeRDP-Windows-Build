// Phase 4 : requêtes optimisées — résultats identiques, nombre de requêtes SQL constant (pas de N+1),
// index justifiés présents. Les mesures de temps sont dans docs/PERFORMANCE.md (base volumineuse dédiée).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { resetDb, adminAgent, employee, pool, closePools } from './helpers.js';

let admin, doctor, cashier, patient;
let sqlCount = 0;
const origQuery = pg.Client.prototype.query;
const counting = async (fn) => {
  sqlCount = 0;
  pg.Client.prototype.query = function (...a) { sqlCount++; return origQuery.apply(this, a); };
  try { await fn(); } finally { pg.Client.prototype.query = origQuery; }
  return sqlCount;
};

before(async () => {
  await resetDb();
  admin = await adminAgent();
  doctor = await employee(admin, 'medecin', 'drPerf');
  cashier = await employee(admin, 'caissier', 'caiPerf');
  patient = (await doctor.post('/api/patients').send({ first_name: 'Perf', last_name: 'Patient' })).body;
  await cashier.post('/api/cash/open').send({ opening_balance: 0 });
});
after(async () => { await closePools(); });

const newConsultation = async () => {
  const acts = (await admin.get('/api/acts')).body;
  return (await doctor.post('/api/consultations').send({ patient_id: patient.id, acts: [{ act_id: acts[0].id }] })).body;
};

test('factures : liste en nombre de requêtes constant, totaux identiques à la fiche, filtre de statut', async () => {
  const one = async () => {
    const c = await newConsultation();
    return (await cashier.post('/api/invoices').send({ patient_id: patient.id, items: [{ source_type: 'consultation', source_id: c.id }] })).body;
  };
  const i1 = await one();
  const q1 = await counting(() => cashier.get('/api/invoices'));
  const i2 = await one(); await one(); await one();
  await cashier.post(`/api/invoices/${i2.id}/pay`).send({ method: 'especes' });
  await cashier.post(`/api/invoices/${i1.id}/pay`).send({ method: 'orange_money', reference: 'OM-P', amount: 1000 });
  const q4 = await counting(() => cashier.get('/api/invoices'));
  assert.equal(q4, q1, `requêtes SQL : ${q1} pour 1 facture, ${q4} pour 4`);
  const list = (await cashier.get('/api/invoices')).body;
  assert.equal(list.total, 4);
  for (const row of list.items) {
    const d = (await cashier.get(`/api/invoices/${row.id}`)).body;
    for (const k of ['total', 'discount', 'paid', 'remaining', 'status']) assert.equal(row[k], d[k], `${row.number} ${k}`);
  }
  assert.deepEqual((await cashier.get('/api/invoices?status=payee')).body.items.map((x) => x.id), [i2.id]);
  assert.deepEqual((await cashier.get('/api/invoices?status=partielle')).body.items.map((x) => x.id), [i1.id]);
  assert.equal((await cashier.get('/api/invoices?status=emise')).body.total, 2);
  assert.equal((await cashier.get(`/api/invoices?q=${i2.number}`)).body.items[0].id, i2.id);
});

test('consultations : pagination et total inchangés (avec et sans recherche)', async () => {
  const all = (await doctor.get('/api/consultations?limit=2')).body;
  const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM consultations');
  assert.equal(all.total, n);
  assert.equal(all.items.length, 2);
  const byName = (await doctor.get('/api/consultations?q=perf%20patient')).body;
  assert.equal(byName.total, n);
  assert.equal((await doctor.get('/api/consultations?q=inconnu-xyz')).body.total, 0);
});

test('séries journalières (tableau de bord 7 jours, rapport) : valeurs exactes après réécriture', async () => {
  const p = (await cashier.post('/api/payments').send({ source_type: 'other', payer_name: 'X', description: 'Soin', amount: 7000, method: 'especes' })).body;
  const d = (await admin.get('/api/dashboard')).body;
  assert.equal(d.series.length, 7);
  const today = d.series[6];
  const { rows: [t] } = await pool.query(
    `SELECT coalesce(sum(amount), 0)::bigint AS rev, (SELECT count(*)::int FROM consultations WHERE status <> 'annulee' AND consulted_at >= CURRENT_DATE) AS cons
     FROM payments WHERE status = 'valide' AND created_at >= CURRENT_DATE`);
  assert.equal(today.revenue, Number(t.rev));
  assert.equal(today.consultations, t.cons);
  assert.ok(p.amount === 7000);
  const r = (await admin.get('/api/reports/summary?period=month')).body;
  const expectedDays = new Date().getDate();
  assert.equal(r.series.length, expectedDays);
  assert.equal(r.series.at(-1).revenue, Number(t.rev));
  assert.equal(r.series.reduce((s, x) => s + Number(x.revenue), 0), Number(r.totals.revenue));
});

test('index justifiés présents ; JIT désactivé pour les connexions applicatives', async () => {
  const { rows } = await pool.query(`SELECT indexname FROM pg_indexes WHERE indexname IN
    ('pharmacy_sale_items_sale_idx', 'lab_request_items_request_idx', 'consultation_acts_consultation_idx') ORDER BY 1`);
  assert.deepEqual(rows.map((r) => r.indexname), ['consultation_acts_consultation_idx', 'lab_request_items_request_idx', 'pharmacy_sale_items_sale_idx']);
  const { rows: [j] } = await pool.query('SHOW jit');
  assert.equal(j.jit, 'off');
});
