import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { io as ioc } from 'socket.io-client';
import { resetDb, adminAgent, employee, login, ownerPool, app, closePools } from './helpers.js';
const { attachRealtime } = await import('../src/server.js');

// Permission donnant accès au flux financier du tableau de bord
const FIN = 'dashboard.view';
let server, url, admin, cashier, roleId;
const cookieOf = (a) => a.loginRes.headers['set-cookie'][0].split(';')[0];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(agent, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const s = ioc(url, { extraHeaders: { cookie: cookieOf(agent), ...extraHeaders }, transports: ['websocket'], reconnection: false });
    const events = [];
    s.onAny((e, p) => events.push([e, p]));
    s.events = events;
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}
let n = 0;
async function pay(amount = 150000) {
  const r = await cashier.post('/api/payments').send({ source_type: 'other', payer_name: `Patient Nom${++n}`, description: 'Certificat', amount, method: 'especes' });
  assert.equal(r.status, 201);
  await wait(250);
}
const finEvents = (s) => s.events.filter(([e]) => ['activity', 'stats', 'notification'].includes(e));

before(async () => {
  await resetDb();
  server = http.createServer(app); server.io = attachRealtime(server);
  await new Promise((r) => server.listen(0, r)); url = `http://127.0.0.1:${server.address().port}`;
  admin = await adminAgent();
  cashier = await employee(admin, 'caissier', 'caissier01');
  await cashier.post('/api/cash/open').send({ opening_balance: 0 });
  await admin.post('/api/roles').send({ name: 'Superviseur', permissions: [FIN, 'patients.view'] });
  roleId = (await admin.get('/api/roles')).body.find((r) => r.code === 'superviseur').id;
});
after(async () => { server.io.close(); server.close(); await closePools(); });

test('retrait d\'une permission individuelle : le flux s\'arrête dès la réponse de l\'API', async () => {
  const nurse = await employee(admin, 'infirmier', 'inf01');
  await admin.put(`/api/users/${nurse.user.id}`).send({ permission_overrides: [{ permission_code: FIN, granted: true }] });
  const s = await connect(nurse);
  await pay();
  assert.ok(s.events.some(([e, p]) => e === 'activity' && p.amount === 150000), 'reçoit la recette tant qu\'autorisé');
  s.events.length = 0;
  const r = await admin.put(`/api/users/${nurse.user.id}`).send({ permission_overrides: [] });
  assert.equal(r.status, 200);
  await pay(99000);
  assert.deepEqual(finEvents(s), [], 'plus aucun montant ni activité après révocation');
  s.close();
});

test('modification d\'un rôle : tous ses titulaires perdent immédiatement le flux', async () => {
  const sup = await employee(admin, 'superviseur', 'sup01');
  const s = await connect(sup);
  await pay();
  assert.ok(finEvents(s).length > 0);
  s.events.length = 0;
  assert.equal((await admin.put(`/api/roles/${roleId}`).send({ name: 'Superviseur', permissions: ['patients.view'] })).status, 200);
  await pay(88000);
  assert.deepEqual(finEvents(s), []);
  s.close();
  await admin.put(`/api/roles/${roleId}`).send({ name: 'Superviseur', permissions: [FIN, 'patients.view'] });
});

test('déconnexion : la socket de la session est fermée immédiatement', async () => {
  const sup = await employee(admin, 'superviseur', 'sup02');
  const s = await connect(sup);
  const closed = new Promise((r) => s.on('disconnect', r));
  await sup.post('/api/auth/logout');
  await Promise.race([closed, wait(1000).then(() => { throw new Error('socket toujours ouverte'); })]);
  s.events.length = 0;
  await pay();
  assert.deepEqual(finEvents(s), []);
});

test('désactivation du compte et réinitialisation du mot de passe : déconnexion immédiate', async () => {
  const a = await employee(admin, 'superviseur', 'sup03');
  const b = await employee(admin, 'superviseur', 'sup04');
  const sa = await connect(a); const sb = await connect(b);
  const ca = new Promise((r) => sa.on('disconnect', r)); const cb = new Promise((r) => sb.on('disconnect', r));
  await admin.put(`/api/users/${a.user.id}`).send({ status: 'disabled' });
  await admin.post(`/api/users/${b.user.id}/reset-password`);
  await Promise.race([Promise.all([ca, cb]), wait(1000).then(() => { throw new Error('socket toujours ouverte'); })]);
  sa.events.length = 0; sb.events.length = 0;
  await pay();
  assert.deepEqual([...finEvents(sa), ...finEvents(sb)], []);
});

test('session révoquée ou expirée directement en base : aucun événement livré, socket fermée', async () => {
  const a = await employee(admin, 'superviseur', 'sup05');
  const b = await employee(admin, 'superviseur', 'sup06');
  const sa = await connect(a); const sb = await connect(b);
  await ownerPool.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1`, [a.user.id]);
  await ownerPool.query(`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [b.user.id]);
  await wait(2100); // au-delà du cache d'autorisation (REALTIME_AUTH_CACHE_MS)
  await pay();
  assert.deepEqual([...finEvents(sa), ...finEvents(sb)], []);
  assert.equal(sa.connected, false); assert.equal(sb.connected, false);
});

test('les événements ne sont plus distribués par salon fixé à la connexion', async () => {
  const sup = await employee(admin, 'superviseur', 'sup07');
  const s = await connect(sup);
  const ids = await server.io.in(`perm:${FIN}`).fetchSockets();
  assert.equal(ids.length, 0);
  s.close();
});

test('poignée de main depuis une origine étrangère refusée', async () => {
  const sup = await employee(admin, 'superviseur', 'sup08');
  await assert.rejects(connect(sup, { origin: 'https://site-malveillant.example' }));
  const ok = await connect(sup, { origin: url });
  assert.equal(ok.connected, true);
  ok.close();
});
