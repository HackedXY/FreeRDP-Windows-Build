import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { query, tx } from '../db/pool.js';
import { config } from '../config.js';
import { ah, parse, badRequest, HttpError, unauthorized } from '../lib/errors.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { SESSION_COOKIE, cookieOptions, requireAuth } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { raiseAlert } from '../lib/notify.js';
import { getSettings } from '../lib/settings.js';

const router = Router();
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 10);
export const BCRYPT_ROUNDS = 12;

export function checkPasswordPolicy(password, username) {
  if (typeof password !== 'string' || password.length < 8) return 'Le mot de passe doit contenir au moins 8 caractères.';
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return 'Le mot de passe doit contenir des lettres et des chiffres.';
  if (username && password.toLowerCase().includes(username.toLowerCase())) return 'Le mot de passe ne doit pas contenir l\'identifiant.';
  return null;
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: process.env.NODE_ENV === 'test' ? 1000 : 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives de connexion. Réessayez plus tard.' },
});

async function recordLoginEvent(db, { userId = null, username, event, req }) {
  await db.query(
    'INSERT INTO login_events (user_id, username, event, ip, user_agent) VALUES ($1,$2,$3,$4,$5)',
    [userId, username, event, req.ip, req.get('user-agent') || null],
  );
}

async function failedLogin(req, username, user, reason) {
  const settings = await getSettings();
  const sec = settings.security;
  await tx(async (db) => {
    let locked = false;
    if (user) {
      const { rows } = await db.query(
        `UPDATE users SET failed_attempts = failed_attempts + 1,
           locked_until = CASE WHEN failed_attempts + 1 >= $2 THEN now() + ($3 || ' minutes')::interval ELSE locked_until END
         WHERE id = $1 RETURNING failed_attempts, locked_until`,
        [user.id, sec.max_failed_logins, String(sec.lock_minutes)],
      );
      locked = rows[0].failed_attempts >= sec.max_failed_logins;
    }
    await recordLoginEvent(db, { userId: user?.id, username, event: locked ? 'locked' : 'failed', req });
    await audit(db, req.ctx, {
      action: 'auth.login_failed', entityType: 'user', entityId: user?.id ?? null, username,
      summary: `Échec de connexion pour « ${username} » (${reason})`, feed: false,
    });
    const { rows: [{ n }] } = await db.query(
      `SELECT count(*)::int AS n FROM login_events
       WHERE lower(username) = lower($1) AND event IN ('failed','locked') AND created_at > now() - interval '30 minutes'`,
      [username],
    );
    if (n >= sec.failed_login_alert_threshold || locked) {
      await raiseAlert(db, req.ctx, {
        category: 'systeme', type: 'connexion_echouee', severity: 'haute',
        title: `Tentatives de connexion échouées répétées — « ${username} »`,
        details: { message: `${n} échecs en 30 minutes${locked ? ' — compte verrouillé' : ''}`, ip: req.ip },
        refType: 'user', refId: user?.id ?? null, userId: user?.id ?? null,
        dedupeKey: `login_failed:${username.toLowerCase()}`,
      });
    }
  });
  req.ctx.flush();
}

router.post('/login', loginLimiter, ah(async (req, res) => {
  const { username, password } = parse(z.object({
    username: z.string().trim().min(1).max(100),
    password: z.string().min(1).max(200),
  }), req.body);

  const { rows } = await query(
    'SELECT id, username, password_hash, status, locked_until FROM users WHERE lower(username) = lower($1)',
    [username],
  );
  const user = rows[0];
  const ok = await bcrypt.compare(password, user?.password_hash || DUMMY_HASH);

  if (user && user.status !== 'active') {
    await recordLoginEvent({ query }, { userId: user.id, username, event: 'disabled', req });
    throw new HttpError(403, 'Ce compte est désactivé. Contactez l\'administrateur.');
  }
  if (user && user.locked_until && new Date(user.locked_until) > new Date()) {
    await recordLoginEvent({ query }, { userId: user.id, username, event: 'locked', req });
    throw new HttpError(423, 'Compte temporairement verrouillé suite à plusieurs échecs. Réessayez plus tard.');
  }
  if (!user || !ok) {
    await failedLogin(req, username, user, user ? 'mot de passe incorrect' : 'identifiant inconnu');
    throw unauthorized('Identifiant ou mot de passe incorrect.');
  }

  const token = randomToken();
  await tx(async (db) => {
    await db.query('UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [user.id]);
    await db.query(
      `INSERT INTO sessions (id, user_id, expires_at, ip, user_agent)
       VALUES ($1, $2, now() + ($3 || ' hours')::interval, $4, $5)`,
      [sha256(token), user.id, String(config.sessionTtlHours), req.ip, req.get('user-agent') || null],
    );
    await recordLoginEvent(db, { userId: user.id, username: user.username, event: 'login', req });
    req.ctx.user = { id: user.id, username: user.username, fullName: user.username };
    const { rows: [u] } = await db.query(
      `SELECT u.first_name || ' ' || u.last_name AS full_name, r.name AS role_name
       FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`, [user.id]);
    req.ctx.user = { id: user.id, username: user.username, fullName: u.full_name, roleName: u.role_name };
    await audit(db, req.ctx, { action: 'auth.login', entityType: 'user', entityId: user.id, summary: `Connexion de ${u.full_name}` });
  });
  res.cookie(SESSION_COOKIE, token, cookieOptions());
  res.json({ ok: true });
}));

router.post('/logout', ah(async (req, res) => {
  if (req.user) {
    await tx(async (db) => {
      await db.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [req.user.sessionId]);
      await recordLoginEvent(db, { userId: req.user.id, username: req.user.username, event: 'logout', req });
      await audit(db, req.ctx, { action: 'auth.logout', entityType: 'user', entityId: req.user.id, summary: `Déconnexion de ${req.user.fullName}` });
    });
  }
  res.clearCookie(SESSION_COOKIE, { ...cookieOptions(), maxAge: undefined });
  res.json({ ok: true });
}));

router.get('/me', ah(async (req, res) => {
  // Pas de 401 ici : l'application interroge /me au démarrage pour savoir si une session existe
  if (!req.user) return res.json({ user: null });
  const settings = await getSettings();
  const u = req.user;
  res.json({
    user: {
      id: u.id, username: u.username, firstName: u.firstName, lastName: u.lastName, fullName: u.fullName,
      employeeNumber: u.employeeNumber, jobTitle: u.jobTitle, role: { id: u.roleId, code: u.roleCode, name: u.roleName },
      superadmin: u.superadmin, mustChangePassword: u.mustChangePassword, permissions: [...u.permissions].sort(),
    },
    clinic: settings.clinic,
    expenseCategories: settings.expense_categories,
  });
}));

router.post('/change-password', requireAuth, ah(async (req, res) => {
  const { currentPassword, newPassword } = parse(z.object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(1).max(200),
  }), req.body);
  const { rows: [row] } = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!(await bcrypt.compare(currentPassword, row.password_hash))) throw badRequest('Mot de passe actuel incorrect.');
  const policy = checkPasswordPolicy(newPassword, req.user.username);
  if (policy) throw badRequest(policy);
  if (await bcrypt.compare(newPassword, row.password_hash)) throw badRequest('Le nouveau mot de passe doit être différent de l\'ancien.');
  const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  await tx(async (db) => {
    await db.query('UPDATE users SET password_hash = $1, must_change_password = FALSE, updated_at = now() WHERE id = $2', [hash, req.user.id]);
    await db.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL', [req.user.id, req.user.sessionId]);
    await audit(db, req.ctx, { action: 'auth.password_changed', entityType: 'user', entityId: req.user.id, summary: `${req.user.fullName} a changé son mot de passe`, feed: false });
  });
  res.json({ ok: true });
}));

export default router;
