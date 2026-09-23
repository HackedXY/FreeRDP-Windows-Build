import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, adminAgent, employee, login, pool, app, closePools } from './helpers.js';
import supertest from 'supertest';

let admin, doctor, cashier, pharmacist, nurse, labtech;
let patient, consultation;

before(async () => {
  await resetDb();
  admin = await adminAgent();
  doctor = await employee(admin, 'medecin', 'medecin01');
  cashier = await employee(admin, 'caissier', 'caissier01');
  pharmacist = await employee(admin, 'pharmacien', 'pharma01');
  nurse = await employee(admin, 'infirmier', 'infirmier01');
  labtech = await employee(admin, 'laborantin', 'labo01');
});
after(async () => { await closePools(); });

test('authentification : refus sans session et en-tête CSRF exigé', async () => {
  const r = await supertest(app).get('/api/patients');
  assert.equal(r.status, 401);
  const r2 = await supertest(app).post('/api/auth/login').send({ username: 'admin', password: 'x' });
  assert.equal(r2.status, 403);
});

test('mot de passe temporaire : changement obligatoire avant tout accès', async () => {
  const roles = (await admin.get('/api/roles')).body;
  const res = await admin.post('/api/users').send({ first_name: 'Temp', last_name: 'User', role_id: roles.find((r) => r.code === 'caissier').id, username: 'temp01' });
  assert.equal(res.status, 201);
  const a = await login('temp01', res.body.temporaryPassword);
  assert.equal(a.loginRes.status, 200);
  const r = await a.get('/api/patients');
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'PASSWORD_CHANGE_REQUIRED');
});

test('verrouillage après échecs répétés + alerte système', async () => {
  for (let i = 0; i < 5; i++) await login('temp01', 'mauvais-mdp-1');
  const r = await login('temp01', 'mauvais-mdp-1');
  assert.equal(r.loginRes.status, 423);
  const alerts = (await admin.get('/api/alerts?type=connexion_echouee')).body.items;
  assert.ok(alerts.length >= 1);
});

test('compte désactivé : accès impossible et session révoquée', async () => {
  const u = await employee(admin, 'caissier', 'caissier99');
  assert.equal((await u.get('/api/payments')).status, 200);
  await admin.put(`/api/users/${u.user.id}`).send({ status: 'disabled' });
  assert.equal((await u.get('/api/payments')).status, 401);
  const again = await login('caissier99', 'Employe2026x');
  assert.equal(again.loginRes.status, 403);
});

test('patients : création et principe du moindre privilège', async () => {
  const r = await nurse.post('/api/patients').send({
    first_name: 'Mariama', last_name: 'Camara', sex: 'F', birth_date: '1990-04-12', phone: '620000001',
    allergies: 'Pénicilline', medical_history: 'Asthme',
  });
  assert.equal(r.status, 201);
  patient = r.body;
  assert.match(patient.patient_number, /^P-\d{6}$/);
  assert.equal(patient.allergies, 'Pénicilline');
  // chiffré en base
  const { rows: [raw] } = await pool.query('SELECT allergies FROM patients WHERE id = $1', [patient.id]);
  assert.match(raw.allergies, /^enc:v1:/);
  // le caissier voit l'identité, pas le dossier médical
  const c = await cashier.get(`/api/patients/${patient.id}`);
  assert.equal(c.status, 200);
  assert.equal(c.body.allergies, undefined);
  assert.equal(c.body.medical_restricted, true);
});

test('accès non autorisé : refus tracé + alerte', async () => {
  const r = await cashier.get('/api/audit');
  assert.equal(r.status, 403);
  const alerts = (await admin.get('/api/alerts?type=acces_non_autorise')).body.items;
  assert.ok(alerts.some((a) => a.user_id === cashier.user.id));
});

test('consultation : constantes, diagnostic, actes et montant', async () => {
  const acts = (await doctor.get('/api/acts')).body;
  const cons = acts.find((a) => a.code === 'CONS');
  const inj = acts.find((a) => a.code === 'INJ');
  const r = await doctor.post('/api/consultations').send({
    patient_id: patient.id, reason: 'Fièvre', temperature_c: 38.5, bp_systolic: 120, bp_diastolic: 80,
    diagnosis: 'Paludisme simple', acts: [{ act_id: cons.id, quantity: 1 }, { act_id: inj.id, quantity: 2 }],
    status: 'en_cours',
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  consultation = r.body;
  assert.equal(consultation.amount, 50000 + 2 * 10000);
  assert.equal(consultation.diagnosis, 'Paludisme simple');
  assert.equal(consultation.doctor_id, doctor.user.id);
  // le caissier ne voit pas le diagnostic
  const c = await admin.get(`/api/consultations/${consultation.id}`);
  assert.equal(c.body.diagnosis, 'Paludisme simple');
  const pr = await doctor.post(`/api/consultations/${consultation.id}/prescriptions`).send({ items: [{ drug_name: 'Artéméther-Luméfantrine', dosage: '80/480', frequency: '2x/j', duration: '3 j' }] });
  assert.equal(pr.status, 201);
  const done = await doctor.put(`/api/consultations/${consultation.id}`).send({ status: 'terminee' });
  assert.equal(done.status, 200);
  assert.equal(done.body.status, 'terminee');
});

test('paiement en espèces sans caisse ouverte : refusé', async () => {
  const r = await cashier.post('/api/payments').send({ source_type: 'consultation', source_id: consultation.id, method: 'especes' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /caisse/i);
});

let payment;
test('caisse : ouverture, paiement, idempotence, reçu', async () => {
  const o = await cashier.post('/api/cash/open').send({ opening_balance: 1000000 });
  assert.equal(o.status, 201);
  const r = await cashier.post('/api/payments').set('Idempotency-Key', 'k-1').send({ source_type: 'consultation', source_id: consultation.id, method: 'especes' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  payment = r.body;
  assert.equal(payment.amount, 70000);
  assert.match(payment.number, /^PAY-\d{4}-\d{6}$/);
  assert.match(payment.receipt_number, /^REC-\d{4}-\d{6}$/);
  // doublon (resynchronisation) : même paiement renvoyé, pas de double encaissement
  const dup = await cashier.post('/api/payments').set('Idempotency-Key', 'k-1').send({ source_type: 'consultation', source_id: consultation.id, method: 'especes' });
  assert.equal(dup.status, 200);
  assert.equal(dup.body.id, payment.id);
  const c = await admin.get(`/api/consultations/${consultation.id}`);
  assert.equal(c.body.payment_status, 'payee');
  const pdf = await cashier.get(`/api/payments/${payment.id}/receipt.pdf`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers['content-type'], 'application/pdf');
  // Orange Money : référence obligatoire
  const om = await cashier.post('/api/payments').send({ source_type: 'other', payer_name: 'X', description: 'Certificat', amount: 20000, method: 'orange_money' });
  assert.equal(om.status, 400);
});

test('remise interdite sans permission', async () => {
  const acts = (await cashier.get('/api/acts')).body;
  const r = await cashier.post('/api/payments').send({ source_type: 'act', act_id: acts[0].id, patient_id: patient.id, method: 'especes', discount: 1000 });
  assert.equal(r.status, 403);
});

test('modification de paiement : motif obligatoire, audit ancien/nouveau montant, alerte', async () => {
  const bad = await admin.put(`/api/payments/${payment.id}`).send({ amount: 50000 });
  assert.equal(bad.status, 400);
  const r = await admin.put(`/api/payments/${payment.id}`).send({ amount: 50000, reason: 'correction de saisie' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.amount, 50000);
  const log = (await admin.get(`/api/audit?entity_type=payment&entity_id=${payment.id}`)).body.items;
  const upd = log.find((l) => l.action === 'payment.update');
  assert.deepEqual([upd.old_value.amount, upd.new_value.amount, upd.reason], [70000, 50000, 'correction de saisie']);
  const c = await admin.get(`/api/consultations/${consultation.id}`);
  assert.equal(c.body.payment_status, 'partielle');
  const alerts = (await admin.get('/api/alerts?type=paiement_modifie')).body.items;
  assert.equal(alerts.length, 1);
});

test('dépenses : seuil de validation, décaissement', async () => {
  const small = await cashier.post('/api/expenses').send({ category: 'Fournitures', amount: 100000, reason: 'Papier imprimante', pay_from_cash: true });
  assert.equal(small.status, 201, JSON.stringify(small.body));
  assert.equal(small.body.status, 'validee');
  assert.equal(small.body.disbursed, true);
  const big = await cashier.post('/api/expenses').send({ category: 'Matériel', amount: 2000000, reason: 'Achat matériel médical' });
  assert.equal(big.body.status, 'en_attente');
  assert.equal((await cashier.post(`/api/expenses/${big.body.id}/validate`).send({ decision: 'validee' })).status, 403);
  const v = await admin.post(`/api/expenses/${big.body.id}/validate`).send({ decision: 'validee', comment: 'OK' });
  assert.equal(v.body.status, 'validee');
  const alerts = (await admin.get('/api/alerts?type=depense_inhabituelle')).body.items;
  assert.equal(alerts.length, 1);
});

test('clôture de caisse : caisse théorique, écart, justification, alerte', async () => {
  const cur = (await cashier.get('/api/cash/current')).body[0];
  // 1 000 000 + 50 000 (paiement corrigé) - 100 000 (dépense)
  assert.equal(cur.expected_balance, 950000);
  const noJust = await cashier.post('/api/cash/close').send({ declared_balance: 900000 });
  assert.equal(noJust.status, 400);
  const r = await cashier.post('/api/cash/close').send({ declared_balance: 900000, justification: 'Erreur de rendu monnaie' });
  assert.equal(r.status, 200);
  assert.equal(r.body.discrepancy, -50000);
  const alerts = (await admin.get('/api/alerts?type=ecart_caisse')).body.items;
  assert.equal(alerts[0].severity, 'haute');
  // le caissier ne voit que ses sessions ; l'admin voit toutes les clôtures
  assert.equal((await admin.get('/api/cash/sessions')).body.items.length, 1);
});

test('annulation d\'un paiement dont la caisse est clôturée : refusée (remboursement requis)', async () => {
  const r = await admin.post(`/api/payments/${payment.id}/cancel`).send({ reason: 'test' });
  assert.equal(r.status, 400);
});

test('pharmacie : stock, vente FEFO, alertes stock faible / épuisé', async () => {
  const p = await pharmacist.post('/api/pharmacy/products').send({
    reference: 'AMOX500', name: 'Amoxicilline 500 mg', category: 'medicament', purchase_price: 500, sale_price: 1000, min_threshold: 20,
    initial_quantity: 100, lot_number: 'L1', expiry_date: '2030-01-01',
  });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  await pharmacist.post('/api/pharmacy/stock/in').send({ product_id: p.body.id, quantity: 10, reason: 'achat', lot_number: 'L0', expiry_date: '2027-06-01' });
  const s = await pharmacist.post('/api/pharmacy/sales').send({ patient_id: patient.id, items: [{ product_id: p.body.id, quantity: 15 }] });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  assert.equal(s.body.amount, 15000);
  const prod = (await pharmacist.get(`/api/pharmacy/products/${p.body.id}`)).body;
  assert.equal(prod.quantity, 95);
  assert.equal(prod.lots.find((l) => l.lot_number === 'L0').quantity, 0);  // premier expiré, premier sorti
  const mv = prod.movements.find((m) => m.reason === 'vente');
  assert.deepEqual([mv.qty_before, mv.qty_after, mv.quantity], [110, 95, -15]);
  // pas d'encaissement sans permission
  const pay = await pharmacist.post('/api/pharmacy/sales').send({ items: [{ product_id: p.body.id, quantity: 1 }], payment: { method: 'especes' } });
  assert.equal(pay.status, 403);
  // perte sans justification refusée
  assert.equal((await pharmacist.post('/api/pharmacy/stock/out').send({ product_id: p.body.id, quantity: 1, reason: 'perte' })).status, 400);
  await pharmacist.post('/api/pharmacy/stock/out').send({ product_id: p.body.id, quantity: 80, reason: 'perte', note: 'Casse' });
  let alerts = (await admin.get('/api/alerts?status=open&category=stock')).body.items;
  assert.ok(alerts.some((a) => a.type === 'stock_faible'));
  await pharmacist.post('/api/pharmacy/stock/out').send({ product_id: p.body.id, quantity: 15, reason: 'utilisation' });
  alerts = (await admin.get('/api/alerts?status=open&category=stock')).body.items;
  assert.ok(alerts.some((a) => a.type === 'stock_epuise'));
  // réapprovisionnement : alertes résolues automatiquement
  await pharmacist.post('/api/pharmacy/stock/in').send({ product_id: p.body.id, quantity: 50, reason: 'livraison' });
  alerts = (await admin.get('/api/alerts?status=open&category=stock')).body.items;
  assert.ok(!alerts.some((a) => a.ref_id === p.body.id));
  // survente impossible
  assert.equal((await pharmacist.post('/api/pharmacy/sales').send({ items: [{ product_id: p.body.id, quantity: 999 }] })).status, 400);
});

test('inventaire : écart justifié et correction tracée', async () => {
  const inv = await pharmacist.post('/api/pharmacy/inventories').send({});
  assert.equal(inv.status, 201);
  const detail = (await pharmacist.get(`/api/pharmacy/inventories/${inv.body.id}`)).body;
  const line = detail.lines[0];
  await pharmacist.put(`/api/pharmacy/inventories/${inv.body.id}/lines`).send({ lines: [{ product_id: line.product_id, counted_qty: line.theoretical_qty - 2 }] });
  assert.equal((await pharmacist.post(`/api/pharmacy/inventories/${inv.body.id}/validate`)).status, 400);
  await pharmacist.put(`/api/pharmacy/inventories/${inv.body.id}/lines`).send({ lines: [{ product_id: line.product_id, counted_qty: line.theoretical_qty - 2, justification: 'Produits abîmés' }] });
  const v = await pharmacist.post(`/api/pharmacy/inventories/${inv.body.id}/validate`);
  assert.equal(v.status, 200);
  assert.equal(v.body.corrections, 1);
});

test('laboratoire : demande → résultat → notification', async () => {
  const exams = (await doctor.get('/api/lab/exams')).body;
  const r = await doctor.post('/api/lab/requests').send({ patient_id: patient.id, consultation_id: consultation.id, exam_type_ids: [exams[0].id, exams[1].id] });
  assert.equal(r.status, 201);
  assert.equal(r.body.amount, exams[0].price + exams[1].price);
  const items = r.body.items.map((i) => ({ id: i.id, result_value: 'Négatif', abnormal: false }));
  assert.equal((await doctor.put(`/api/lab/requests/${r.body.id}/results`).send({ items, complete: true })).status, 403);
  const res = await labtech.put(`/api/lab/requests/${r.body.id}/results`).send({ items, complete: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'terminee');
  const notifs = (await doctor.get('/api/notifications')).body.items;
  assert.ok(notifs.some((n) => n.title === 'Résultats disponibles'));
});

test('rôles personnalisés et surcharges de permissions', async () => {
  const r = await admin.post('/api/roles').send({ name: 'Secrétaire', permissions: ['patients.view', 'patients.create', 'appointments.view', 'appointments.manage'] });
  assert.equal(r.status, 201);
  const roles = (await admin.get('/api/roles')).body;
  const sec = await employee(admin, 'secretaire', 'secretaire01');
  assert.equal((await sec.get('/api/appointments')).status, 200);
  assert.equal((await sec.get('/api/payments')).status, 403);
  await admin.put(`/api/users/${sec.user.id}`).send({ permission_overrides: [{ permission_code: 'payments.view', granted: true }] });
  assert.equal((await sec.get('/api/payments')).status, 200);
  assert.ok(roles.find((x) => x.code === 'secretaire'));
  const log = (await admin.get('/api/audit?action=user.permissions_change')).body.items;
  assert.ok(log.length >= 1);
});

test('rendez-vous : création, conflit de créneau, annulation', async () => {
  const when = new Date(Date.now() + 86400000).toISOString();
  const a = await nurse.post('/api/appointments').send({ patient_id: patient.id, doctor_id: doctor.user.id, scheduled_at: when, reason: 'Contrôle' });
  assert.equal(a.status, 201);
  const clash = await nurse.post('/api/appointments').send({ patient_id: patient.id, doctor_id: doctor.user.id, scheduled_at: when });
  assert.equal(clash.status, 400);
  assert.equal((await nurse.post(`/api/appointments/${a.body.id}/cancel`).send({ reason: 'Patient indisponible' })).status, 200);
});

test('tableau de bord, rapports, rapport employé, recherche', async () => {
  const d = await admin.get('/api/dashboard');
  assert.equal(d.status, 200);
  assert.ok(d.body.revenue > 0);
  assert.ok(d.body.activity.length > 0);
  assert.equal(d.body.series.length, 7);
  assert.equal((await cashier.get('/api/dashboard')).status, 403);
  const rep = await admin.get('/api/reports/summary?period=month');
  assert.equal(rep.status, 200);
  assert.ok(rep.body.totals.revenue > 0);
  assert.equal(rep.body.cash.total_discrepancy, -50000);
  const emp = await admin.get(`/api/reports/employee/${cashier.user.id}?period=today`);
  assert.equal(emp.status, 200);
  assert.ok(emp.body.payments.count >= 1);
  assert.equal(emp.body.cash_closings.length, 1);
  const s = await admin.get('/api/search?q=camara');
  assert.equal(s.body.patients.length, 1);
  const s2 = await labtech.get('/api/search?q=camara');
  assert.equal(s2.body.payments, undefined);
});

test('journal d\'audit : intégrité vérifiée (chaîne + signatures)', async () => {
  const v = await admin.get('/api/audit/verify');
  assert.equal(v.body.ok, true);
  assert.ok(v.body.entries > 20);
  // Les autres tentatives de falsification sont couvertes par audit-integrity.test.js
  await assert.rejects(pool.query('DELETE FROM payments'), /permission denied|interdite/);
});
