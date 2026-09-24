// Catalogue des permissions. Les rôles (y compris personnalisés) sont des
// ensembles de ces codes, configurables par l'administrateur.
export const PERMISSIONS = [
  ['dashboard.view', 'Tableau de bord', 'Voir le tableau de bord médical (patients, consultations, examens, rendez-vous)'],
  ['dashboard.finance', 'Tableau de bord', 'Voir les indicateurs financiers (recettes, caisse, dépenses, écarts) et le fil d\'activité'],

  ['patients.view', 'Patients', 'Voir les patients (identité)'],
  ['patients.view_medical', 'Patients', 'Voir le dossier médical complet'],
  ['patients.create', 'Patients', 'Créer un patient'],
  ['patients.update', 'Patients', 'Modifier un patient'],

  ['consultations.view', 'Consultations', 'Voir les consultations'],
  ['consultations.create', 'Consultations', 'Créer une consultation'],
  ['consultations.update', 'Consultations', 'Modifier / clôturer une consultation'],
  ['consultations.diagnose', 'Consultations', 'Saisir diagnostic et traitement'],
  ['consultations.vitals', 'Consultations', 'Saisir les constantes'],
  ['consultations.cancel', 'Consultations', 'Annuler une consultation'],
  ['prescriptions.create', 'Consultations', 'Rédiger des prescriptions'],
  ['certificates.create', 'Consultations', 'Rédiger des certificats médicaux'],
  ['acts.perform', 'Actes', 'Enregistrer des actes / soins'],
  ['acts.manage', 'Actes', 'Gérer le catalogue et les tarifs des actes'],

  ['appointments.view', 'Rendez-vous', 'Voir les rendez-vous'],
  ['appointments.manage', 'Rendez-vous', 'Créer / modifier / annuler des rendez-vous'],

  ['payments.view', 'Paiements', 'Voir les paiements et reçus'],
  ['payments.create', 'Paiements', 'Encaisser un paiement'],
  ['payments.update', 'Paiements', 'Modifier un paiement (avec motif)'],
  ['payments.cancel', 'Paiements', 'Annuler un paiement'],
  ['payments.refund', 'Paiements', 'Rembourser un paiement'],
  ['payments.discount', 'Paiements', 'Accorder une remise'],

  ['cash.operate', 'Caisse', 'Ouvrir / clôturer la caisse'],
  ['cash.view_all', 'Caisse', 'Consulter toutes les clôtures'],

  ['expenses.view', 'Dépenses', 'Voir les dépenses'],
  ['expenses.create', 'Dépenses', 'Enregistrer une dépense'],
  ['expenses.validate', 'Dépenses', 'Valider / refuser les dépenses'],
  ['expenses.disburse', 'Dépenses', 'Décaisser une dépense'],

  ['pharmacy.view', 'Pharmacie', 'Voir les produits et le stock'],
  ['pharmacy.manage', 'Pharmacie', 'Gérer les produits et les prix'],
  ['pharmacy.sell', 'Pharmacie', 'Vendre des médicaments'],
  ['pharmacy.cancel_sale', 'Pharmacie', 'Annuler une vente'],
  ['stock.move', 'Pharmacie', 'Entrées / sorties de stock'],
  ['stock.inventory', 'Pharmacie', 'Réaliser les inventaires'],

  ['suppliers.view', 'Fournisseurs', 'Voir les fournisseurs'],
  ['suppliers.manage', 'Fournisseurs', 'Gérer les fournisseurs'],

  ['lab.view', 'Laboratoire', 'Voir les demandes d\'examens'],
  ['lab.request', 'Laboratoire', 'Demander des examens'],
  ['lab.results', 'Laboratoire', 'Saisir les résultats'],
  ['lab.validate', 'Laboratoire', 'Valider les résultats d\'examens'],
  ['lab.manage', 'Laboratoire', 'Gérer le catalogue d\'examens et tarifs'],

  ['reports.view', 'Rapports', 'Consulter les rapports et statistiques'],
  ['reports.employee', 'Rapports', 'Consulter les rapports par employé'],

  ['alerts.view', 'Contrôle', 'Voir les alertes'],
  ['alerts.manage', 'Contrôle', 'Traiter les alertes'],
  ['audit.view', 'Contrôle', 'Consulter le journal d\'audit'],

  ['users.view', 'Administration', 'Voir les employés'],
  ['users.manage', 'Administration', 'Gérer les employés et leurs accès'],
  ['roles.manage', 'Administration', 'Gérer les rôles et permissions'],
  ['settings.manage', 'Administration', 'Gérer les paramètres'],
];

export const PERMISSION_CODES = PERMISSIONS.map(([code]) => code);

/**
 * Permissions à haut privilège : seul le propriétaire (super-administrateur)
 * peut les accorder, et seul lui peut gérer un compte qui les détient.
 */
export const HIGH_PRIVILEGE_PERMISSIONS = new Set([
  'users.manage', 'roles.manage', 'settings.manage', 'audit.view', 'alerts.manage', 'dashboard.finance',
  'reports.employee', 'cash.view_all', 'expenses.validate',
  'payments.update', 'payments.cancel', 'payments.refund',
]);

export const DEFAULT_ROLES = [
  {
    code: 'admin', name: 'Administrateur', superadmin: true,
    description: 'Propriétaire / administrateur — accès complet',
    permissions: PERMISSION_CODES,
  },
  {
    code: 'medecin', name: 'Médecin',
    description: 'Patients, consultations, diagnostic, prescription, examens',
    permissions: [
      'dashboard.view', 'patients.view', 'patients.view_medical', 'patients.create', 'patients.update',
      'consultations.view', 'consultations.create', 'consultations.update', 'consultations.diagnose',
      'consultations.vitals', 'consultations.cancel', 'prescriptions.create', 'certificates.create', 'acts.perform',
      'appointments.view', 'appointments.manage', 'lab.view', 'lab.request', 'pharmacy.view',
    ],
  },
  {
    code: 'infirmier', name: 'Infirmier',
    description: 'Patients, soins, constantes, actes autorisés',
    permissions: [
      'patients.view', 'patients.view_medical', 'patients.create', 'patients.update',
      'consultations.view', 'consultations.create', 'consultations.vitals', 'acts.perform',
      'appointments.view', 'appointments.manage', 'pharmacy.view',
    ],
  },
  {
    code: 'caissier', name: 'Caissier',
    description: 'Paiements, reçus, caisse',
    permissions: [
      'patients.view', 'patients.create', 'payments.view', 'payments.create', 'cash.operate',
      'expenses.view', 'expenses.create', 'expenses.disburse', 'appointments.view',
    ],
  },
  {
    code: 'laborantin', name: 'Laborantin',
    description: 'Examens et résultats',
    permissions: ['patients.view', 'lab.view', 'lab.results', 'lab.validate'],
  },
  {
    code: 'pharmacien', name: 'Pharmacien',
    description: 'Médicaments, ventes, stock',
    permissions: [
      'patients.view', 'pharmacy.view', 'pharmacy.manage', 'pharmacy.sell', 'stock.move',
      'stock.inventory', 'suppliers.view', 'suppliers.manage',
    ],
  },
];

export const DEFAULT_SETTINGS = {
  clinic: {
    name: 'CABINET MÉDICAL SBS',
    full_name: 'Cabinet Médical Sounkaro Bakary Souaré',
    address: 'Siguiri, République de Guinée',
    phone: '',
    currency: 'GNF',
    // Mentions légales à faire valider (docs/MODELES-DOCUMENTS.md)
    city: 'Siguiri',
    registration: '',      // n° d'autorisation d'ouverture / d'agrément du cabinet
    tax_id: '',            // NIF
    rccm: '',              // registre du commerce (si applicable)
    legal_mentions: '',    // pied de page des documents (ex. « Médecin conventionné… »)
  },
  // max_failed_logins : échecs tolérés par source (identifiant + IP) ; account_lock_threshold : toutes sources (blocage temporaire)
  security: { max_failed_logins: 5, lock_minutes: 15, failed_login_alert_threshold: 3, account_lock_threshold: 20 },
  finance: {
    expense_validation_threshold: 500000,  // dépenses ≥ ce montant : validation admin
    unusual_expense_threshold: 1500000,    // dépenses ≥ ce montant : alerte
    discount_alert_percent: 20,            // remise ≥ 20 % : alerte
    cash_tolerance: 0,                     // écart de caisse toléré sans alerte
    cash_expense_daily_limit: 1000000,     // total des dépenses payées en espèces par jour (au-delà : propriétaire uniquement)
    unpaid_sale_alert_hours: 24,           // vente de pharmacie non soldée depuis ce délai : alerte
  },
  stock: { expiry_warning_days: 60 },
  expense_categories: [
    'Médicaments', 'Matériel', 'Électricité', 'Eau', 'Carburant', 'Entretien', 'Fournitures', 'Salaires', 'Autres',
  ],
};
