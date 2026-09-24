import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { io as ioc } from 'socket.io-client';
import { resetDb, adminAgent, employee, pool, app, closePools } from './helpers.js';
const { attachRealtime } = await import('../src/server.js');

let server, url, admin, cashier;
before(async () => {
  await resetDb();
  server = http.createServer(app);
  const io = attachRealtime(server);
  await new Promise((r) => server.listen(0, r));
  url = `http://127.0.0.1:${server.address().port}`;
  admin = await adminAgent();
  cashier = await employee(admin, 'caissier', 'caissier_rt');
  server.io = io;
});
after(async () => { server.io.close(); server.close(); await closePools(); });

const cookieOf = (agent) => agent.loginRes.headers['set-cookie'][0].split(';')[0];
function connect(agent) {
  return new Promise((resolve, reject) => {
    const s = ioc(url, { extraHeaders: { cookie: cookieOf(agent) }, transports: ['websocket'] });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}

test('temps réel : le tableau de bord admin reçoit la nouvelle recette sans rechargement', async () => {
  const adminSock = await connect(admin);
  const cashierSock = await connect(cashier);
  const got = { admin: [], cashier: [] };
  adminSock.onAny((e, p) => got.admin.push([e, p]));
  cashierSock.onAny((e, p) => got.cashier.push([e, p]));
  await cashier.post('/api/cash/open').send({ opening_balance: 0 });
  const r = await cashier.post('/api/payments').send({ source_type: 'other', payer_name: 'Client', description: 'Certificat', amount: 150000, method: 'especes' });
  assert.equal(r.status, 201);
  await new Promise((res) => setTimeout(res, 300));
  const activity = got.admin.find(([e, p]) => e === 'activity' && p.kind === 'payment');
  assert.equal(activity[1].amount, 150000);
  assert.ok(got.admin.some(([e, p]) => e === 'notification' && p.title === 'Nouveau paiement enregistré'));
  // le caissier n'a pas accès au tableau de bord : il ne reçoit pas le flux
  assert.ok(!got.cashier.some(([e]) => e === 'activity'));
  adminSock.close(); cashierSock.close();
});

test('temps réel : connexion refusée sans session', async () => {
  await assert.rejects(new Promise((resolve, reject) => {
    const s = ioc(url, { transports: ['websocket'], reconnection: false });
    s.on('connect', () => { s.close(); resolve(); });
    s.on('connect_error', (e) => { s.close(); reject(e); });
  }));
});
