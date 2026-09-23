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
  databaseUrl: required('DATABASE_URL', 'postgres://sbs:sbs@localhost:5432/sbs'),
  // Identifiants propriétaire (migrations). Absents du conteneur applicatif en production.
  migrationDatabaseUrl: env.MIGRATION_DATABASE_URL || null,
  // Clé 32 octets (base64) pour le chiffrement AES-256-GCM des données médicales
  dataKey: Buffer.from(
    required('DATA_ENCRYPTION_KEY', crypto.createHash('sha256').update('sbs-dev-only-key').digest('base64')),
    'base64',
  ),
  sessionTtlHours: Number(env.SESSION_TTL_HOURS || 12),
  cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProd,
  uploadDir: env.UPLOAD_DIR || new URL('../uploads/', import.meta.url).pathname,
  staticDir: env.STATIC_DIR || null,
  corsOrigin: env.CORS_ORIGIN || null,
  timezone: env.TZ_CABINET || 'Africa/Conakry',
};

if (config.dataKey.length !== 32) {
  throw new Error('DATA_ENCRYPTION_KEY doit être une clé de 32 octets encodée en base64');
}
