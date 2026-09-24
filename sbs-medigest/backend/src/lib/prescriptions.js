// Prescriptions : état de délivrance par ligne (quantité prescrite / délivrée / restante).
// Les lignes (médicaments, posologie) restent chiffrées en base ; seules les quantités
// délivrées, le produit, l'auteur et la date de délivrance sont stockés en clair.
import { decrypt } from './crypto.js';
import { decJson } from './medical.js';
import { badRequest, notFound } from './errors.js';

export const PRESCRIPTION_STATUS = { en_attente: 'En attente', partielle: 'Partiellement délivrée', delivree: 'Délivrée' };

export async function loadPrescription(db, id, { lock = false } = {}) {
  const { rows: [pr] } = await db.query(
    `SELECT pr.*, p.first_name || ' ' || p.last_name AS patient_name, p.patient_number, p.sex AS patient_sex, p.birth_date AS patient_birth_date,
       u.first_name || ' ' || u.last_name AS prescriber, u.job_title AS prescriber_title, u.professional_id AS prescriber_professional_id, c.number AS consultation_number
     FROM prescriptions pr JOIN patients p ON p.id = pr.patient_id LEFT JOIN users u ON u.id = pr.prescribed_by
     LEFT JOIN consultations c ON c.id = pr.consultation_id WHERE pr.id = $1${lock ? ' FOR UPDATE OF pr' : ''}`, [id]);
  if (!pr) throw notFound('Prescription introuvable');
  return pr;
}

/** Lignes déchiffrées + quantités délivrées (délivrances non annulées). */
export async function dispensingLines(db, pr) {
  const items = decJson(pr.items, []);
  const { rows } = await db.query(
    `SELECT d.*, p.name AS product_name, u.first_name || ' ' || u.last_name AS dispensed_by_name, s.number AS sale_number
     FROM prescription_dispensations d JOIN products p ON p.id = d.product_id JOIN users u ON u.id = d.dispensed_by
     JOIN pharmacy_sales s ON s.id = d.sale_id WHERE d.prescription_id = $1 ORDER BY d.id`, [pr.id]);
  return items.map((it, i) => {
    const line = i + 1;
    const deliveries = rows.filter((d) => d.line_no === line);
    const dispensed = deliveries.filter((d) => !d.cancelled_at).reduce((s, d) => s + d.quantity, 0);
    const prescribed = it.quantity ?? null;
    return {
      line, ...it,
      prescribed_quantity: prescribed,
      dispensed_quantity: dispensed,
      remaining_quantity: prescribed === null ? null : Math.max(prescribed - dispensed, 0),
      dispensations: deliveries.map((d) => ({
        id: d.id, quantity: d.quantity, product_id: d.product_id, product_name: d.product_name, sale_id: d.sale_id, sale_number: d.sale_number,
        dispensed_by: d.dispensed_by, dispensed_by_name: d.dispensed_by_name, dispensed_at: d.dispensed_at, cancelled_at: d.cancelled_at,
      })),
    };
  });
}

/** Statut global : délivrée si toutes les lignes le sont (quantité atteinte, ou au moins une délivrance sans quantité prescrite). */
export function computeStatus(lines) {
  const any = lines.some((l) => l.dispensed_quantity > 0);
  const all = lines.length > 0 && lines.every((l) => (l.prescribed_quantity === null || l.prescribed_quantity === 0
    ? l.dispensed_quantity > 0 || l.prescribed_quantity === 0
    : l.dispensed_quantity >= l.prescribed_quantity));
  return all ? 'delivree' : any ? 'partielle' : 'en_attente';
}

export async function refreshPrescriptionStatus(db, pr) {
  const lines = await dispensingLines(db, pr);
  const status = computeStatus(lines);
  if (status !== pr.status) await db.query('UPDATE prescriptions SET status = $2 WHERE id = $1', [pr.id, status]);
  return { status, lines };
}

/**
 * Enregistre la délivrance de lignes de prescription lors d'une vente.
 * @param items [{ product_id, quantity, prescription_line }]
 */
export async function recordDispensations(db, req, pr, saleId, items) {
  const lines = await dispensingLines(db, pr);
  const byLine = new Map();
  for (const it of items) {
    if (!it.prescription_line) continue;
    const l = lines[it.prescription_line - 1];
    if (!l) throw badRequest(`Ligne de prescription inconnue (${it.prescription_line}).`);
    const already = byLine.get(l.line) || 0;
    if (l.remaining_quantity !== null && already + it.quantity > l.remaining_quantity) {
      throw badRequest(`Ligne ${l.line} : quantité délivrée supérieure à la quantité restante (${l.remaining_quantity}).`);
    }
    byLine.set(l.line, already + it.quantity);
    await db.query(
      `INSERT INTO prescription_dispensations (prescription_id, line_no, product_id, quantity, sale_id, dispensed_by)
       VALUES ($1,$2,$3,$4,$5,$6)`, [pr.id, l.line, it.product_id, it.quantity, saleId, req.user.id]);
  }
  return refreshPrescriptionStatus(db, pr);
}

export const presentNotes = (pr) => decrypt(pr.notes);
