import { query } from '../db/pool.js';
import { config } from '../config.js';
import { sha256 } from './crypto.js';
import { forbidden, unauthorized, HttpError } from './errors.js';
import { PERMISSION_CODES } from './permissions.js';
import { audit } from './audit.js';
import { raiseAlert } from './notify.js';

export const SESSION_COOKIE = 'sbs_session';

export async function loadPermissions(db, userId, role) {
  if (role.is_superadmin) return new Set(PERMISSION_CODES);
  const { rows } = await db.query(
    `SELECT permission_code FROM role_permissions WHERE role_id = $1
     UNION
     SELECT permission_code FROM user_permissions WHERE user_id = $2 AND granted
     EXCEPT
     SELECT permission_code FROM user_permissions WHERE user_id = $2 AND NOT granted`,
    [role.id, userId],
  );
  return new Set(rows.map((r) => r.permission_code));
}

/** Charge l'utilisateur à partir du jeton de session (cookie ou en-tête). */
export async function userFromToken(token) {
  if (!token) return null;
  return userFromSessionId(sha256(token));
}

/** Charge l'utilisateur à partir de l'identifiant (haché) d'une session valide. */
export async function userFromSessionId(sid) {
  if (!sid) return null;
  const { rows } = await query(
    `SELECT s.id AS session_id, s.last_seen_at, s.expires_at, u.id, u.username, u.first_name, u.last_name, u.site_id,
            u.must_change_password, u.status, u.job_title, u.employee_number,
            r.id AS role_id, r.code AS role_code, r.name AS role_name, r.is_superadmin
     FROM sessions s JOIN users u ON u.id = s.user_id JOIN roles r ON r.id = u.role_id
     WHERE s.id = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [sid],
  );
  const row = rows[0];
  if (!row || row.status !== 'active') return null;
  if (Date.now() - new Date(row.last_seen_at).getTime() > 60_000) {
    query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [sid]).catch(() => {});
  }
  const permissions = await loadPermissions({ query }, row.id, { id: row.role_id, is_superadmin: row.is_superadmin });
  return {
    id: row.id,
    sessionId: row.session_id,
    sessionExpiresAt: new Date(row.expires_at).getTime(),
    username: row.username,
    firstName: row.first_name,
    lastName: row.last_name,
    fullName: `${row.first_name} ${row.last_name}`,
    employeeNumber: row.employee_number,
    jobTitle: row.job_title,
    siteId: row.site_id,
    roleId: row.role_id,
    roleCode: row.role_code,
    roleName: row.role_name,
    superadmin: row.is_superadmin,
    mustChangePassword: row.must_change_password,
    permissions,
  };
}

export function tokenFromRequest(req) {
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) return h.slice(7);
  return req.cookies?.[SESSION_COOKIE] || null;
}

export function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.cookieSecure,
    path: '/',
    maxAge: config.sessionTtlHours * 3600 * 1000,
  };
}

/** Middleware : attache req.user si une session valide existe. */
export async function attachUser(req, _res, next) {
  try {
    req.user = await userFromToken(tokenFromRequest(req));
    req.ctx.user = req.user;
    next();
  } catch (e) { next(e); }
}

const PASSWORD_FREE_PATHS = ['/api/auth/me', '/api/auth/logout', '/api/auth/change-password'];

export function requireAuth(req, _res, next) {
  if (!req.user) return next(unauthorized());
  if (req.user.mustChangePassword && !PASSWORD_FREE_PATHS.includes(req.originalUrl.split('?')[0])) {
    const err = new HttpError(403, 'Vous devez changer votre mot de passe temporaire.');
    err.code = 'PASSWORD_CHANGE_REQUIRED';
    return next(err);
  }
  next();
}

export function can(user, perm) {
  return !!user && (user.superadmin || user.permissions.has(perm));
}

/**
 * Exige au moins une des permissions. Un refus est tracé dans le journal et
 * déclenche une alerte « Tentative d'accès à une fonction non autorisée ».
 */
export function requirePerm(...perms) {
  return async (req, _res, next) => {
    if (perms.some((p) => can(req.user, p))) return next();
    try {
      await reportDenied(req, perms.join(' | '));
    } catch (e) { /* ne bloque pas la réponse */ }
    next(forbidden(`Accès non autorisé (permission requise : ${perms.join(' ou ')})`));
  };
}

export async function reportDenied(req, what) {
  const db = { query };
  await audit(db, req.ctx, {
    action: 'access.denied', entityType: 'permission', entityId: what,
    summary: `Accès refusé : ${req.method} ${req.originalUrl}`, feed: false,
  });
  await raiseAlert(db, req.ctx, {
    category: 'systeme', type: 'acces_non_autorise', severity: 'haute',
    title: `Tentative d'accès non autorisé — ${req.user.fullName}`,
    details: { message: `${req.method} ${req.originalUrl} (permission : ${what})`, user: req.user.username },
    userId: req.user.id, dedupeKey: `denied:${req.user.id}:${what}`,
  });
  req.ctx.flush();
}

export function assertCan(req, perm) {
  if (!can(req.user, perm)) throw forbidden(`Accès non autorisé (permission requise : ${perm})`);
}
