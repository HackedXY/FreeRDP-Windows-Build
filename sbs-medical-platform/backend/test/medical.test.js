import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { io as ioc } from 'socket.io-client';
import { resetDb, adminAgent, employee, ownerPool, app, closePools } from './helpers.js';
const { attachRealtime } = await import('../src/server.js');

const M = {
  name: 'Zzpatientmarker', hiv: 'HIVMARKER-POSITIF', reason: 'MOTIFMARKER', drug: 'DRUGMARKER', rdv: 'RDVMARKER',
  note: 'NOTEMARKER', obs: 'OBSMARKER', diag: 'DIAGMARKER', hivExam: 'VIH',
};
let admin, doctor, nurse, cashier, pharmacist, labtech, labviewer, server, url, sock;
let patient, consultation, labReq, prescriptionId, feed = [];

before(async () => {
  await resetDb();
  server = http.createServer(app); const io = attachRealtime(server); server.io = io;
  await new Promise((r) => server.listen(0, r)); url = `http://127.0.0.1:${server.address().port}`;
  admin = await adminAgent();
  doctor = await employee(admin, 'medecin', 'doc01');
  nurse = await employee(admin, 'infirmier', 'inf01');
  cashier = await employee(admin, 'caissier', 'cai01');
  pharmacist = await employee(admin, 'pharmacien', 'pha01');
  labtech = await employee(admin, 'laborantin', 'lab01');
  await admin.post('/api/roles').send({ name: 'Lecteur labo', permissions: ['lab.view', 'patients.view'] });
  labviewer = await employee(admin, 'lecteur_labo', 'labview01');
  sock = ioc(url, { extraHeaders: { cookie: admin.loginRes.headers['set-cookie'][0].split(';')[0] }, transports: ['websocket'] });
  await new Promise((r) => sock.on('connect', r));
  sock.onAny((e, p) => feed.push([e, p]));

  patient = (await nurse.post('/api/patients').send({ first_name: M.name, last_name: 'Test', sex: 'F' })).body;
  const acts = (await doctor.get('/api/acts')).body;
  consultation = (await nurse.post('/api/consultations').send({
    patient_id: patient.id, doctor_id: doctor.user.id, reason: M.reason, temperature_c: 38.7, bp_systolic: 131, bp_diastolic: 84,
    acts: [{ act_id: acts[0].id, quantity: 1 }],
  })).body;
  await doctor.put(`/api/consultations/${consultation.id}`).send({ observations: M.obs, diagnosis: M.diag, status: 'terminee' });
  const pr = await doctor.post(`/api/consultations/${consultation.id}/prescriptions`).send({ items: [{ drug_name: M.drug, dosage: '1 cp' }], notes: M.note });
  prescriptionId = pr.body.prescriptions[0].id;
  const exams = (await doctor.get('/api/lab/exams')).body;
  const hiv = exams.find((e) => e.code === 'HIV');
  labReq = (await doctor.post('/api/lab/requests').send({ patient_id: patient.id, consultation_id: consultation.id, exam_type_ids: [hiv.id], notes: M.note })).body;
  await labtech.put(`/api/lab/requests/${labReq.id}/results`).send({ complete: true, items: labReq.items.map((i) => ({ id: i.id, result_value: M.hiv, abnormal: true })) });
  // correction après validation (tracée sans valeur)
  await labtech.put(`/api/lab/requests/${labReq.id}/results`).send({ complete: true, items: labReq.items.map((i) => ({ id: i.id, result_value: `${M.hiv}-2`, abnormal: true })) });
  await nurse.post('/api/appointments').send({ patient_id: patient.id, doctor_id: doctor.user.id, scheduled_at: new Date(Date.now() + 86400000).toISOString(), reason: M.rdv, notes: M.note });
  await new Promise((r) => setTimeout(r, 300));
});
after(async () => { sock.close(); server.io.close(); server.close(); await closePools(); });

test('aucune donnée médicale en clair dans la base (balayage de toutes les colonnes texte)', async () => {
  const { rows: cols } = await ownerPool.query(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND data_type IN ('text', 'character varying', 'jsonb')`);
  const hits = [];
  for (const marker of [M.hiv, M.reason, M.drug, M.rdv, M.note, M.obs, M.diag]) {
    for (const c of cols) {
      const { rows: [r] } = await ownerPool.query(`SELECT count(*)::int n FROM "${c.table_name}" WHERE "${c.column_name}"::text LIKE $1`, [`%${marker}%`]);
      if (r.n) hits.push(`${marker} → ${c.table_name}.${c.column_name}`);
    }
  }
  assert.deepEqual(hits, []);
  // colonnes en clair supprimées
  const { rows } = await ownerPool.query(`SELECT column_name FROM information_schema.columns WHERE table_name IN ('consultations','lab_request_items')
    AND column_name IN ('temperature_c','bp_systolic','result_value','abnormal')`);
  assert.equal(rows.length, 0);
});

test('ni nom de patient ni intitulé/résultat d\'examen dans le journal, les notifications et les alertes', async () => {
  for (const marker of [M.name, M.hivExam, 'Sérologie']) {
    for (const [t, cols] of [['audit_log', ['summary', 'old_value::text', 'new_value::text', 'reason']], ['notifications', ['title', 'body']], ['alerts', ['title', 'details::text']]]) {
      for (const col of cols) {
        const { rows: [r] } = await ownerPool.query(`SELECT count(*)::int n FROM ${t} WHERE ${col} LIKE $1`, [`%${marker}%`]);
        assert.equal(r.n, 0, `${marker} trouvé dans ${t}.${col}`);
      }
    }
  }
});

test('fil temps réel : aucune donnée médicale ni nom de patient', async () => {
  assert.ok(feed.some(([e]) => e === 'activity'), 'le fil a bien reçu des événements');
  const text = JSON.stringify(feed);
  for (const marker of [M.name, M.hiv, M.reason, M.drug, M.rdv, M.note, M.obs, M.diag, 'Sérologie']) assert.ok(!text.includes(marker), marker);
});

test('personnel soignant autorisé : accès complet aux données déchiffrées', async () => {
  const c = (await doctor.get(`/api/consultations/${consultation.id}`)).body;
  assert.equal(c.reason, M.reason); assert.equal(c.temperature_c, 38.7); assert.equal(c.diagnosis, M.diag);
  assert.equal(c.prescriptions[0].items[0].drug_name, M.drug);
  const l = (await doctor.get(`/api/lab/requests/${labReq.id}`)).body;
  assert.equal(l.items[0].result_value, `${M.hiv}-2`); assert.equal(l.notes, M.note);
  const n = (await nurse.get(`/api/consultations/${consultation.id}`)).body;
  assert.equal(n.reason, M.reason); assert.equal(n.bp_systolic, 131);
  const a = (await nurse.get('/api/appointments')).body[0];
  assert.equal(a.reason, M.rdv);
});

test('caissier : aucun accès aux données médicales', async () => {
  assert.equal((await cashier.get('/api/consultations')).status, 403);
  assert.equal((await cashier.get(`/api/consultations/${consultation.id}`)).status, 403);
  assert.equal((await cashier.get(`/api/lab/requests/${labReq.id}`)).status, 403);
  assert.equal((await cashier.get(`/api/consultations/prescriptions/${prescriptionId}`)).status, 403);
  const h = (await cashier.get(`/api/patients/${patient.id}/history`)).body;
  assert.equal(h.consultations, undefined); assert.equal(h.prescriptions, undefined); assert.equal(h.lab_requests, undefined);
  assert.ok(h.payments);
  const rem = await cashier.get('/api/appointments/reminders');
  assert.equal(rem.status, 200);
  assert.ok(rem.body.length >= 1 && rem.body.every((a) => a.reason === undefined));
  assert.equal((await nurse.get('/api/appointments/reminders')).body[0].reason, M.rdv);
  const appts = (await cashier.get('/api/appointments')).body;
  assert.equal(appts[0].reason, undefined); assert.equal(appts[0].details_restricted, true);
  const p = (await cashier.get(`/api/patients/${patient.id}`)).body;
  assert.equal(p.medical_restricted, true);
  const pend = JSON.stringify((await cashier.get('/api/payments/pending')).body);
  assert.ok(!pend.includes(M.hivExam) && !pend.includes('Sérologie'));
});

test('pharmacien : prescription lisible pour la dispensation, rien d\'autre', async () => {
  assert.equal((await pharmacist.get(`/api/consultations/prescriptions/${prescriptionId}`)).body.items[0].drug_name, M.drug);
  assert.equal((await pharmacist.get('/api/lab/requests')).status, 403);
  assert.equal((await pharmacist.get(`/api/lab/requests/${labReq.id}`)).status, 403);
  assert.equal((await pharmacist.get(`/api/consultations/${consultation.id}`)).status, 403);
  const h = (await pharmacist.get(`/api/patients/${patient.id}/history`)).body;
  assert.equal(h.lab_requests, undefined); assert.equal(h.consultations, undefined);
});

test('laborantin : résultats d\'examens mais pas la consultation ni la prescription', async () => {
  assert.equal((await labtech.get(`/api/lab/requests/${labReq.id}`)).body.items[0].result_value, `${M.hiv}-2`);
  assert.equal((await labtech.get(`/api/consultations/${consultation.id}`)).status, 403);
  assert.equal((await labtech.get(`/api/consultations/prescriptions/${prescriptionId}`)).status, 403);
  const h = (await labtech.get(`/api/patients/${patient.id}/history`)).body;
  assert.equal(h.consultations, undefined); assert.equal(h.prescriptions, undefined);
});

test('rôle « lecture labo » (file d\'attente) : pas de résultat ni de renseignement clinique', async () => {
  const l = (await labviewer.get(`/api/lab/requests/${labReq.id}`)).body;
  assert.equal(l.results_restricted, true);
  assert.equal(l.items[0].result_value, undefined);
  assert.equal(l.notes, undefined);
  const h = (await labviewer.get(`/api/patients/${patient.id}/history`)).body;
  assert.equal(h.lab_requests[0].items[0].result_value, undefined);
});

test('journal : la correction de résultat est tracée sans la valeur', async () => {
  const log = (await admin.get('/api/audit?action=lab.result_correction')).body.items;
  assert.equal(log.length, 1);
  assert.ok(!JSON.stringify(log).includes(M.hiv));
});
