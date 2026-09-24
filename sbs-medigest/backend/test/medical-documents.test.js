// Remédiation phase 2 : délivrance des prescriptions, ordonnance PDF, factures,
// certificats médicaux, laboratoire (références, anomalies, validation, compte rendu).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, adminAgent, employee, pool, closePools } from './helpers.js';
import { verificationCode } from '../src/lib/documents.js';

let admin, doctor, doctor2, nurse, cashier, pharmacist, labtech;
let patient, other, consultation, prescription, productA, productB;

const pdf = async (agent, url) => {
  const r = await agent.raw.get(url).buffer(true).parse((res, cb) => { const b = []; res.on('data', (c) => b.push(c)); res.on('end', () => cb(null, Buffer.concat(b))); });
  return r;
};
const reads = async (access) => (await pool.query(`SELECT * FROM audit_log WHERE action = 'medical.read' AND new_value->>'access' = $1`, [access])).rows;

before(async () => {
  await resetDb();
  admin = await adminAgent();
  doctor = await employee(admin, 'medecin', 'drdoc');
  doctor2 = await employee(admin, 'medecin', 'drdoc2');
  nurse = await employee(admin, 'infirmier', 'infdoc');
  cashier = await employee(admin, 'caissier', 'caidoc');
  pharmacist = await employee(admin, 'pharmacien', 'phadoc');
  labtech = await employee(admin, 'laborantin', 'labdoc');
  patient = (await nurse.post('/api/patients').send({ first_name: 'Ibrahima', last_name: 'Diallo', sex: 'M', birth_date: '1985-06-01' })).body;
  other = (await nurse.post('/api/patients').send({ first_name: 'Kadiatou', last_name: 'Bah', sex: 'F' })).body;
  productA = (await pharmacist.post('/api/pharmacy/products').send({ reference: 'AMOX', name: 'Amoxicilline 500', category: 'medicament', purchase_price: 200, sale_price: 1000, min_threshold: 0, initial_quantity: 100 })).body;
  productB = (await pharmacist.post('/api/pharmacy/products').send({ reference: 'PARA', name: 'Paracétamol 500', category: 'medicament', purchase_price: 50, sale_price: 300, min_threshold: 0, initial_quantity: 100 })).body;
  const acts = (await admin.get('/api/acts')).body;
  consultation = (await doctor.post('/api/consultations').send({ patient_id: patient.id, reason: 'Fièvre', acts: [{ act_id: acts[0].id }] })).body;
  await cashier.post('/api/cash/open').send({ opening_balance: 0 });
});
after(async () => { await closePools(); });

// ------------------------------------------------------------------ 9. prescriptions → pharmacie
test('prescription : numéro unique et statut initial', async () => {
  const r = await doctor.post(`/api/consultations/${consultation.id}/prescriptions`).send({
    notes: 'Boire beaucoup', items: [
      { product_id: productA.id, drug_name: 'Amoxicilline 500 mg', dosage: '1 gélule', frequency: '3 fois/jour', duration: '7 jours', quantity: 10, instructions: 'Pendant les repas' },
      { drug_name: 'Paracétamol 500 mg', dosage: '1 comprimé', frequency: 'si fièvre', duration: '5 jours', quantity: 5 },
    ],
  });
  assert.equal(r.status, 201);
  prescription = r.body.prescriptions.at(-1);
  assert.match(prescription.number, /^ORD-\d{4}-\d{6}$/);
  assert.equal(prescription.status, 'en_attente');
});

test('pharmacie : liste des prescriptions à délivrer sans contenu médical ; accès restreint', async () => {
  const list = await pharmacist.get('/api/pharmacy/prescriptions');
  assert.equal(list.status, 200);
  const row = list.body.items.find((x) => x.id === prescription.id);
  assert.ok(row);
  assert.equal(row.status, 'en_attente');
  assert.equal(row.items, undefined);
  assert.ok(!JSON.stringify(list.body).includes('Amoxicilline'), 'aucun médicament dans la liste');
  for (const a of [cashier, labtech, nurse]) assert.equal((await a.get('/api/pharmacy/prescriptions')).status, 403);
  // détail : pharmacie, prescripteurs et soignants ayant accès au dossier médical uniquement
  for (const a of [cashier, labtech]) assert.equal((await a.get(`/api/consultations/prescriptions/${prescription.id}`)).status, 403);
});

test('pharmacie : détail avec quantités prescrites / délivrées / restantes (lecture journalisée)', async () => {
  const r = await pharmacist.get(`/api/consultations/prescriptions/${prescription.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.items.length, 2);
  assert.deepEqual(r.body.items.map((l) => [l.line, l.prescribed_quantity, l.dispensed_quantity, l.remaining_quantity]), [[1, 10, 0, 10], [2, 5, 0, 5]]);
  assert.equal(r.body.items[0].dosage, '1 gélule');
  assert.equal((await reads('prescription')).filter((x) => x.user_id === pharmacist.user.id).length, 1);
});

let sale1;
test('délivrance partielle liée à la prescription : utilisateur, date, statut', async () => {
  const r = await pharmacist.post('/api/pharmacy/sales').send({
    prescription_id: prescription.id, items: [{ product_id: productA.id, quantity: 4, prescription_line: 1 }],
  });
  assert.equal(r.status, 201);
  sale1 = r.body;
  assert.equal(sale1.patient_id, patient.id, 'patient repris de la prescription');
  assert.equal(sale1.prescription.status, 'partielle');
  const d = (await pharmacist.get(`/api/consultations/prescriptions/${prescription.id}`)).body;
  assert.equal(d.status, 'partielle');
  const l1 = d.items[0];
  assert.deepEqual([l1.dispensed_quantity, l1.remaining_quantity], [4, 6]);
  assert.equal(l1.dispensations[0].dispensed_by, pharmacist.user.id);
  assert.ok(l1.dispensations[0].dispensed_at);
  assert.equal(l1.dispensations[0].sale_number, sale1.number);
});

test('délivrance : quantité supérieure au reste, ligne inconnue, autre patient → refus sans effet', async () => {
  const stock = (await pool.query('SELECT quantity FROM products WHERE id = $1', [productA.id])).rows[0].quantity;
  let r = await pharmacist.post('/api/pharmacy/sales').send({ prescription_id: prescription.id, items: [{ product_id: productA.id, quantity: 7, prescription_line: 1 }] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /restante/);
  r = await pharmacist.post('/api/pharmacy/sales').send({ prescription_id: prescription.id, items: [{ product_id: productA.id, quantity: 1, prescription_line: 9 }] });
  assert.equal(r.status, 400);
  r = await pharmacist.post('/api/pharmacy/sales').send({ prescription_id: prescription.id, patient_id: other.id, items: [{ product_id: productA.id, quantity: 1, prescription_line: 1 }] });
  assert.equal(r.status, 400);
  r = await pharmacist.post('/api/pharmacy/sales').send({ items: [{ product_id: productA.id, quantity: 1, prescription_line: 1 }] });
  assert.equal(r.status, 400);
  r = await pharmacist.post('/api/pharmacy/sales').send({ prescription_id: 999999, items: [{ product_id: productA.id, quantity: 1 }] });
  assert.equal(r.status, 404);
  assert.equal((await pool.query('SELECT quantity FROM products WHERE id = $1', [productA.id])).rows[0].quantity, stock, 'stock inchangé');
});

test('délivrances concurrentes du reste : jamais au-delà de la quantité prescrite', async () => {
  const results = await Promise.all([0, 1, 2].map(() => pharmacist.post('/api/pharmacy/sales').send({
    prescription_id: prescription.id, items: [{ product_id: productA.id, quantity: 6, prescription_line: 1 }],
  })));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  const { rows: [t] } = await pool.query('SELECT sum(quantity)::int AS n FROM prescription_dispensations WHERE prescription_id = $1 AND line_no = 1 AND cancelled_at IS NULL', [prescription.id]);
  assert.equal(t.n, 10);
});

test('délivrance complète → statut « délivrée » ; annulation de vente → quantités à nouveau à délivrer', async () => {
  const r = await pharmacist.post('/api/pharmacy/sales').send({ prescription_id: prescription.id, items: [{ product_id: productB.id, quantity: 5, prescription_line: 2 }] });
  assert.equal(r.status, 201);
  assert.equal(r.body.prescription.status, 'delivree');
  assert.equal((await pharmacist.get('/api/pharmacy/prescriptions')).body.items.some((x) => x.id === prescription.id), false, 'plus à délivrer');
  assert.equal((await admin.post(`/api/pharmacy/sales/${r.body.id}/cancel`).send({ reason: 'Erreur de produit' })).status, 200);
  const d = (await pharmacist.get(`/api/consultations/prescriptions/${prescription.id}`)).body;
  assert.equal(d.status, 'partielle');
  assert.equal(d.items[1].remaining_quantity, 5);
  assert.ok(d.items[1].dispensations[0].cancelled_at);
  const { rows } = await pool.query(`SELECT new_value FROM audit_log WHERE action = 'prescription.dispense' AND entity_id = $1`, [String(prescription.id)]);
  assert.ok(rows.length >= 3);
  assert.ok(!JSON.stringify(rows).includes('Paracétamol 500 mg'), 'pas de libellé médical dans l\'audit');
});

// ------------------------------------------------------------------ 10. ordonnance PDF
test('ordonnance PDF : générée pour les rôles habilités, lecture journalisée, code de vérification', async () => {
  for (const a of [doctor, pharmacist, nurse]) {
    const r = await pdf(a, `/api/consultations/prescriptions/${prescription.id}/pdf`);
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'application/pdf');
    assert.equal(r.body.subarray(0, 5).toString(), '%PDF-');
    assert.ok(r.body.length > 1500);
  }
  assert.equal((await cashier.get(`/api/consultations/prescriptions/${prescription.id}/pdf`)).status, 403);
  assert.ok((await reads('ordonnance_pdf')).length >= 3);
  const code = verificationCode('ordonnance', prescription.number, prescription.created_at);
  let v = (await cashier.get(`/api/documents/verify?type=ordonnance&number=${prescription.number}&code=${code}`)).body;
  assert.deepEqual([v.valid, v.number, v.patient_number], [true, prescription.number, patient.patient_number]);
  assert.equal(v.items, undefined);
  v = (await cashier.get(`/api/documents/verify?type=ordonnance&number=${prescription.number}&code=AAAA-BBBB-CCCC`)).body;
  assert.equal(v.valid, false);
});

// ------------------------------------------------------------------ 11. factures
let invoice, lab;
test('facture : création à partir des éléments facturables du patient', async () => {
  const exams = (await doctor.get('/api/lab/exams')).body;
  lab = (await doctor.post('/api/lab/requests').send({ patient_id: patient.id, consultation_id: consultation.id, exam_type_ids: [exams[0].id, exams[1].id] })).body;
  const billable = (await cashier.get(`/api/invoices/billable?patient_id=${patient.id}`)).body;
  const cons = billable.find((b) => b.source_type === 'consultation');
  const labItem = billable.find((b) => b.source_type === 'lab_request');
  assert.ok(cons && labItem);
  assert.equal((await doctor.post('/api/invoices').send({ patient_id: patient.id, items: [{ source_type: 'consultation', source_id: consultation.id }] })).status, 403);
  const r = await cashier.post('/api/invoices').send({ patient_id: patient.id, items: [{ source_type: 'consultation', source_id: consultation.id }, { source_type: 'lab_request', source_id: lab.id }], notes: 'Merci' });
  assert.equal(r.status, 201);
  invoice = r.body;
  assert.match(invoice.number, /^FAC-\d{4}-\d{6}$/);
  assert.equal(invoice.lines.length, 2);
  assert.equal(invoice.total, cons.amount + labItem.amount);
  assert.deepEqual([invoice.paid, invoice.discount, invoice.remaining, invoice.status], [0, 0, invoice.total, 'emise']);
  // un élément ne figure que sur une facture active ; pas d'élément d'un autre patient
  assert.equal((await cashier.post('/api/invoices').send({ patient_id: patient.id, items: [{ source_type: 'lab_request', source_id: lab.id }] })).status, 409);
  assert.equal((await cashier.post('/api/invoices').send({ patient_id: other.id, items: [{ source_type: 'consultation', source_id: consultation.id }] })).status, 400);
});

test('facture : remise, montant payé, solde restant, statut et historique des paiements', async () => {
  // paiement ordinaire avec remise sur la consultation (le système de reçus existant est conservé)
  const consLine = invoice.lines.find((l) => l.source_type === 'consultation');
  const p1 = await admin.post('/api/payments').send({ source_type: 'consultation', source_id: consultation.id, amount: consLine.amount, discount: 10000, method: 'especes' });
  assert.equal(p1.status, 201);
  assert.ok(p1.body.receipt_number);
  let inv = (await cashier.get(`/api/invoices/${invoice.id}`)).body;
  assert.deepEqual([inv.discount, inv.paid, inv.status], [10000, consLine.amount - 10000, 'partielle']);
  assert.equal(inv.remaining, inv.total - consLine.amount);
  // règlement partiel puis solde via la facture (un paiement + un reçu par ligne)
  const part = await cashier.post(`/api/invoices/${invoice.id}/pay`).send({ amount: 5000, method: 'orange_money', reference: 'OM-FAC-1' });
  assert.equal(part.status, 201);
  assert.equal(part.body.invoice.remaining, inv.remaining - 5000);
  assert.equal((await cashier.post(`/api/invoices/${invoice.id}/pay`).send({ amount: 10 ** 9, method: 'especes' })).status, 400);
  const rest = await cashier.post(`/api/invoices/${invoice.id}/pay`).send({ method: 'especes' });
  assert.equal(rest.status, 201);
  inv = rest.body.invoice;
  assert.deepEqual([inv.remaining, inv.status], [0, 'payee']);
  assert.equal(inv.paid + inv.discount, inv.total);
  assert.equal(inv.payments.length, 3);
  assert.ok(inv.payments.every((p) => p.receipt_number));
  assert.equal((await cashier.post(`/api/invoices/${invoice.id}/pay`).send({ method: 'especes' })).status, 400, 'déjà soldée');
  const r = await pdf(cashier, `/api/invoices/${invoice.id}/pdf`);
  assert.equal(r.status, 200);
  assert.equal(r.body.subarray(0, 5).toString(), '%PDF-');
  // reçu d'un paiement de facture toujours disponible
  assert.equal((await pdf(cashier, `/api/payments/${inv.payments[2].id}/receipt.pdf`)).status, 200);
});

test('facture : annulation tracée, lignes libérées, paiements et reçus intacts', async () => {
  assert.equal((await cashier.post(`/api/invoices/${invoice.id}/cancel`).send({ reason: 'Erreur de regroupement' })).status, 403);
  const r = await admin.post(`/api/invoices/${invoice.id}/cancel`).send({ reason: 'Erreur de regroupement' });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'annulee');
  assert.equal(r.body.payments.filter((p) => p.status === 'valide').length, 3);
  const again = await cashier.post('/api/invoices').send({ patient_id: patient.id, items: [{ source_type: 'lab_request', source_id: lab.id }] });
  assert.equal(again.status, 201);
  assert.equal(again.body.status, 'payee', 'élément déjà réglé');
  await assert.rejects(pool.query('DELETE FROM invoices WHERE id = $1', [invoice.id]), /interdite/);
});

// ------------------------------------------------------------------ 12. certificats
let cert;
test('certificat médical : création réservée aux médecins, contenu chiffré', async () => {
  const body = { patient_id: patient.id, consultation_id: consultation.id, cert_type: 'repos', body: 'Son état de santé nécessite un repos à domicile.', rest_days: 3, start_date: '2031-01-10', end_date: '2031-01-12' };
  for (const a of [nurse, cashier, pharmacist]) assert.equal((await a.post('/api/documents/certificates').send(body)).status, 403);
  assert.equal((await doctor.post('/api/documents/certificates').send({ ...body, rest_days: null })).status, 400);
  const r = await doctor.post('/api/documents/certificates').send(body);
  assert.equal(r.status, 201);
  cert = r.body;
  assert.match(cert.number, /^CERT-\d{4}-\d{6}$/);
  assert.equal(cert.rest_days, 3);
  const { rows: [raw] } = await pool.query('SELECT content FROM medical_certificates WHERE id = $1', [cert.id]);
  assert.match(raw.content, /^enc:v1:/);
  assert.ok(!raw.content.includes('repos'));
});

test('certificat médical : consultation et PDF selon les permissions, lecture journalisée', async () => {
  assert.equal((await nurse.get(`/api/documents/certificates/${cert.id}`)).body.body, cert.body, 'dossier médical : lecture autorisée');
  for (const a of [cashier, pharmacist, labtech]) {
    assert.equal((await a.get(`/api/documents/certificates/${cert.id}`)).status, 403);
    assert.equal((await a.get(`/api/documents/certificates/${cert.id}/pdf`)).status, 403);
  }
  const list = (await doctor.get(`/api/documents/certificates?patient_id=${patient.id}`)).body;
  assert.equal(list.length, 1);
  assert.equal(list[0].body, undefined, 'liste sans contenu');
  const r = await pdf(doctor, `/api/documents/certificates/${cert.id}/pdf`);
  assert.equal(r.status, 200);
  assert.equal(r.body.subarray(0, 5).toString(), '%PDF-');
  assert.equal((await reads('certificat_pdf')).length, 1);
  const code = verificationCode('certificat', cert.number, cert.issued_at);
  assert.equal((await cashier.get(`/api/documents/verify?type=certificat&number=${cert.number}&code=${code}`)).body.valid, true);
});

test('certificat médical : annulation par le médecin signataire uniquement', async () => {
  assert.equal((await doctor2.post(`/api/documents/certificates/${cert.id}/cancel`).send({ reason: 'Erreur' })).status, 403);
  const r = await doctor.post(`/api/documents/certificates/${cert.id}/cancel`).send({ reason: 'Erreur de dates' });
  assert.equal(r.status, 200);
  assert.ok(r.body.cancelled_at);
  const v = (await cashier.get(`/api/documents/verify?type=certificat&number=${cert.number}&code=${verificationCode('certificat', cert.number, cert.issued_at)}`)).body;
  assert.equal(v.cancelled, true);
});

// ------------------------------------------------------------------ 13. laboratoire
let exam, req2;
test('laboratoire : valeurs de référence et unité au catalogue', async () => {
  assert.equal((await admin.post('/api/lab/exams').send({ name: 'Hémoglobine', price: 15000, unit: 'g/dL', ref_min: 15, ref_max: 12 })).status, 400);
  const r = await admin.post('/api/lab/exams').send({ code: 'HB', name: 'Hémoglobine', price: 15000, unit: 'g/dL', ref_min: 12, ref_max: 16, reference_range: '12 – 16' });
  assert.equal(r.status, 201);
  exam = r.body;
  assert.deepEqual([exam.ref_min, exam.ref_max, exam.unit], [12, 16, 'g/dL']);
  const gly = (await admin.get('/api/lab/exams')).body.find((e) => e.code === 'GLY');
  assert.deepEqual([gly.ref_min, gly.ref_max], [0.7, 1.1], 'références des examens existants');
});

test('laboratoire : indication automatique des valeurs anormales (chiffrée en base)', async () => {
  const tdr = (await admin.get('/api/lab/exams')).body.find((e) => e.code === 'TDR');
  req2 = (await doctor.post('/api/lab/requests').send({ patient_id: patient.id, exam_type_ids: [exam.id, tdr.id] })).body;
  const hb = req2.items.find((i) => i.exam_type_id === exam.id);
  const t = req2.items.find((i) => i.exam_type_id === tdr.id);
  assert.deepEqual([hb.ref_min, hb.ref_max, hb.unit], [12, 16, 'g/dL']);
  let r = await labtech.put(`/api/lab/requests/${req2.id}/results`).send({ items: [{ id: hb.id, result_value: '9,5' }, { id: t.id, result_value: 'Positif', abnormal: true }] });
  assert.equal(r.status, 200);
  let items = r.body.items;
  assert.deepEqual([items.find((i) => i.id === hb.id).abnormal, items.find((i) => i.id === hb.id).flag], [true, 'bas']);
  assert.deepEqual([items.find((i) => i.id === t.id).abnormal, items.find((i) => i.id === t.id).flag, items.find((i) => i.id === t.id).abnormal_manual], [true, null, true]);
  assert.equal(items.find((i) => i.id === hb.id).abnormal_manual, false, 'anomalie calculée, non forcée');
  r = await labtech.put(`/api/lab/requests/${req2.id}/results`).send({ items: [{ id: hb.id, result_value: '13.1' }, { id: t.id, result_value: 'Positif', abnormal: true }], complete: true });
  items = r.body.items;
  assert.deepEqual([items.find((i) => i.id === hb.id).abnormal, items.find((i) => i.id === hb.id).flag], [false, null]);
  assert.equal(r.body.status, 'terminee');
  const { rows: [raw] } = await pool.query('SELECT result FROM lab_request_items WHERE id = $1', [hb.id]);
  assert.match(raw.result, /^enc:v1:/);
});

test('laboratoire : validation par une personne habilitée ; résultats validés figés', async () => {
  assert.equal((await doctor.post(`/api/lab/requests/${req2.id}/validate`)).status, 403);
  let r = await labtech.post(`/api/lab/requests/${req2.id}/validate`);
  assert.equal(r.status, 200);
  assert.ok(r.body.validated_at);
  assert.equal(r.body.validated_by, labtech.user.id);
  assert.equal((await labtech.post(`/api/lab/requests/${req2.id}/validate`)).status, 400, 'déjà validés');
  // correction par un utilisateur sans droit de validation : refusée
  const tech2 = await employee(admin, 'laborantin', 'labsansvalid');
  await admin.put(`/api/users/${tech2.user.id}`).send({ permission_overrides: [{ permission_code: 'lab.validate', granted: false }] });
  const hb = r.body.items.find((i) => i.exam_type_id === exam.id);
  assert.equal((await tech2.put(`/api/lab/requests/${req2.id}/results`).send({ items: [{ id: hb.id, result_value: '18' }], complete: true })).status, 403);
  // correction par le valideur : la validation est levée et tracée
  r = await labtech.put(`/api/lab/requests/${req2.id}/results`).send({ items: [{ id: hb.id, result_value: '18' }], complete: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.validated_at, null);
  assert.equal(r.body.items.find((i) => i.id === hb.id).flag, 'haut');
  const { rows } = await pool.query(`SELECT action FROM audit_log WHERE entity_type = 'lab_request' AND entity_id = $1 ORDER BY id`, [String(req2.id)]);
  assert.ok(['lab.validate', 'lab.result_correction', 'lab.validation_reset'].every((a) => rows.some((x) => x.action === a)));
});

test('laboratoire : compte rendu PDF (résultats saisis), accès restreint, code de vérification', async () => {
  const pending = (await doctor.post('/api/lab/requests').send({ patient_id: patient.id, exam_type_ids: [exam.id] })).body;
  assert.equal((await labtech.get(`/api/lab/requests/${pending.id}/report.pdf`)).status, 400);
  assert.equal((await cashier.get(`/api/lab/requests/${req2.id}/report.pdf`)).status, 403);
  await labtech.post(`/api/lab/requests/${req2.id}/validate`);
  for (const a of [labtech, doctor]) {
    const r = await pdf(a, `/api/lab/requests/${req2.id}/report.pdf`);
    assert.equal(r.status, 200);
    assert.equal(r.body.subarray(0, 5).toString(), '%PDF-');
  }
  assert.ok((await reads('compte_rendu_pdf')).length >= 2);
  const full = (await labtech.get(`/api/lab/requests/${req2.id}`)).body;
  const code = verificationCode('compte_rendu', full.number, full.validated_at);
  assert.equal((await cashier.get(`/api/documents/verify?type=compte_rendu&number=${full.number}&code=${code}`)).body.valid, true);
});

test('intégrité : journal d\'audit toujours chaîné et signé après les nouveaux parcours', async () => {
  const v = (await admin.get('/api/audit/verify')).body;
  assert.equal(v.ok, true);
});
