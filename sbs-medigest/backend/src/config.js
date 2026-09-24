import crypto from 'node:crypto';

const env = process.env;
const isProd = env.NODE_ENV === 'production';

function required(name, fallbackDev) {
  const v = env[name];
  if (v) return v;
  if (isProd) throw new Error(`Variable d'environnement manquante : ${name}`);
  return fallbackDev;
}

export const config = {
  isProd,
  port: Number(env.PORT || 4000),
  // Connexion applicative : rôle à privilèges restreints (sbs_app), jamais le propriétaire du schéma
  databaseUrl: required('DATABASE_URL', 'postgres://sbs_app:sbs_app@localhost:5432/sbs'),
  // Identifiants propriétaire (migrations). Absents du conteneur applicatif en production.
  migrationDatabaseUrl: env.MIGRATION_DATABASE_URL || (isProd ? null : 'postgres://sbs:sbs@localhost:5432/sbs'),
  sessionTtlHours: Number(env.SESSION_TTL_HOURS || 12),
  // Expiration après inactivité (minutes) ; la durée absolue SESSION_TTL_HOURS reste appliquée
  sessionIdleMinutes: Number(env.SESSION_IDLE_MINUTES || 30),
  // Double authentification obligatoire pour le compte propriétaire (par défaut en production)
  ownerMfaRequired: env.OWNER_MFA_REQUIRED ? env.OWNER_MFA_REQUIRED === 'true' : isProd,
  cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProd,
  uploadDir: env.UPLOAD_DIR || new URL('../uploads/', import.meta.url).pathname,
  staticDir: env.STATIC_DIR || null,
  corsOrigin: env.CORS_ORIGIN || null,
  timezone: env.TZ_CABINET || 'Africa/Conakry',
  // Surveillance des sauvegardes (alerte si échec ou absence de sauvegarde récente)
  backupMonitoring: env.BACKUP_MONITORING ? env.BACKUP_MONITORING === 'on' : isProd,
  backupMaxAgeHours: Number(env.BACKUP_MAX_AGE_HOURS || 26),
};

if (!Number.isFinite(config.sessionIdleMinutes) || config.sessionIdleMinutes < 1 || config.sessionIdleMinutes > config.sessionTtlHours * 60) {
  throw new Error('SESSION_IDLE_MINUTES doit être compris entre 1 et la durée absolue de session (SESSION_TTL_HOURS)');
}
// ------------------------------------------------------------------ clés
// Chargées à la première utilisation (et non au démarrage) : le service « migrate », qui
// détient les identifiants propriétaire de la base, n'a besoin ni de la clé de chiffrement
// médical ni de la clé HMAC du journal d'audit (séparation des secrets, N-1).
// Seul le conteneur applicatif les reçoit ; server.js vérifie leur présence au démarrage.
const keyCache = {};
function loadKey(name, devSeed, check) {
  if (keyCache[name]) return keyCache[name];
  const v = env[name];
  if (!v && isProd) throw new Error(`Variable d'environnement manquante : ${name}`);
  const key = Buffer.from(v || crypto.createHash('sha256').update(devSeed).digest('base64'), 'base64');
  check(key);
  keyCache[name] = key;
  return key;
}
Object.defineProperty(config, 'dataKey', {
  enumerable: false,
  // Clé 32 octets (base64) pour le chiffrement AES-256-GCM des données médicales
  get: () => loadKey('DATA_ENCRYPTION_KEY', 'sbs-dev-only-key', (k) => {
    if (k.length !== 32) throw new Error('DATA_ENCRYPTION_KEY doit être une clé de 32 octets encodée en base64');
  }),
});
Object.defineProperty(config, 'auditKey', {
  enumerable: false,
  // Clé HMAC de signature du journal d'audit (≥ 32 octets base64), hors base de données
  get: () => loadKey('AUDIT_HMAC_KEY', 'sbs-dev-only-audit-key', (k) => {
    if (k.length < 32) throw new Error('AUDIT_HMAC_KEY doit être une clé d\'au moins 32 octets encodée en base64');
  }),
});

/** Exige la clé HMAC du journal (application, procédure de récupération). */
export function requireAuditKey() { return config.auditKey; }
/** Exige les deux clés : appelé au démarrage de l'application (échec immédiat si absentes). */
export function requireRuntimeKeys() { config.dataKey; config.auditKey; }
