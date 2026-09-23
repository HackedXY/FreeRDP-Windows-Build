// Chiffre les données médicales existantes (nécessite DATA_ENCRYPTION_KEY).
import { encrypt } from '../../lib/crypto.js';

const isEnc = (v) => typeof v === 'string' && v.startsWith('enc:v1:');
const enc = (v) => (v === null || v === undefined || v === '' ? null : isEnc(v) ? v : encrypt(String(v)));
const encJson = (o) => (Object.values(o).some((v) => v !== null && v !== undefined && v !== '') ? encrypt(JSON.stringify(o)) : null);

export async function up(c) {
  const { rows: cons } = await c.query('SELECT id, reason, weight_kg, temperature_c, bp_systolic, bp_diastolic, heart_rate, spo2 FROM consultations');
  for (const r of cons) {
    const vitals = { weight_kg: r.weight_kg, temperature_c: r.temperature_c, bp_systolic: r.bp_systolic, bp_diastolic: r.bp_diastolic, heart_rate: r.heart_rate, spo2: r.spo2 };
    for (const k of Object.keys(vitals)) vitals[k] = vitals[k] === null ? null : Number(vitals[k]);
    await c.query('UPDATE consultations SET reason = $2, vitals = $3 WHERE id = $1', [r.id, enc(r.reason), encJson(vitals)]);
  }
  const { rows: items } = await c.query('SELECT id, result_value, result_text, abnormal FROM lab_request_items');
  for (const r of items) {
    await c.query('UPDATE lab_request_items SET result = $2 WHERE id = $1', [r.id, encJson({ value: r.result_value, text: r.result_text, abnormal: r.abnormal })]);
  }
  const { rows: lr } = await c.query('SELECT id, notes FROM lab_requests WHERE notes IS NOT NULL');
  for (const r of lr) await c.query('UPDATE lab_requests SET notes = $2 WHERE id = $1', [r.id, enc(r.notes)]);
  const { rows: pr } = await c.query('SELECT id, notes FROM prescriptions');
  for (const r of pr) {
    const { rows: lines } = await c.query(
      'SELECT product_id, drug_name, dosage, frequency, duration, quantity, instructions FROM prescription_items WHERE prescription_id = $1 ORDER BY id', [r.id]);
    await c.query('UPDATE prescriptions SET items = $2, notes = $3 WHERE id = $1', [r.id, encrypt(JSON.stringify(lines)), enc(r.notes)]);
  }
  const { rows: ap } = await c.query('SELECT id, reason, notes FROM appointments');
  for (const r of ap) await c.query('UPDATE appointments SET reason = $2, notes = $3 WHERE id = $1', [r.id, enc(r.reason), enc(r.notes)]);
}
