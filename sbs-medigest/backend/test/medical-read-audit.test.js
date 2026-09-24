// Remédiation phase 1 : journalisation des lectures de dossiers médicaux
// (qui, quel patient, quel type d'accès, quand, résultat) sans aucune donnée médicale,
// dans le journal chaîné et signé (HMAC).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, adminAgent, employee, pool, closePools } from './helpers.js';

let admin, doctor, cashier, labtech, patient, consultation, labReq;
const SECRET_TEXTS = ['Drépanocytose', 'Arachides', 'Crise vaso-occlusive', 'Paludisme grave', 'Hb 7,2'];

const reads = async (userId) => (await pool.query(
  `SELECT a.*, s.sig FROM audit_log a LEFT JOIN audit_signatures s ON s.audit_id = a.id
   WHERE a.action = 'medical.read' AND a.user_id = $1 ORDER BY a.id`, [userId])).rows;

before(async () => {
  await resetDb();
  admin = await adminAgent();
  doctor = await employee(admin, 'medecin', 'drlecture');
  cashier = await employee(admin, 'caissier', 'cailecture');
  labtech = await employee(admin, 'laborantin', 'lablecture');
  patient = (await doctor.post('/api/patients').send({
    first_name: 'Fanta', last_name: 'Keita', sex: 'F', medical_history: SECRET_TEXTS[0], allergies: SECRET_TEXTS[1],
  })).body;
  consultation = (await doctor.post('/api/consultations').send({ patient_id: patient.id, reason: SECRET_TEXTS[2], diagnosis: SECRET_TEXTS[3] })).body;
  const exams = (await doctor.get('/api/lab/exams')).body;
  labReq = (await doctor.post('/api/lab/requests').send({ patient_id: patient.id, exam_type_ids: [exams[0].id] })).body;
  await labtech.put(`/api/lab/requests/${labReq.id}/results`).send({ items: [{ id: labReq.items[0].id, result_value: SECRET_TEXTS[4] }], complete: true });
});
after(async () => { await closePools(); });

test('lecture du dossier, de l\'historique, d\'une consultation et de résultats : chaque accès est journalisé', async () => {
  assert.equal((await doctor.get(`/api/patients/${patient.id}`)).status, 200);
  assert.equal((await doctor.get(`/api/patients/${patient.id}/history`)).status, 200);
  assert.equal((await doctor.get(`/api/consultations/${consultation.id}`)).status, 200);
  assert.equal((await labtech.get(`/api/lab/requests/${labReq.id}`)).status, 200);
  const rows = await reads(doctor.user.id);
  assert.deepEqual(rows.map((r) => r.new_value.access), ['dossier', 'historique', 'consultation']);
  for (const r of rows) {
    assert.equal(r.entity_type, 'patient');
    assert.equal(r.entity_id, String(patient.id), 'patient concerné');
    assert.equal(r.username, 'drlecture', 'utilisateur');
    assert.ok(r.created_at instanceof Date, 'date/heure');
    assert.equal(r.new_value.result, 'ok', 'résultat');
    assert.match(r.summary, new RegExp(patient.patient_number));
  }
  assert.equal(rows[2].new_value.ref, consultation.number);
  const lab = await reads(labtech.user.id);
  assert.equal(lab.length, 1);
  assert.equal(lab[0].new_value.access, 'resultats_laboratoire');
});

test('le journal ne contient aucune donnée médicale ni l\'identité complète du patient', async () => {
  const { rows } = await pool.query(`SELECT summary, old_value, new_value, reason FROM audit_log WHERE action = 'medical.read'`);
  const dump = JSON.stringify(rows);
  for (const t of SECRET_TEXTS) assert.ok(!dump.includes(t), t);
  assert.ok(!dump.includes('Keita'), 'pas de nom du patient');
});

test('sans accès aux données médicales, aucune lecture médicale n\'est journalisée (refus tracé à part)', async () => {
  const r = await cashier.get(`/api/patients/${patient.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.medical_restricted, true);
  assert.equal((await reads(cashier.user.id)).length, 0);
  // accès refusé : tracé par access.denied (résultat « refusé »)
  assert.equal((await cashier.get(`/api/consultations/${consultation.id}`)).status, 403);
  const { rows } = await pool.query(`SELECT 1 FROM audit_log WHERE action = 'access.denied' AND user_id = $1`, [cashier.user.id]);
  assert.ok(rows.length >= 1);
});

test('liste des consultations avec motifs déchiffrés : un accès journalisé (nombre d\'éléments, sans détail)', async () => {
  const before = (await reads(doctor.user.id)).length;
  assert.equal((await doctor.get('/api/consultations')).status, 200);
  const rows = await reads(doctor.user.id);
  assert.equal(rows.length, before + 1);
  const last = rows[rows.length - 1];
  assert.equal(last.new_value.access, 'liste_consultations');
  assert.equal(last.new_value.count, 1);
});

test('intégrité : les entrées de lecture sont chaînées et signées ; le fil d\'activité n\'en est pas pollué', async () => {
  const rows = await reads(doctor.user.id);
  assert.ok(rows.every((r) => r.hash && /^[0-9a-f]{64}$/.test(r.sig)));
  const v = (await admin.get('/api/audit/verify')).body;
  assert.equal(v.ok, true);
  const d = (await admin.get('/api/dashboard')).body;
  assert.ok(d.activity.every((a) => a.action !== 'medical.read'));
  // append-only : impossible d'effacer la trace d'une lecture
  await assert.rejects(pool.query(`DELETE FROM audit_log WHERE action = 'medical.read'`));
});
