// Données médicales : qui peut voir quoi, et (dé)chiffrement des champs structurés.
import { can } from './auth.js';
import { encrypt, decrypt } from './crypto.js';
import { tx } from '../db/pool.js';
import { audit } from './audit.js';

/** Motif, constantes, observations : personnel soignant. */
export const canClinical = (u) => can(u, 'patients.view_medical') || can(u, 'consultations.diagnose') || can(u, 'consultations.vitals');
/** Résultats d'examens : prescripteurs, laboratoire, soignants habilités. */
export const canLabResults = (u) => can(u, 'lab.results') || can(u, 'lab.request') || can(u, 'patients.view_medical');
/** Lignes de prescription : soignants, prescripteurs, pharmacie (dispensation). */
export const canPrescriptions = (u) => can(u, 'patients.view_medical') || can(u, 'prescriptions.create') || can(u, 'pharmacy.sell');
/** Motif / notes des rendez-vous. */
export const canAppointmentDetails = (u) => can(u, 'patients.view_medical') || can(u, 'appointments.manage');

export const encJson = (o) => encrypt(JSON.stringify(o));
export function decJson(v, fallback = null) {
  if (!v) return fallback;
  try { return JSON.parse(decrypt(v)); } catch { return fallback; }
}

export const VITALS = ['weight_kg', 'temperature_c', 'bp_systolic', 'bp_diastolic', 'heart_rate', 'spo2'];

/** Libellé non nominatif d'un patient pour les journaux, fils d'activité et notifications. */
export const patientRef = (p) => p?.patient_number || `patient #${p?.id ?? '?'}`;

/**
 * Journalise une consultation (lecture) de données médicales : qui, quel patient,
 * quel type d'accès, quand (horodatage de l'audit) et le résultat. Jamais le contenu
 * médical lui-même. L'entrée est chaînée et signée (HMAC) comme tout le journal.
 */
export async function logMedicalRead(req, { patientId = null, patientNumber = null, access, ref = null, count = null }) {
  const who = patientNumber || (patientId ? `patient #${patientId}` : 'plusieurs patients');
  await tx((db) => audit(db, req.ctx, {
    action: 'medical.read', entityType: 'patient', entityId: patientId,
    summary: `Lecture de données médicales — ${ACCESS_LABELS[access] || access} — ${who}${ref ? ` (${ref})` : ''}`,
    newValue: { access, ref, result: 'ok', ...(count !== null ? { count } : {}) },
    feed: false,
  }));
}

export const ACCESS_LABELS = {
  dossier: 'dossier patient',
  historique: 'historique du dossier',
  consultation: 'consultation',
  liste_consultations: 'liste des consultations',
  prescription: 'prescription',
  resultats_laboratoire: 'résultats de laboratoire',
  ordonnance_pdf: 'ordonnance (PDF)',
  certificat: 'certificat médical',
  certificat_pdf: 'certificat médical (PDF)',
  compte_rendu_pdf: 'compte rendu de laboratoire (PDF)',
};
