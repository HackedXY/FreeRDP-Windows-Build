// Données de démonstration : 5 employés, patients, stock, activité du jour.
// Usage : npm run demo   (sur une base fraîchement initialisée)
import http from 'node:http';
import { pool } from './pool.js';
import { migrate } from './migrate.js';
import { seed } from './seed.js';
import { createApp } from '../app.js';

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMoi2026';
const DEMO_PASSWORD = 'Sbs2026demo';

await migrate();
await seed();
const server = http.createServer(createApp()).listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;

function client() {
  let cookie = '';
  const call = async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, {
      method, headers: { 'Content-Type': 'application/json', 'X-SBS-Client': 'demo', cookie, ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${data?.error}`);
    return data;
  };
  return { get: (u) => call('GET', u), post: (u, b, h) => call('POST', u, b || {}, h), put: (u, b) => call('PUT', u, b) };
}

async function loginAs(username, password, newPassword) {
  const c = client();
  await c.post('/auth/login', { username, password });
  const me = await c.get('/auth/me');
  if (me.user.mustChangePassword) {
    await c.post('/auth/change-password', { currentPassword: password, newPassword });
    await c.post('/auth/login', { username, password: newPassword });
  }
  return c;
}

const admin = await loginAs('admin', ADMIN_PASSWORD, process.env.ADMIN_NEW_PASSWORD || 'Proprietaire2026');
const roles = await admin.get('/roles');
const role = (code) => roles.find((r) => r.code === code).id;
const staff = [
  ['Bakary', 'Keita', 'medecin', 'dr.keita', 'Médecin généraliste', '620 11 11 11'],
  ['Fatoumata', 'Diallo', 'infirmier', 'f.diallo', 'Infirmière', '620 22 22 22'],
  ['Mamadou', 'Condé', 'caissier', 'm.conde', 'Caissier', '620 33 33 33'],
  ['Aïssata', 'Touré', 'laborantin', 'a.toure', 'Technicienne de laboratoire', '620 44 44 44'],
  ['Ibrahima', 'Sylla', 'pharmacien', 'i.sylla', 'Pharmacien', '620 55 55 55'],
];
const users = {};
for (const [first, last, r, username, job, phone] of staff) {
  const { user } = await admin.post('/users', { first_name: first, last_name: last, role_id: role(r), username, job_title: job, phone, password: DEMO_PASSWORD });
  users[r] = await loginAs(username, DEMO_PASSWORD, `${DEMO_PASSWORD}x`);
  users[r].id = user.id;
}
const { medecin: doc, infirmier: nurse, caissier: cash, laborantin: lab, pharmacien: pharma } = users;

await pharma.post('/suppliers', { name: 'LABOREX Guinée', phone: '622 00 00 01', address: 'Conakry', products: 'Médicaments essentiels' });
await pharma.post('/suppliers', { name: 'PCG — Pharmacie Centrale de Guinée', phone: '622 00 00 02', address: 'Conakry' });
const products = [
  ['AMOX500', 'Amoxicilline 500 mg (gélule)', 'medicament', 150, 300, 20, 100, '2027-03-31'],
  ['PARA500', 'Paracétamol 500 mg (comprimé)', 'medicament', 50, 100, 50, 400, '2027-10-31'],
  ['ALU', 'Artéméther-Luméfantrine 80/480', 'medicament', 2500, 5000, 15, 60, '2026-11-15'],
  ['SRO', 'Sels de réhydratation orale', 'medicament', 500, 1000, 20, 12, '2027-01-31'],
  ['SER5', 'Seringue 5 ml', 'consommable', 300, 1000, 50, 300, '2029-01-01'],
  ['GANT', 'Gants d\'examen (paire)', 'consommable', 400, 1000, 100, 80, '2028-06-30'],
  ['CPR', 'Compresses stériles', 'produit_medical', 200, 500, 50, 150, '2028-12-31'],
];
const prodIds = {};
for (const [reference, name, category, pp, sp, min, qty, exp] of products) {
  const p = await pharma.post('/pharmacy/products', { reference, name, category, purchase_price: pp, sale_price: sp, min_threshold: min, initial_quantity: qty, lot_number: `L${reference}-01`, expiry_date: exp });
  prodIds[reference] = p.id;
}

const people = [
  ['Mariama', 'Camara', 'F', '1990-04-12', '621 10 20 30', 'Pénicilline'],
  ['Sékou', 'Traoré', 'M', '1978-09-02', '621 40 50 60', null],
  ['Kadiatou', 'Barry', 'F', '2016-01-20', '621 70 80 90', null],
  ['Alpha', 'Sow', 'M', '1965-06-15', '622 12 34 56', 'Aspirine'],
  ['Hawa', 'Kourouma', 'F', '1999-12-05', '622 65 43 21', null],
  ['Moussa', 'Cissé', 'M', '1988-03-30', '623 11 22 33', null],
];
const patients = [];
for (const [first_name, last_name, sex, birth_date, phone, allergies] of people) {
  patients.push(await nurse.post('/patients', { first_name, last_name, sex, birth_date, phone, allergies, address: 'Siguiri' }));
}

await cash.post('/cash/open', { opening_balance: 1000000 });
const acts = await doc.get('/acts');
const act = (code) => acts.find((a) => a.code === code).id;
const exams = await doc.get('/lab/exams');
const reasons = ['Fièvre et céphalées', 'Contrôle tension', 'Toux persistante', 'Douleurs abdominales', 'Plaie à la main'];
for (let i = 0; i < 5; i++) {
  const c = await nurse.post('/consultations', { patient_id: patients[i].id, doctor_id: doc.id, reason: reasons[i], temperature_c: 37 + (i % 3) * 0.7, bp_systolic: 120 + i * 5, bp_diastolic: 80, weight_kg: 60 + i * 4, acts: [{ act_id: act('CONS'), quantity: 1 }], status: 'en_attente' });
  await doc.put(`/consultations/${c.id}`, { status: 'en_cours', diagnosis: i === 0 ? 'Paludisme simple' : 'À préciser', observations: 'Examen clinique réalisé' });
  if (i === 0) {
    await doc.post(`/consultations/${c.id}/prescriptions`, { items: [{ product_id: prodIds.ALU, drug_name: 'Artéméther-Luméfantrine 80/480', dosage: '1 cp', frequency: '2 fois / jour', duration: '3 jours', quantity: 6 }] });
    const lr = await doc.post('/lab/requests', { patient_id: patients[0].id, consultation_id: c.id, exam_type_ids: [exams.find((e) => e.code === 'GE').id, exams.find((e) => e.code === 'NFS').id] });
    await lab.put(`/lab/requests/${lr.id}/results`, { complete: true, items: lr.items.map((it, k) => ({ id: it.id, result_value: k === 0 ? 'Positif (++)' : 'Normale', abnormal: k === 0 })) });
    await cash.post('/payments', { source_type: 'lab_request', source_id: lr.id, method: 'especes' });
  }
  if (i === 4) await nurse.post(`/consultations/${c.id}/acts`, { acts: [{ act_id: act('SUT'), quantity: 1 }, { act_id: act('PANS'), quantity: 1 }] });
  if (i < 4) {
    await doc.put(`/consultations/${c.id}`, { status: 'terminee' });
    await cash.post('/payments', { source_type: 'consultation', source_id: c.id, method: i === 2 ? 'orange_money' : 'especes', reference: i === 2 ? 'OM-7781234' : null });
  }
}
await pharma.post('/pharmacy/sales', { patient_id: patients[0].id, items: [{ product_id: prodIds.ALU, quantity: 6 }, { product_id: prodIds.PARA500, quantity: 10 }] });
await pharma.post('/pharmacy/sales', { customer_name: 'Client comptoir', items: [{ product_id: prodIds.SRO, quantity: 4 }] });
for (const s of (await cash.get('/pharmacy/sales?period=today')).items) {
  await cash.post('/payments', { source_type: 'pharmacy_sale', source_id: s.id, method: 'especes' });
}
await cash.post('/expenses', { category: 'Carburant', amount: 150000, reason: 'Carburant groupe électrogène', pay_from_cash: true });
await cash.post('/expenses', { category: 'Matériel', amount: 2000000, reason: 'Achat tensiomètre électronique et oxymètre' });
await nurse.post('/appointments', { patient_id: patients[1].id, doctor_id: doc.id, scheduled_at: new Date(Date.now() + 86400000).toISOString(), reason: 'Contrôle tension' });
await nurse.post('/appointments', { patient_id: patients[3].id, doctor_id: doc.id, scheduled_at: new Date(Date.now() + 3 * 86400000).toISOString(), reason: 'Suivi diabète' });

console.log('✔ Données de démonstration créées.');
console.log(`  Admin : admin / ${process.env.ADMIN_NEW_PASSWORD || 'Proprietaire2026'}`);
console.log(`  Employés : dr.keita, f.diallo, m.conde, a.toure, i.sylla — mot de passe ${DEMO_PASSWORD}x`);
server.close();
await pool.end();
