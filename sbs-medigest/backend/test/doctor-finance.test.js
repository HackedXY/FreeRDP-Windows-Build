import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { io as ioc } from 'socket.io-client';
import { resetDb, adminAgent, employee, app, closePools } from './helpers.js';
const { attachRealtime } = await import('../src/server.js');

let server, url, admin, doctor, cashier;
const FINANCE_KEYS = ['revenue', 'payment_count', 'refunds', 'expenses', 'pharmacy_sales', 'lab_revenue', 'revenue_by_method', 'cash', 'activity'];

before(async () => {
  await resetDb();
  server = http.createServer(app); server.io = attachRealtime(server);
  await new Promise((r) => server.listen(0, r)); url = `http://127.0.0.1:${server.address().port}`;
  admin = await adminAgent();
  doctor = await employee(admin, 'medecin', 'doc01');
  cashier = await employee(admin, 'caissier', 'cai01');
  await cashier.post('/api/cash/open').send({ opening_balance: 1000000 });
  await cashier.post('/api/payments').send({ source_type: 'other', payer_name: 'X', description: 'Certificat', amount: 150000, method: 'especes' });
  await cashier.post('/api/expenses').send({ category: 'Carburant', amount: 50000, reason: 'Groupe électrogène', pay_from_cash: true });
});
after(async () => { server.io.close(); server.close(); await closePools(); });

test('rôle Médecin par défaut : aucune permission financière', async () => {
  const role = (await admin.get('/api/roles')).body.find((r) => r.code === 'medecin');
  for (const p of ['dashboard.finance', 'payments.view', 'payments.create', 'cash.operate', 'cash.view_all', 'expenses.view', 'reports.view', 'reports.employee', 'settings.manage']) {
    assert.ok(!role.permissions.includes(p), p);
  }
  const me = (await doctor.get('/api/auth/me')).body.user;
  assert.ok(!me.permissions.includes('dashboard.finance'));
});

test('tableau de bord du médecin : volet médical uniquement', async () => {
  const d = (await doctor.get('/api/dashboard')).body;
  assert.equal(d.finance, false);
  for (const k of FINANCE_KEYS) assert.equal(d[k], undefined, k);
  assert.equal(d.pending.expenses_to_validate, undefined);
  assert.ok(d.series.every((s) => s.revenue === undefined && s.expenses === undefined));
  assert.equal(typeof d.consultations, 'number');
  // le propriétaire voit tout
  const a = (await admin.get('/api/dashboard')).body;
  assert.equal(a.finance, true);
  assert.equal(a.revenue, 150000);
  assert.equal(a.cash.theoretical, 1100000);
});

test('médecin : tous les points d\'accès financiers refusés', async () => {
  for (const url of ['/api/cash/current', '/api/cash/sessions', '/api/payments', '/api/payments/pending', '/api/payments/1', '/api/payments/1/receipt.pdf',
    '/api/expenses', '/api/reports/summary?period=today', '/api/reports/employee/1?period=today', '/api/pharmacy/sales', '/api/settings', '/api/settings/backups', '/api/audit']) {
    assert.equal((await doctor.get(url)).status, 403, url);
  }
  assert.equal((await doctor.post('/api/payments').send({ source_type: 'other', payer_name: 'x', description: 'x', amount: 1, method: 'especes' })).status, 403);
  assert.equal((await doctor.post('/api/cash/close').send({ declared_balance: 0 })).status, 403);
  // stock visible sans prix d'achat
  const products = (await doctor.get('/api/pharmacy/products')).body;
  assert.ok(products.every((p) => p.purchase_price === undefined));
});

test('temps réel : le médecin ne reçoit ni recettes, ni dépenses, ni caisse, ni fil d\'activité', async () => {
  const s = ioc(url, { extraHeaders: { cookie: doctor.loginRes.headers['set-cookie'][0].split(';')[0] }, transports: ['websocket'] });
  await new Promise((r) => s.on('connect', r));
  const got = []; s.onAny((e, p) => got.push([e, p]));
  await cashier.post('/api/payments').send({ source_type: 'other', payer_name: 'Y', description: 'Certificat', amount: 70000, method: 'especes' });
  await cashier.post('/api/expenses').send({ category: 'Eau', amount: 20000, reason: 'Facture', pay_from_cash: true });
  await new Promise((r) => setTimeout(r, 300));
  s.close();
  assert.ok(!got.some(([e]) => e === 'activity'));
  assert.ok(!JSON.stringify(got).match(/70000|20000|amount|Nouveau paiement|Nouvelle dépense/));
});

test('seul le propriétaire peut accorder l\'accès financier ; il s\'applique alors', async () => {
  assert.equal((await admin.put(`/api/users/${doctor.user.id}`).send({ permission_overrides: [{ permission_code: 'dashboard.finance', granted: true }] })).status, 200);
  assert.equal((await doctor.get('/api/dashboard')).body.finance, true);
  await admin.put(`/api/users/${doctor.user.id}`).send({ permission_overrides: [] });
  assert.equal((await doctor.get('/api/dashboard')).body.finance, false);
  const perms = (await admin.get('/api/roles/permissions')).body;
  assert.equal(perms.find((p) => p.code === 'dashboard.finance').high_privilege, true);
});
