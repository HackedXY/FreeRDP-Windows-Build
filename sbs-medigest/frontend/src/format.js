const nf = new Intl.NumberFormat('fr-FR');
export const gnf = (n) => `${nf.format(Math.round(Number(n) || 0)).replace(/[  ]/g, ' ')} GNF`;
export const num = (n) => nf.format(Number(n) || 0).replace(/[  ]/g, ' ');
export const date = (d) => (d ? new Date(d).toLocaleDateString('fr-FR') : '—');
export const time = (d) => (d ? new Date(d).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '');
export const dateTime = (d) => (d ? `${date(d)} ${time(d)}` : '—');
export const age = (birth) => {
  if (!birth) return '';
  const b = new Date(birth); const n = new Date();
  let a = n.getFullYear() - b.getFullYear();
  if (n < new Date(n.getFullYear(), b.getMonth(), b.getDate())) a--;
  return `${a} an${a > 1 ? 's' : ''}`;
};
export const todayISO = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
export const localInput = (d = new Date()) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

export const LABELS = {
  consultation_status: { en_attente: 'En attente', en_cours: 'En cours', terminee: 'Terminée', annulee: 'Annulée' },
  payment_status: { non_payee: 'Non payée', partielle: 'Partielle', payee: 'Payée' },
  pay_status: { valide: 'Valide', annule: 'Annulé', rembourse: 'Remboursé' },
  method: { especes: 'Espèces', orange_money: 'Orange Money', mtn_money: 'MTN Mobile Money', virement: 'Virement bancaire', autre: 'Autre' },
  source: { consultation: 'Consultation', lab_request: 'Laboratoire', pharmacy_sale: 'Pharmacie', act: 'Acte', other: 'Autre' },
  expense_status: { en_attente: 'En attente de validation', validee: 'Validée', refusee: 'Refusée', annulee: 'Annulée' },
  lab_status: { demandee: 'Demandée', en_cours: 'En cours', terminee: 'Terminée', annulee: 'Annulée' },
  appt_status: { planifie: 'Planifié', confirme: 'Confirmé', honore: 'Honoré', annule: 'Annulé', absent: 'Absent' },
  alert_status: { nouvelle: 'Nouvelle', en_verification: 'En vérification', resolue: 'Résolue', ignoree: 'Classée' },
  stock_reason: {
    achat: 'Achat', livraison: 'Livraison', retour: 'Retour', vente: 'Vente', utilisation: 'Utilisation', perte: 'Perte',
    expiration: 'Expiration', inventaire: 'Inventaire', annulation_vente: 'Annulation vente',
  },
  category: { medicament: 'Médicament', consommable: 'Consommable', produit_medical: 'Produit médical' },
  login_event: { login: 'Connexion', logout: 'Déconnexion', failed: 'Échec', locked: 'Verrouillé', disabled: 'Compte désactivé', mfa_failed: 'Échec du code 2FA', expired: 'Session expirée (inactivité)' },
  prescription_status: { en_attente: 'À délivrer', partielle: 'Partiellement délivrée', delivree: 'Délivrée' },
  invoice_status: { emise: 'Émise', partielle: 'Partiellement payée', payee: 'Payée', annulee: 'Annulée' },
  cert_type: { aptitude: 'Aptitude', inaptitude: 'Inaptitude', repos: 'Arrêt / repos', presence: 'Présence / consultation', autre: 'Autre' },
  lab_flag: { haut: '↑ élevé', bas: '↓ bas' },
};

export const TONE = {
  terminee: 'ok', payee: 'ok', valide: 'ok', validee: 'ok', honore: 'ok', resolue: 'ok', ok: 'ok', delivree: 'ok', emise: 'warn',
  en_cours: 'info', confirme: 'info', en_verification: 'info', partielle: 'warn', planifie: 'info',
  en_attente: 'warn', demandee: 'warn', nouvelle: 'warn', faible: 'warn', moyenne: 'warn',
  annulee: 'muted', annule: 'muted', ignoree: 'muted', absent: 'muted',
  non_payee: 'danger', refusee: 'danger', rembourse: 'danger', epuise: 'danger', haute: 'danger',
};

/**
 * Neutralise l'injection de formules (CSV/DDE) : une cellule texte commençant par
 * = + - @ (ou tabulation / retour chariot, y compris après des espaces) serait
 * interprétée comme une formule par Excel / LibreOffice ; elle est préfixée d'une apostrophe.
 * Les nombres (type number) restent des nombres.
 */
export function csvSafe(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  const s = String(v);
  return /^[\s]*[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

export function toCSV(rows, columns) {
  const esc = (v) => `"${csvSafe(v).replace(/"/g, '""')}"`;
  const head = columns.map((c) => esc(c.label)).join(';');
  const body = rows.map((r) => columns.map((c) => esc(typeof c.value === 'function' ? c.value(r) : r[c.value])).join(';'));
  return '﻿' + [head, ...body].join('\n');
}
export function download(filename, content, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
