// Phase 4 : alerte sur les ventes de pharmacie restées impayées, dans le respect des permissions
// (alerte : alerts.view ; notification : personnes habilitées à encaisser ; aucune donnée médicale).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, adminAgent, employee, pool, ownerPool, closePools } from './helpers.js';
import { checkUnpaidSales } from '../src/lib/receivables.js';
import { makeContext } from '../src/lib/realtime.js';
import { tx } from '../src/db/pool.js';

let admin, pharmacist, cashier, nurse, product, oldSale, recentSale;
const run = () => tx((db) => checkUnpaidSales(db, makeContext({ deferred: false })));

before(async () => {
  await resetDb();
  admin = await adminAgent();
  pharmacist = await employee(admin, 'pharmacien', 'phaImp');
  cashier = await employee(admin, 'caissier', 'caiImp');
  nurse = await employee(admin, 'infirmier', 'infImp');
  product = (await pharmacist.post('/api/pharmacy/products').send({ reference: 'ALU', name: 'Artéméther-luméfantrine', category: 'medicament', purchase_price: 500, sale_price: 4000, min_threshold: 0, initial_quantity: 50 })).body;
  oldSale = (await pharmacist.post('/api/pharmacy/sales').send({ customer_name: 'Client', items: [{ product_id: product.id, quantity: 2 }] })).body;
  recentSale = (await pharmacist.post('/api/pharmacy/sales').send({ customer_name: 'Client 2', items: [{ product_id: product.id, quantity: 1 }] })).body;
  await ownerPool.query(`UPDATE pharmacy_sales SET created_at = now() - interval '30 hours' WHERE id = $1`, [oldSale.id]);
});
after(async () => { await closePools(); });

test('vente impayée depuis plus de 24 h : une alerte (une seule), vente récente ignorée', async () => {
  assert.equal(await run(), 1);
  assert.equal(await run(), 0, 'pas de doublon tant que l\'alerte est ouverte');
  const alerts = (await admin.get('/api/alerts?type=vente_impayee')).body.items;
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].ref_id, oldSale.id);
  assert.match(alerts[0].title, new RegExp(oldSale.number));
  assert.match(alerts[0].title, /8 000 GNF/);
});

test('permissions : alerte réservée à alerts.view ; notification aux seuls rôles d\'encaissement ; aucune donnée médicale', async () => {
  for (const a of [pharmacist, cashier, nurse]) assert.equal((await a.get('/api/alerts?type=vente_impayee')).status, 403);
  const n = (await cashier.get('/api/notifications')).body.items.filter((x) => x.type === 'to_pay');
  assert.equal(n.length, 1);
  assert.match(n[0].body, new RegExp(oldSale.number));
  for (const a of [pharmacist, nurse]) {
    assert.equal((await a.get('/api/notifications')).body.items.filter((x) => x.type === 'to_pay').length, 0);
  }
  const { rows } = await pool.query(`SELECT title, details FROM alerts WHERE type = 'vente_impayee'`);
  const dump = JSON.stringify(rows) + JSON.stringify(n);
  assert.ok(!/Artéméther|luméfantrine|Client/.test(dump), 'ni produit ni client dans l\'alerte');
});

test('vente soldée : alerte résolue automatiquement ; vente annulée : idem', async () => {
  await cashier.post('/api/cash/open').send({ opening_balance: 0 });
  assert.equal((await cashier.post('/api/payments').send({ source_type: 'pharmacy_sale', source_id: oldSale.id, method: 'especes' })).status, 201);
  let { rows: [a] } = await pool.query(`SELECT status, resolution_note FROM alerts WHERE dedupe_key = $1`, [`unpaid_sale:${oldSale.id}`]);
  assert.equal(a.status, 'resolue');
  await ownerPool.query(`UPDATE pharmacy_sales SET created_at = now() - interval '30 hours' WHERE id = $1`, [recentSale.id]);
  assert.equal(await run(), 1);
  assert.equal((await admin.post(`/api/pharmacy/sales/${recentSale.id}/cancel`).send({ reason: 'Erreur de saisie' })).status, 200);
  ({ rows: [a] } = await pool.query(`SELECT status FROM alerts WHERE dedupe_key = $1`, [`unpaid_sale:${recentSale.id}`]));
  assert.equal(a.status, 'resolue');
  assert.equal(await run(), 0);
});
