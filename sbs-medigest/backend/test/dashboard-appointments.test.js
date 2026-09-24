// Remédiation phase 1 : tableau de bord selon les permissions (bloc « alerts » optionnel)
// et contrôle des conflits de créneau à la modification d'un rendez-vous.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, adminAgent, employee, closePools } from './helpers.js';

let admin, doctorA, doctorB, nurse, financeWithAlerts, financeNoAlerts, patient;

before(async () => {
  await resetDb();
  admin = await adminAgent();
  // rôles financiers personnalisés (créés par le propriétaire) : avec et sans « alerts.view »
  assert.equal((await admin.post('/api/roles').send({ name: 'Gerant avec alertes', permissions: ['dashboard.finance', 'alerts.view'] })).status, 201);
  assert.equal((await admin.post('/api/roles').send({ name: 'Gerant sans alertes', permissions: ['dashboard.finance'] })).status, 201);
  financeWithAlerts = await employee(admin, 'gerant_avec_alertes', 'gerant01');
  financeNoAlerts = await employee(admin, 'gerant_sans_alertes', 'gerant02');
  doctorA = await employee(admin, 'medecin', 'medecinA');
  doctorB = await employee(admin, 'medecin', 'medecinB');
  nurse = await employee(admin, 'infirmier', 'infirmierA');
  patient = (await nurse.post('/api/patients').send({ first_name: 'Awa', last_name: 'Sylla', sex: 'F' })).body;
});
after(async () => { await closePools(); });

// ------------------------------------------------------------------ tableau de bord
test('tableau de bord : dashboard.finance + alerts.view → volet financier avec le bloc alertes', async () => {
  const r = await financeWithAlerts.get('/api/dashboard');
  assert.equal(r.status, 200);
  assert.equal(r.body.finance, true);
  assert.equal(typeof r.body.revenue, 'number');
  assert.ok(r.body.alerts, 'bloc alertes présent');
  for (const k of ['open', 'stock', 'to_check', 'high']) assert.equal(typeof r.body.alerts[k], 'number', k);
});

test('tableau de bord : dashboard.finance SANS alerts.view → volet financier, sans bloc alertes (géré par l\'interface)', async () => {
  const r = await financeNoAlerts.get('/api/dashboard');
  assert.equal(r.status, 200);
  assert.equal(r.body.finance, true);
  assert.equal(r.body.alerts, undefined);
  assert.ok(r.body.cash && Array.isArray(r.body.cash.open_sessions));
  // le bloc alertes n'est pas accessible par ailleurs
  assert.equal((await financeNoAlerts.get('/api/alerts')).status, 403);
});

test('tableau de bord : utilisateur sans accès financier → volet médical uniquement', async () => {
  const r = await doctorA.get('/api/dashboard');
  assert.equal(r.status, 200);
  assert.equal(r.body.finance, false);
  for (const k of ['revenue', 'expenses', 'cash', 'activity', 'revenue_by_method', 'alerts']) assert.equal(r.body[k], undefined, k);
  // et un rôle sans aucun tableau de bord est refusé
  const pharma = await employee(admin, 'pharmacien', 'pharmaDash');
  assert.equal((await pharma.get('/api/dashboard')).status, 403);
});

// ------------------------------------------------------------------ rendez-vous
const at = (h, m = 0) => `2031-03-10T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;
const book = (agent, body) => agent.post('/api/appointments').send({ patient_id: patient.id, duration_minutes: 30, ...body });

test('rendez-vous : création normale, puis créneau déjà pris refusé à la création', async () => {
  const a = await book(nurse, { doctor_id: doctorA.user.id, scheduled_at: at(9) });
  assert.equal(a.status, 201);
  const clash = await book(nurse, { doctor_id: doctorA.user.id, scheduled_at: at(9, 15) });
  assert.equal(clash.status, 400);
  assert.match(clash.body.error, /créneau/);
});

test('rendez-vous : modification sans conflit acceptée (y compris sur son propre créneau)', async () => {
  const a = (await book(nurse, { doctor_id: doctorA.user.id, scheduled_at: at(10) })).body;
  // prolonger la durée chevauche l'ancien créneau du même rendez-vous : pas un conflit
  let r = await nurse.put(`/api/appointments/${a.id}`).send({ duration_minutes: 45 });
  assert.equal(r.status, 200);
  r = await nurse.put(`/api/appointments/${a.id}`).send({ scheduled_at: at(10, 10) });
  assert.equal(r.status, 200);
  assert.equal(new Date(r.body.scheduled_at).toISOString(), new Date(at(10, 10)).toISOString());
  // modifier un champ sans impact sur le créneau (notes, statut confirmé) reste possible
  r = await nurse.put(`/api/appointments/${a.id}`).send({ notes: 'Apporter le carnet', status: 'confirme' });
  assert.equal(r.status, 200);
});

test('rendez-vous : modification créant un conflit refusée (même médecin), sans rien modifier', async () => {
  const a = (await book(nurse, { doctor_id: doctorA.user.id, scheduled_at: at(11) })).body;
  const b = (await book(nurse, { doctor_id: doctorA.user.id, scheduled_at: at(12) })).body;
  // déplacement sur un créneau occupé
  let r = await nurse.put(`/api/appointments/${b.id}`).send({ scheduled_at: at(11, 20) });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /créneau/);
  // allongement de durée qui empiète sur le rendez-vous suivant
  r = await nurse.put(`/api/appointments/${a.id}`).send({ duration_minutes: 90 });
  assert.equal(r.status, 400);
  const list = (await nurse.get('/api/appointments?from=2031-03-10&to=2031-03-10')).body;
  const bb = list.find((x) => x.id === b.id);
  assert.equal(new Date(bb.scheduled_at).toISOString(), new Date(at(12)).toISOString(), 'rendez-vous inchangé');
});

test('rendez-vous : médecins différents — même horaire autorisé ; réaffectation vers un médecin occupé refusée', async () => {
  const a = await book(nurse, { doctor_id: doctorA.user.id, scheduled_at: at(14) });
  const b = await book(nurse, { doctor_id: doctorB.user.id, scheduled_at: at(14) });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  const r = await nurse.put(`/api/appointments/${b.body.id}`).send({ doctor_id: doctorA.user.id });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /créneau/);
});

test('rendez-vous : un rendez-vous annulé libère le créneau ; sa réactivation est contrôlée', async () => {
  const a = (await book(nurse, { doctor_id: doctorA.user.id, scheduled_at: at(16) })).body;
  assert.equal((await nurse.post(`/api/appointments/${a.id}/cancel`).send({ reason: 'Patient indisponible' })).status, 200);
  // le créneau est libre : création et déplacement vers ce créneau acceptés
  const b = await book(nurse, { doctor_id: doctorA.user.id, scheduled_at: at(16) });
  assert.equal(b.status, 201);
  const c = (await book(nurse, { doctor_id: doctorA.user.id, scheduled_at: at(17) })).body;
  // réactiver le rendez-vous annulé sur un créneau désormais pris : refusé
  const r = await nurse.put(`/api/appointments/${a.id}`).send({ status: 'planifie' });
  assert.equal(r.status, 400);
  // un rendez-vous annulé ne bloque pas le déplacement d'un autre rendez-vous
  assert.equal((await nurse.put(`/api/appointments/${c.id}`).send({ scheduled_at: at(18) })).status, 200);
});

test('rendez-vous : réservations concurrentes du même créneau — une seule acceptée', async () => {
  const results = await Promise.all([0, 1, 2, 3].map(() => book(nurse, { doctor_id: doctorB.user.id, scheduled_at: at(8) })));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status === 400).length, 3);
});
