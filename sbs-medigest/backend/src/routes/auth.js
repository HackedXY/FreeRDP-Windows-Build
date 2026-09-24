import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { query, tx } from '../db/pool.js';
import { config } from '../config.js';
import { ah, parse, badRequest, HttpError, unauthorized } from '../lib/errors.js';
import { randomToken, sha256, encrypt, decrypt } from '../lib/crypto.js';
import { generateSecret, verifyTotp, otpauthUri, generateRecoveryCodes, hashRecoveryCode } from '../lib/totp.js';
import { SESSION_COOKIE, cookieOptions, requireAuth } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { raiseAlert } from '../lib/notify.js';
import { getSettings } from '../lib/settings.js';
import { disconnectSession, refreshRealtime } from '../lib/realtime.js';

const router = Router();
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 10);
export const BCRYPT_ROUNDS = 12;

export function checkPasswordPolicy(password, username) {
  if (typeof password !== 'string' || password.length < 8) return 'Le mot de passe doit contenir au moins 8 caractères.';
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return 'Le mot de passe doit contenir des lettres et des chiffres.';
  if (username && password.toLowerCase().includes(username.toLowerCase())) return 'Le mot de passe ne doit pas contenir l\'identifiant.';
  return null;
}

// Limiteur par adresse IP : seules les tentatives en échec consomment le quota
export const loginLimiterOptions = {
  windowMs: 15 * 60 * 1000,
  limit: process.env.NODE_ENV === 'test' ? 1000 : 30,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives de connexion. Réessayez plus tard.' },
};
const loginLimiter = rateLimit(loginLimiterOptions);

// Réponses volontairement identiques : elles ne révèlent ni l'existence du compte,
// ni son état (désactivé, verrouillé), ni le motif précis du refus.
const GENERIC_FAIL = 'Identifiant ou mot de passe incorrect.';
const THROTTLED = 'Trop de tentatives. Réessayez dans quelques minutes.';
const throttled = () => new HttpError(429, THROTTLED);

/**
 * Anti-force brute sans verrouillage permanent exploitable par un tiers :
 *  - par source (identifiant + adresse IP) : au-delà de max_failed_logins échecs depuis la
 *    dernière connexion réussie de cette source, sur une fenêtre glissante de lock_minutes,
 *    la source est ralentie — les autres postes (ex. le cabinet) ne sont pas bloqués ;
 *  - par compte, toutes sources confondues : au-delà de account_lock_threshold échecs dans
 *    la fenêtre (attaque distribuée), blocage TEMPORAIRE de lock_minutes, levé automatiquement.
 * Les compteurs reposent sur le journal des connexions : pas de re-verrouillage au premier
 * échec après expiration, et même comportement pour un identifiant inexistant.
 */
async function throttleState(db, username, ip, sec) {
  const { rows: [r] } = await db.query(
    `SELECT
       (SELECT count(*)::int FROM login_events f
         WHERE lower(f.username) = lower($1) AND f.ip IS NOT DISTINCT FROM $2 AND f.event = 'failed'
           AND f.created_at > now() - ($3 || ' minutes')::interval
           AND f.created_at > coalesce((SELECT max(created_at) FROM login_events s
                                         WHERE lower(s.username) = lower($1) AND s.ip IS NOT DISTINCT FROM $2 AND s.event = 'login'), '-infinity')) AS source_failures,
       (SELECT count(*)::int FROM login_events f
         WHERE lower(f.username) = lower($1) AND f.event = 'failed' AND f.created_at > now() - ($3 || ' minutes')::interval) AS account_failures`,
    [username, ip, String(sec.lock_minutes)]);
  return r;
}

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
    await recordLoginEvent(db, { userId: user?.id, username, event: 'failed', req });
    const st = await throttleState(db, username, req.ip, sec);
    // Attaque distribuée sur un compte : blocage temporaire (jamais permanent)
    const accountLock = user && st.account_failures >= (sec.account_lock_threshold || sec.max_failed_logins * 4);
    if (user) {
      await db.query(
        `UPDATE users SET failed_attempts = failed_attempts + 1,
           locked_until = CASE WHEN $2 THEN now() + ($3 || ' minutes')::interval ELSE locked_until END
         WHERE id = $1`,
        [user.id, accountLock, String(sec.lock_minutes)]);
    }
    await audit(db, req.ctx, {
      action: 'auth.login_failed', entityType: 'user', entityId: user?.id ?? null, username,
      summary: `Échec de connexion pour « ${username} » (${reason})`, feed: false,
    });
    const { rows: [{ n }] } = await db.query(
      `SELECT count(*)::int AS n FROM login_events
       WHERE lower(username) = lower($1) AND event = 'failed' AND created_at > now() - interval '30 minutes'`,
      [username],
    );
    if (n >= sec.failed_login_alert_threshold || accountLock) {
      await raiseAlert(db, req.ctx, {
        category: 'systeme', type: 'connexion_echouee', severity: 'haute',
        title: `Tentatives de connexion échouées répétées — « ${username} »`,
        details: { message: `${n} échecs en 30 minutes${accountLock ? ' — compte bloqué temporairement (plusieurs sources)' : ''}`, ip: req.ip },
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
  // Ralentissement avant toute vérification du mot de passe (identique pour un compte inexistant)
  const sec = (await getSettings()).security;
  const st = await throttleState({ query }, username, req.ip, sec);
  if (st.source_failures >= sec.max_failed_logins || (user?.locked_until && new Date(user.locked_until) > new Date())) {
    await recordLoginEvent({ query }, { userId: user?.id, username, event: 'locked', req });
    throw throttled();
  }
  const ok = await bcrypt.compare(password, user?.password_hash || DUMMY_HASH);
  if (user && ok && user.status !== 'active') {
    // compte désactivé : tracé, mais réponse identique à un mot de passe erroné
    await recordLoginEvent({ query }, { userId: user.id, username, event: 'disabled', req });
    throw unauthorized(GENERIC_FAIL);
  }
  if (!user || !ok) {
    await failedLogin(req, username, user, user ? 'mot de passe incorrect' : 'identifiant inconnu');
    throw unauthorized(GENERIC_FAIL);
  }

  // Double authentification activée : pas de session avant la vérification du code
  const { rows: [mfa] } = await query('SELECT 1 FROM user_mfa WHERE user_id = $1 AND enabled_at IS NOT NULL AND secret_enc IS NOT NULL', [user.id]);
  if (mfa) {
    const challenge = randomToken();
    await query(
      `INSERT INTO mfa_challenges (id, user_id, expires_at, ip) VALUES ($1, $2, now() + interval '5 minutes', $3)`,
      [sha256(challenge), user.id, req.ip]);
    return res.json({ ok: false, mfa_required: true, mfa_token: challenge });
  }
  await openSession(req, res, user);
  res.json({ ok: true });
}));

/** Crée la session (cookie httpOnly) après authentification complète. */
async function openSession(req, res, user, { via = null } = {}) {
  const token = randomToken();
  await tx(async (db) => {
    await db.query('UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [user.id]);
    await db.query(
      `INSERT INTO sessions (id, user_id, expires_at, ip, user_agent)
       VALUES ($1, $2, now() + ($3 || ' hours')::interval, $4, $5)`,
      [sha256(token), user.id, String(config.sessionTtlHours), req.ip, req.get('user-agent') || null],
    );
    await recordLoginEvent(db, { userId: user.id, username: user.username, event: 'login', req });
    const { rows: [u] } = await db.query(
      `SELECT u.first_name || ' ' || u.last_name AS full_name, r.name AS role_name
       FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`, [user.id]);
    req.ctx.user = { id: user.id, username: user.username, fullName: u.full_name, roleName: u.role_name };
    await audit(db, req.ctx, {
      action: 'auth.login', entityType: 'user', entityId: user.id,
      summary: `Connexion de ${u.full_name}${via ? ` (${via})` : ''}`,
    });
  });
  res.cookie(SESSION_COOKIE, token, cookieOptions());
}

const MFA_MAX_ATTEMPTS = 5;

// Deuxième étape de connexion : code TOTP ou code de récupération
router.post('/login/mfa', loginLimiter, ah(async (req, res) => {
  const d = parse(z.object({
    mfa_token: z.string().min(10).max(200),
    code: z.string().trim().max(10).optional().nullable(),
    recovery_code: z.string().trim().max(20).optional().nullable(),
  }), req.body);
  if (!d.code && !d.recovery_code) throw badRequest('Saisissez le code de votre application ou un code de récupération.');
  const expired = () => unauthorized('Vérification expirée : reconnectez-vous.');
  const result = await tx(async (db) => {
    const { rows: [c] } = await db.query(
      `SELECT c.*, c.expires_at < now() AS expired, u.username, u.status, u.locked_until
       FROM mfa_challenges c JOIN users u ON u.id = c.user_id WHERE c.id = $1 FOR UPDATE OF c`, [sha256(d.mfa_token)]);
    if (!c || c.expired || c.consumed_at || c.attempts >= MFA_MAX_ATTEMPTS || c.status !== 'active') throw expired();
    if (c.locked_until && new Date(c.locked_until) > new Date()) throw throttled();
    await db.query(`SELECT set_config('sbs.actor_id', $1, true)`, [String(c.user_id)]);
    const { rows: [m] } = await db.query('SELECT * FROM user_mfa WHERE user_id = $1 AND enabled_at IS NOT NULL FOR UPDATE', [c.user_id]);
    if (!m) throw expired();
    let method = null;
    if (d.code) {
      const step = verifyTotp(decrypt(m.secret_enc), d.code, { lastStep: m.last_step });
      if (step !== null) {
        await db.query('UPDATE user_mfa SET last_step = $2, updated_at = now() WHERE user_id = $1', [c.user_id, step]);
        method = 'totp';
      }
    } else {
      const { rows: [rc] } = await db.query(
        'UPDATE mfa_recovery_codes SET used_at = now() WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL RETURNING id',
        [c.user_id, hashRecoveryCode(d.recovery_code)]);
      if (rc) method = 'recovery';
    }
    if (!method) {
      await db.query('UPDATE mfa_challenges SET attempts = attempts + 1 WHERE id = $1', [c.id]);
      return { ok: false, user: { id: c.user_id, username: c.username } };
    }
    await db.query('UPDATE mfa_challenges SET consumed_at = now() WHERE id = $1', [c.id]);
    if (method === 'recovery') {
      const { rows: [{ n }] } = await db.query('SELECT count(*)::int AS n FROM mfa_recovery_codes WHERE user_id = $1 AND used_at IS NULL', [c.user_id]);
      await audit(db, { ...req.ctx, user: null }, {
        action: 'auth.mfa_recovery_used', entityType: 'user', entityId: c.user_id, username: c.username,
        summary: `Connexion avec un code de récupération — « ${c.username} » (${n} restant(s))`, feed: false,
      });
      await raiseAlert(db, req.ctx, {
        category: 'systeme', type: 'mfa_code_recuperation', severity: 'haute',
        title: `Code de récupération 2FA utilisé — « ${c.username} »`,
        details: { message: `${n} code(s) de récupération restant(s)`, ip: req.ip }, refType: 'user', refId: c.user_id, userId: c.user_id,
      });
    }
    return { ok: true, method, user: { id: c.user_id, username: c.username } };
  });
  if (!result.ok) {
    await tx(async (db) => {
      await recordLoginEvent(db, { userId: result.user.id, username: result.user.username, event: 'mfa_failed', req });
    });
    await failedLogin(req, result.user.username, result.user, 'code de double authentification incorrect');
    throw unauthorized('Code de vérification incorrect.');
  }
  await openSession(req, res, result.user, { via: result.method === 'recovery' ? 'code de récupération' : 'double authentification' });
  req.ctx.flush();
  res.json({ ok: true });
}));

router.post('/logout', ah(async (req, res) => {
  if (req.user) {
    await tx(async (db) => {
      await db.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [req.user.sessionId]);
      await recordLoginEvent(db, { userId: req.user.id, username: req.user.username, event: 'logout', req });
      await audit(db, req.ctx, { action: 'auth.logout', entityType: 'user', entityId: req.user.id, summary: `Déconnexion de ${req.user.fullName}` });
    });
    // plus aucune donnée temps réel pour cette session
    disconnectSession(req.user.sessionId);
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
      superadmin: u.superadmin, mustChangePassword: u.mustChangePassword, mfaSetupRequired: u.mfaSetupRequired, permissions: [...u.permissions].sort(),
    },
    session: { idleMinutes: config.sessionIdleMinutes, expiresAt: new Date(u.sessionExpiresAt) },
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
    await db.query(`SELECT set_config('sbs.actor_id', $1, true)`, [String(req.user.id)]);
    await db.query('UPDATE users SET password_hash = $1, must_change_password = FALSE, updated_at = now() WHERE id = $2', [hash, req.user.id]);
    await db.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL', [req.user.id, req.user.sessionId]);
    await audit(db, req.ctx, { action: 'auth.password_changed', entityType: 'user', entityId: req.user.id, summary: `${req.user.fullName} a changé son mot de passe`, feed: false });
  });
  await refreshRealtime({ userIds: [req.user.id] }); // les autres sessions révoquées perdent leur flux
  res.json({ ok: true });
}));

// ------------------------------------------------------------ Double authentification (propriétaire)
async function checkPassword(userId, password) {
  const { rows: [row] } = await query('SELECT password_hash FROM users WHERE id = $1', [userId]);
  if (!row || !(await bcrypt.compare(password || '', row.password_hash))) throw badRequest('Mot de passe incorrect.');
}
function assertMfaEligible(user) {
  // Première étape : réservée au compte propriétaire (super-administrateur)
  if (!user.superadmin) throw new HttpError(403, 'La double authentification est réservée au compte propriétaire.');
}
async function mfaRow(db, userId, lock = false) {
  const { rows: [m] } = await db.query(`SELECT * FROM user_mfa WHERE user_id = $1${lock ? ' FOR UPDATE' : ''}`, [userId]);
  return m || null;
}
/** Vérifie le second facteur (code TOTP ou code de récupération) d'un utilisateur déjà connecté. */
async function checkSecondFactor(db, m, { code, recovery_code: recovery }) {
  if (code) {
    const step = verifyTotp(decrypt(m.secret_enc), code, { lastStep: m.last_step });
    if (step === null) throw badRequest('Code de vérification incorrect.');
    await db.query('UPDATE user_mfa SET last_step = $2, updated_at = now() WHERE user_id = $1', [m.user_id, step]);
    return 'totp';
  }
  if (recovery) {
    const { rows: [rc] } = await db.query(
      'UPDATE mfa_recovery_codes SET used_at = now() WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL RETURNING id',
      [m.user_id, hashRecoveryCode(recovery)]);
    if (!rc) throw badRequest('Code de récupération incorrect ou déjà utilisé.');
    return 'recovery';
  }
  throw badRequest('Code de vérification obligatoire.');
}
async function replaceRecoveryCodes(db, userId) {
  const codes = generateRecoveryCodes();
  await db.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [userId]);
  for (const c of codes) await db.query('INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1, $2)', [userId, hashRecoveryCode(c)]);
  return codes;
}
const actor = (db, req) => db.query(`SELECT set_config('sbs.actor_id', $1, true)`, [String(req.user.id)]);

router.get('/mfa', requireAuth, ah(async (req, res) => {
  const m = await mfaRow({ query }, req.user.id);
  const { rows: [{ n }] } = await query('SELECT count(*)::int AS n FROM mfa_recovery_codes WHERE user_id = $1 AND used_at IS NULL', [req.user.id]);
  res.json({
    eligible: !!req.user.superadmin,
    required: !!(config.ownerMfaRequired && req.user.superadmin),
    enabled: !!m?.enabled_at,
    enabled_at: m?.enabled_at || null,
    pending: !!m?.pending_secret_enc,
    recovery_codes_remaining: m?.enabled_at ? n : 0,
  });
}));

router.post('/mfa/setup', requireAuth, ah(async (req, res) => {
  assertMfaEligible(req.user);
  const d = parse(z.object({
    password: z.string().min(1).max(200),
    code: z.string().trim().max(10).optional().nullable(),
    recovery_code: z.string().trim().max(20).optional().nullable(),
  }), req.body);
  await checkPassword(req.user.id, d.password);
  const secret = generateSecret();
  await tx(async (db) => {
    await actor(db, req);
    const m = await mfaRow(db, req.user.id, true);
    // Déjà activée : changement de téléphone, autorisé seulement avec le second facteur actuel
    if (m?.enabled_at) await checkSecondFactor(db, m, d);
    await db.query(
      `INSERT INTO user_mfa (user_id, pending_secret_enc, pending_created_at) VALUES ($1, $2, now())
       ON CONFLICT (user_id) DO UPDATE SET pending_secret_enc = EXCLUDED.pending_secret_enc, pending_created_at = now(), updated_at = now()`,
      [req.user.id, encrypt(secret)]);
    await audit(db, req.ctx, { action: 'auth.mfa_setup', entityType: 'user', entityId: req.user.id, summary: `${req.user.fullName} a démarré l'activation de la double authentification`, feed: false });
  });
  // Le secret n'est transmis qu'une fois, pour l'enregistrer dans l'application d'authentification
  res.json({ secret, otpauth_uri: otpauthUri({ secret, account: req.user.username }) });
}));

router.post('/mfa/confirm', requireAuth, ah(async (req, res) => {
  assertMfaEligible(req.user);
  const { code } = parse(z.object({ code: z.string().trim().min(6).max(10) }), req.body);
  const codes = await tx(async (db) => {
    await actor(db, req);
    const m = await mfaRow(db, req.user.id, true);
    if (!m?.pending_secret_enc || Date.now() - new Date(m.pending_created_at).getTime() > 15 * 60_000) {
      throw badRequest('Activation expirée : recommencez.');
    }
    const secret = decrypt(m.pending_secret_enc);
    const step = verifyTotp(secret, code);
    if (step === null) throw badRequest('Code de vérification incorrect : vérifiez l\'heure du téléphone et réessayez.');
    await db.query(
      `UPDATE user_mfa SET secret_enc = pending_secret_enc, pending_secret_enc = NULL, pending_created_at = NULL,
         enabled_at = coalesce(enabled_at, now()), last_step = $2, updated_at = now() WHERE user_id = $1`, [req.user.id, step]);
    const out = await replaceRecoveryCodes(db, req.user.id);
    // les autres sessions ouvertes sans second facteur sont fermées
    await db.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL', [req.user.id, req.user.sessionId]);
    const renewed = !!m.enabled_at;
    await audit(db, req.ctx, {
      action: renewed ? 'auth.mfa_renewed' : 'auth.mfa_enabled', entityType: 'user', entityId: req.user.id,
      summary: `Double authentification ${renewed ? 'reconfigurée (nouvel appareil)' : 'activée'} — ${req.user.fullName}`, feed: false,
    });
    return out;
  });
  await refreshRealtime({ userIds: [req.user.id] });
  res.json({ ok: true, recovery_codes: codes });
}));

const secondFactorSchema = z.object({
  password: z.string().min(1).max(200),
  code: z.string().trim().max(10).optional().nullable(),
  recovery_code: z.string().trim().max(20).optional().nullable(),
});

router.post('/mfa/disable', requireAuth, ah(async (req, res) => {
  const d = parse(secondFactorSchema, req.body);
  if (config.ownerMfaRequired && req.user.superadmin) {
    throw new HttpError(403, 'La double authentification est obligatoire pour le compte propriétaire : utilisez « Changer d\'appareil » pour la reconfigurer.');
  }
  await checkPassword(req.user.id, d.password);
  await tx(async (db) => {
    await actor(db, req);
    const m = await mfaRow(db, req.user.id, true);
    if (!m?.enabled_at) throw badRequest('La double authentification n\'est pas activée.');
    const method = await checkSecondFactor(db, m, d);
    await db.query(
      `UPDATE user_mfa SET secret_enc = NULL, pending_secret_enc = NULL, pending_created_at = NULL, enabled_at = NULL,
         last_step = NULL, updated_at = now() WHERE user_id = $1`, [req.user.id]);
    await db.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [req.user.id]);
    await audit(db, req.ctx, {
      action: 'auth.mfa_disabled', entityType: 'user', entityId: req.user.id,
      summary: `Double authentification désactivée — ${req.user.fullName}`, newValue: { verified_with: method }, feed: false,
    });
    await raiseAlert(db, req.ctx, {
      category: 'systeme', type: 'mfa_desactivee', severity: 'haute', title: `Double authentification désactivée — ${req.user.fullName}`,
      details: { message: `Désactivation confirmée par mot de passe et ${method === 'totp' ? 'code TOTP' : 'code de récupération'}`, ip: req.ip },
      refType: 'user', refId: req.user.id, userId: req.user.id,
    });
  });
  res.json({ ok: true });
}));

router.post('/mfa/recovery-codes', requireAuth, ah(async (req, res) => {
  const d = parse(secondFactorSchema, req.body);
  await checkPassword(req.user.id, d.password);
  const codes = await tx(async (db) => {
    await actor(db, req);
    const m = await mfaRow(db, req.user.id, true);
    if (!m?.enabled_at) throw badRequest('La double authentification n\'est pas activée.');
    await checkSecondFactor(db, m, d);
    const out = await replaceRecoveryCodes(db, req.user.id);
    await audit(db, req.ctx, { action: 'auth.mfa_recovery_regenerated', entityType: 'user', entityId: req.user.id, summary: `Nouveaux codes de récupération 2FA — ${req.user.fullName}`, feed: false });
    return out;
  });
  res.json({ ok: true, recovery_codes: codes });
}));

export default router;
