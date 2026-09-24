// Remédiation phase 1 : expiration des sessions après inactivité (en plus de la limite
// absolue) et double authentification TOTP du compte propriétaire.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, adminAgent, employee, login, pool, ownerPool, closePools } from './helpers.js';
import { config } from '../src/config.js';
import { hotp, currentStep, verifyTotp, base32Encode, base32Decode, generateRecoveryCodes, hashRecoveryCode } from '../src/lib/totp.js';

let admin, cashier;
const sid = async (username) => (await pool.query(
  `SELECT s.id FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.username = $1 AND s.revoked_at IS NULL ORDER BY s.created_at DESC LIMIT 1`, [username])).rows[0].id;
const age = (id, minutes, col = 'last_seen_at') => ownerPool.query(`UPDATE sessions SET ${col} = now() - ($2 || ' minutes')::interval WHERE id = $1`, [id, String(minutes)]);

before(async () => {
  await resetDb();
  admin = await adminAgent();
  cashier = await employee(admin, 'caissier', 'caisseIdle');
});
after(async () => { await closePools(); });

// ------------------------------------------------------------------ inactivité
test('inactivité : valeur par défaut raisonnable, exposée au client', async () => {
  assert.equal(config.sessionIdleMinutes, 30);
  assert.equal(config.sessionTtlHours, 12, 'limite absolue conservée');
  const me = (await cashier.get('/api/auth/me')).body;
  assert.equal(me.session.idleMinutes, 30);
});

test('inactivité : session active conservée, session inactive révoquée et tracée', async () => {
  const id = await sid('caisseIdle');
  await age(id, 29);
  assert.equal((await cashier.get('/api/payments')).status, 200, '29 min : encore valide');
  await age(id, 31);
  assert.equal((await cashier.get('/api/payments')).status, 401, '31 min : expirée');
  const { rows: [s] } = await pool.query('SELECT revoked_at FROM sessions WHERE id = $1', [id]);
  assert.ok(s.revoked_at, 'révoquée définitivement');
  // même en remettant l'horloge à zéro, la session révoquée reste invalide
  await age(id, 0);
  assert.equal((await cashier.get('/api/payments')).status, 401);
  const { rows } = await pool.query(`SELECT event FROM login_events WHERE username = 'caisseIdle' AND event = 'expired'`);
  assert.equal(rows.length, 1);
});

test('inactivité : les actualisations automatiques (X-SBS-Background) ne prolongent pas la session', async () => {
  const a = await login('caisseIdle', 'Employe2026x');
  const id = await sid('caisseIdle');
  await age(id, 5);
  const bg = await a.raw.get('/api/payments').set('X-SBS-Background', '1');
  assert.equal(bg.status, 200);
  const { rows: [s1] } = await pool.query(`SELECT now() - last_seen_at > interval '4 minutes' AS stale FROM sessions WHERE id = $1`, [id]);
  assert.equal(s1.stale, true, 'last_seen_at inchangé');
  await a.get('/api/payments'); // action de l'utilisateur
  await new Promise((r) => setTimeout(r, 100));
  const { rows: [s2] } = await pool.query(`SELECT now() - last_seen_at < interval '1 minute' AS fresh FROM sessions WHERE id = $1`, [id]);
  assert.equal(s2.fresh, true, 'last_seen_at prolongé');
});

test('limite absolue de 12 h toujours appliquée, même pour une session active', async () => {
  const a = await login('caisseIdle', 'Employe2026x');
  const id = await sid('caisseIdle');
  assert.equal((await a.get('/api/payments')).status, 200);
  await ownerPool.query(`UPDATE sessions SET expires_at = now() - interval '1 second', last_seen_at = now() WHERE id = $1`, [id]);
  assert.equal((await a.get('/api/payments')).status, 401);
});

// ------------------------------------------------------------------ TOTP (unitaire)
test('TOTP : vecteurs RFC 6238 (SHA1), base32, anti-rejeu, codes de récupération', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.deepEqual(base32Decode(secret), Buffer.from('12345678901234567890'));
  // RFC 6238 annexe B (8 chiffres) → 6 derniers chiffres
  assert.equal(hotp(secret, Math.floor(59 / 30)), '287082');
  assert.equal(hotp(secret, Math.floor(1111111109 / 30)), '081804');
  assert.equal(hotp(secret, Math.floor(1234567890 / 30)), '005924');
  const now = 1234567890 * 1000;
  const step = verifyTotp(secret, '005924', { now });
  assert.equal(step, currentStep(now));
  assert.equal(verifyTotp(secret, '005924', { now, lastStep: step }), null, 'rejeu refusé');
  assert.equal(verifyTotp(secret, '000000', { now }), null);
  assert.equal(verifyTotp(secret, 'abc', { now }), null);
  const codes = generateRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  assert.ok(codes.every((c) => /^[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(c)));
  assert.equal(hashRecoveryCode(codes[0]), hashRecoveryCode(codes[0].toLowerCase().replace('-', ' ')));
});

// ------------------------------------------------------------------ 2FA propriétaire
let secret; let recovery; let confirmStep;

test('2FA : réservée au propriétaire', async () => {
  cashier = await login('caisseIdle', 'Employe2026x');
  const st = (await cashier.get('/api/auth/mfa')).body;
  assert.equal(st.eligible, false);
  assert.equal((await cashier.post('/api/auth/mfa/setup').send({ password: 'Employe2026x' })).status, 403);
  const own = (await admin.get('/api/auth/mfa')).body;
  assert.deepEqual([own.eligible, own.enabled], [true, false]);
});

test('2FA : activation (mot de passe exigé), confirmation par code, secret jamais stocké en clair', async () => {
  assert.equal((await admin.post('/api/auth/mfa/setup').send({ password: 'mauvais' })).status, 400);
  const r = await admin.post('/api/auth/mfa/setup').send({ password: 'Proprietaire2026' });
  assert.equal(r.status, 200);
  secret = r.body.secret;
  assert.match(r.body.otpauth_uri, /^otpauth:\/\/totp\/SBS%20MediGest%3Aadmin\?secret=/);
  // tant que non confirmée : pas encore active
  assert.equal((await admin.get('/api/auth/mfa')).body.enabled, false);
  assert.equal((await admin.post('/api/auth/mfa/confirm').send({ code: '000000' })).status, 400);
  confirmStep = currentStep();
  const c = await admin.post('/api/auth/mfa/confirm').send({ code: hotp(secret, confirmStep) });
  assert.equal(c.status, 200);
  recovery = c.body.recovery_codes;
  assert.equal(recovery.length, 10);
  const { rows: [m] } = await pool.query('SELECT * FROM user_mfa WHERE user_id = (SELECT id FROM users WHERE username = $1)', ['admin']);
  assert.match(m.secret_enc, /^enc:v1:/);
  assert.ok(!JSON.stringify(m).includes(secret), 'secret absent de la base');
  const { rows: rc } = await pool.query('SELECT code_hash FROM mfa_recovery_codes WHERE user_id = $1', [m.user_id]);
  assert.equal(rc.length, 10);
  assert.ok(rc.every((x) => !recovery.includes(x.code_hash) && /^[0-9a-f]{64}$/.test(x.code_hash)));
  const st = (await admin.get('/api/auth/mfa')).body;
  assert.deepEqual([st.enabled, st.recovery_codes_remaining], [true, 10]);
});

test('2FA : connexion en deux étapes — pas de session sans code valide', async () => {
  const a = await login('admin', 'Proprietaire2026');
  assert.equal(a.loginRes.status, 200);
  assert.equal(a.loginRes.body.mfa_required, true);
  assert.ok(!a.loginRes.headers['set-cookie'], 'aucun cookie de session avant le second facteur');
  assert.equal((await a.get('/api/auth/me')).body.user, null);
  const token = a.loginRes.body.mfa_token;
  let r = await a.post('/api/auth/login/mfa').send({ mfa_token: token, code: '123456' });
  assert.equal(r.status, 401);
  // rejeu du code déjà utilisé pour la confirmation : refusé
  r = await a.post('/api/auth/login/mfa').send({ mfa_token: token, code: hotp(secret, confirmStep) });
  assert.equal(r.status, 401);
  r = await a.post('/api/auth/login/mfa').send({ mfa_token: token, code: hotp(secret, confirmStep + 1) });
  assert.equal(r.status, 200);
  assert.equal((await a.get('/api/auth/me')).body.user.username, 'admin');
  // le défi est à usage unique
  assert.equal((await a.post('/api/auth/login/mfa').send({ mfa_token: token, code: hotp(secret, confirmStep + 1) })).status, 401);
  const { rows } = await pool.query(`SELECT event FROM login_events WHERE username = 'admin' AND event = 'mfa_failed'`);
  assert.equal(rows.length, 2);
});

test('2FA : défi limité en tentatives et refusé après expiration', async () => {
  const a = await login('admin', 'Proprietaire2026');
  const token = a.loginRes.body.mfa_token;
  for (let i = 0; i < 5; i++) await a.post('/api/auth/login/mfa').send({ mfa_token: token, code: '111111' });
  const r = await a.post('/api/auth/login/mfa').send({ mfa_token: token, recovery_code: recovery[9] });
  assert.equal(r.status, 401, 'défi épuisé même avec un code valide');
  await ownerPool.query(`UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE username = 'admin'`);
  await ownerPool.query(`DELETE FROM login_events WHERE username = 'admin' AND event = 'failed'`); // compteurs de ralentissement (phase 4)
  const b = await login('admin', 'Proprietaire2026');
  assert.equal(b.loginRes.body.mfa_required, true);
  await ownerPool.query(`UPDATE mfa_challenges SET expires_at = now() - interval '1 second' WHERE consumed_at IS NULL`);
  assert.equal((await b.post('/api/auth/login/mfa').send({ mfa_token: b.loginRes.body.mfa_token, recovery_code: recovery[9] })).status, 401);
  // réinitialise le compteur d'échecs (verrouillage) pour la suite
  await ownerPool.query(`UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE username = 'admin'`);
  await ownerPool.query(`DELETE FROM login_events WHERE username = 'admin' AND event = 'failed'`); // compteurs de ralentissement (phase 4)
});

test('2FA : connexion avec un code de récupération (usage unique) + alerte', async () => {
  const a = await login('admin', 'Proprietaire2026');
  let r = await a.post('/api/auth/login/mfa').send({ mfa_token: a.loginRes.body.mfa_token, recovery_code: recovery[0].toLowerCase() });
  assert.equal(r.status, 200);
  admin = a;
  const b = await login('admin', 'Proprietaire2026');
  r = await b.post('/api/auth/login/mfa').send({ mfa_token: b.loginRes.body.mfa_token, recovery_code: recovery[0] });
  assert.equal(r.status, 401, 'code déjà utilisé');
  await ownerPool.query(`UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE username = 'admin'`);
  await ownerPool.query(`DELETE FROM login_events WHERE username = 'admin' AND event = 'failed'`); // compteurs de ralentissement (phase 4)
  assert.equal((await admin.get('/api/auth/mfa')).body.recovery_codes_remaining, 9);
  const alerts = (await admin.get('/api/alerts?type=mfa_code_recuperation')).body.items;
  assert.equal(alerts.length, 1);
});

test('2FA : régénération et désactivation exigent mot de passe ET second facteur ; audit sans secret', async () => {
  assert.equal((await admin.post('/api/auth/mfa/recovery-codes').send({ password: 'Proprietaire2026' })).status, 400);
  const g = await admin.post('/api/auth/mfa/recovery-codes').send({ password: 'Proprietaire2026', recovery_code: recovery[1] });
  assert.equal(g.status, 200);
  const fresh = g.body.recovery_codes;
  assert.equal((await admin.get('/api/auth/mfa')).body.recovery_codes_remaining, 10);
  // les anciens codes ne valent plus rien
  assert.equal((await admin.post('/api/auth/mfa/disable').send({ password: 'Proprietaire2026', recovery_code: recovery[2] })).status, 400);
  assert.equal((await admin.post('/api/auth/mfa/disable').send({ password: 'faux', recovery_code: fresh[0] })).status, 400);
  const d = await admin.post('/api/auth/mfa/disable').send({ password: 'Proprietaire2026', recovery_code: fresh[0] });
  assert.equal(d.status, 200);
  assert.equal((await admin.get('/api/auth/mfa')).body.enabled, false);
  const { rows: [m] } = await pool.query(`SELECT secret_enc FROM user_mfa WHERE user_id = (SELECT id FROM users WHERE username = 'admin')`);
  assert.equal(m.secret_enc, null);
  // connexion à nouveau en une étape
  const a = await login('admin', 'Proprietaire2026');
  assert.equal(a.loginRes.body.ok, true);
  // journal : chaque changement est tracé, jamais le secret ni les codes
  const { rows: audit } = await pool.query(`SELECT action, summary, old_value, new_value FROM audit_log WHERE action LIKE 'auth.mfa%' ORDER BY id`);
  const actions = audit.map((x) => x.action);
  for (const act of ['auth.mfa_setup', 'auth.mfa_enabled', 'auth.mfa_recovery_used', 'auth.mfa_recovery_regenerated', 'auth.mfa_disabled']) assert.ok(actions.includes(act), act);
  const dump = JSON.stringify(audit);
  assert.ok(!dump.includes(secret));
  for (const c of [...recovery, ...fresh]) assert.ok(!dump.includes(c));
  const v = (await a.get('/api/audit/verify')).body;
  assert.equal(v.ok, true);
});

test('2FA : la base refuse la modification de la 2FA d\'un autre utilisateur', async () => {
  const { rows: [u] } = await pool.query(`SELECT id FROM users WHERE username = 'admin'`);
  await assert.rejects(pool.query('UPDATE user_mfa SET secret_enc = NULL WHERE user_id = $1', [u.id]), /titulaire/);
  await assert.rejects(pool.query(`INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1, 'x')`, [u.id]), /titulaire/);
});
