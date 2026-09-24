// Phase 4 : messages de connexion génériques, ralentissement sans verrouillage permanent
// exploitable, quota ne comptant que les échecs, 2FA obligatoire du propriétaire,
// procédure de récupération du compte propriétaire.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import express from 'express';
import rateLimit from 'express-rate-limit';
import supertest from 'supertest';
import { resetDb, adminAgent, employee, login, app, pool, ownerPool, closePools } from './helpers.js';
import { config } from '../src/config.js';
import { loginLimiterOptions } from '../src/routes/auth.js';
import { recoverOwner } from '../src/db/owner-recovery.js';
import { hotp, currentStep } from '../src/lib/totp.js';

let admin, victim;
const from = (ip) => ({
  login: (username, password) => supertest(app).post('/api/auth/login').set('X-SBS-Client', 'test').set('X-Forwarded-For', ip).send({ username, password }),
});
const clearFailures = (u) => ownerPool.query(`DELETE FROM login_events WHERE lower(username) = lower($1) AND event IN ('failed','locked')`, [u]);

before(async () => {
  await resetDb();
  admin = await adminAgent();
  victim = await employee(admin, 'caissier', 'victime');
});
after(async () => { config.ownerMfaRequired = false; await closePools(); });

test('messages génériques : compte inexistant, mot de passe erroné, compte désactivé → réponse identique', async () => {
  const u = await employee(admin, 'caissier', 'desactive');
  await admin.put(`/api/users/${u.user.id}`).send({ status: 'disabled' });
  const a = await from('10.1.0.1').login('inconnu-xyz', 'Employe2026x');
  const b = await from('10.1.0.2').login('victime', 'mauvais-mdp');
  const c = await from('10.1.0.3').login('desactive', 'Employe2026x');
  for (const r of [a, b, c]) {
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, { error: 'Identifiant ou mot de passe incorrect.' });
  }
  const { rows } = await pool.query(`SELECT event FROM login_events WHERE username = 'desactive' ORDER BY id DESC LIMIT 1`);
  assert.equal(rows[0].event, 'disabled', 'le motif réel reste tracé côté serveur');
});

test('ralentissement par source : un poste tiers ne bloque pas l\'utilisateur légitime', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await from('203.0.113.9').login('victime', 'essai-attaquant')).status, 401);
  // la source attaquante est ralentie, y compris avec le bon mot de passe, avec un message générique
  const blocked = await from('203.0.113.9').login('victime', 'Employe2026x');
  assert.equal(blocked.status, 429);
  assert.deepEqual(blocked.body, { error: 'Trop de tentatives. Réessayez dans quelques minutes.' });
  // même réponse pour un identifiant inexistant (pas d'énumération)
  for (let i = 0; i < 5; i++) await from('203.0.113.9').login('fantome', 'x-essai');
  assert.equal((await from('203.0.113.9').login('fantome', 'x-essai')).status, 429);
  // le poste du cabinet se connecte normalement
  assert.equal((await from('192.168.1.20').login('victime', 'Employe2026x')).status, 200);
  const { rows: [u] } = await pool.query(`SELECT locked_until FROM users WHERE username = 'victime'`);
  assert.equal(u.locked_until, null, 'aucun verrouillage du compte');
});

test('fenêtre glissante : pas de re-verrouillage au premier échec après expiration', async () => {
  await ownerPool.query(`UPDATE login_events SET created_at = created_at - interval '16 minutes' WHERE username = 'victime' AND ip = '203.0.113.9'`);
  assert.equal((await from('203.0.113.9').login('victime', 'encore-faux')).status, 401, 'un échec isolé : 401, pas 429');
  assert.equal((await from('203.0.113.9').login('victime', 'Employe2026x')).status, 200);
});

test('connexion réussie : remet à zéro le compteur de la source', async () => {
  await clearFailures('victime');
  for (let i = 0; i < 4; i++) await from('198.51.100.7').login('victime', 'faute-de-frappe');
  assert.equal((await from('198.51.100.7').login('victime', 'Employe2026x')).status, 200);
  for (let i = 0; i < 4; i++) assert.equal((await from('198.51.100.7').login('victime', 'faute-de-frappe')).status, 401);
  assert.equal((await from('198.51.100.7').login('victime', 'Employe2026x')).status, 200);
});

test('attaque distribuée (nombreuses sources) : blocage temporaire du compte, levé automatiquement + alerte', async () => {
  await clearFailures('victime');
  for (let i = 0; i < 20; i++) await from(`100.64.0.${i + 1}`).login('victime', `essai-${i}`);
  const { rows: [u] } = await pool.query(`SELECT locked_until > now() AS locked FROM users WHERE username = 'victime'`);
  assert.equal(u.locked, true);
  const r = await from('192.168.1.20').login('victime', 'Employe2026x');
  assert.equal(r.status, 429);
  assert.equal(r.body.error, 'Trop de tentatives. Réessayez dans quelques minutes.');
  const alerts = (await admin.get('/api/alerts?type=connexion_echouee')).body.items;
  assert.ok(alerts.some((a) => /victime/.test(a.title)));
  // expiration du blocage : accès rétabli sans intervention
  await ownerPool.query(`UPDATE users SET locked_until = now() - interval '1 second' WHERE username = 'victime'`);
  await ownerPool.query(`UPDATE login_events SET created_at = created_at - interval '16 minutes' WHERE username = 'victime'`);
  assert.equal((await from('192.168.1.20').login('victime', 'Employe2026x')).status, 200);
});

test('limiteur de connexion : les connexions réussies ne consomment pas le quota', async () => {
  assert.equal(loginLimiterOptions.skipSuccessfulRequests, true);
  const mini = express();
  mini.post('/login', rateLimit({ ...loginLimiterOptions, limit: 3 }), (req, res) => res.status(req.query.ok ? 200 : 401).end());
  for (let i = 0; i < 10; i++) assert.equal((await supertest(mini).post('/login?ok=1')).status, 200);
  for (let i = 0; i < 3; i++) assert.equal((await supertest(mini).post('/login')).status, 401);
  assert.equal((await supertest(mini).post('/login')).status, 429);
});

// ------------------------------------------------------------------ 2FA obligatoire
let secret;
test('2FA obligatoire : propriétaire sans 2FA limité à sa configuration de la 2FA (API)', async () => {
  config.ownerMfaRequired = true;
  const me = (await admin.get('/api/auth/me')).body;
  assert.equal(me.user.mfaSetupRequired, true);
  const r = await admin.get('/api/patients');
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'MFA_SETUP_REQUIRED');
  assert.equal((await admin.get('/api/audit')).status, 403);
  assert.equal((await admin.get('/api/auth/mfa')).body.required, true);
  // les autres rôles ne sont pas concernés
  assert.equal((await victim.get('/api/payments')).status, 200);
  const s = await admin.post('/api/auth/mfa/setup').send({ password: 'Proprietaire2026' });
  assert.equal(s.status, 200);
  secret = s.body.secret;
  assert.equal((await admin.post('/api/auth/mfa/confirm').send({ code: hotp(secret, currentStep()) })).status, 200);
  assert.equal((await admin.get('/api/patients')).status, 200, 'accès rétabli après activation');
});

test('2FA obligatoire : désactivation refusée ; changement d\'appareil avec le second facteur actuel', async () => {
  const codes = (await admin.post('/api/auth/mfa/recovery-codes').send({ password: 'Proprietaire2026', code: hotp(secret, currentStep() + 1) })).body.recovery_codes;
  assert.equal(codes.length, 10);
  const d = await admin.post('/api/auth/mfa/disable').send({ password: 'Proprietaire2026', recovery_code: codes[0] });
  assert.equal(d.status, 403);
  assert.equal((await admin.get('/api/auth/mfa')).body.enabled, true);
  assert.equal((await admin.post('/api/auth/mfa/setup').send({ password: 'Proprietaire2026' })).status, 400, 'second facteur exigé');
  const s = await admin.post('/api/auth/mfa/setup').send({ password: 'Proprietaire2026', recovery_code: codes[1] });
  assert.equal(s.status, 200);
  const c = await admin.post('/api/auth/mfa/confirm').send({ code: hotp(s.body.secret, currentStep()) });
  assert.equal(c.status, 200);
  secret = s.body.secret;
  const { rows } = await pool.query(`SELECT action FROM audit_log WHERE action = 'auth.mfa_renewed'`);
  assert.equal(rows.length, 1);
});

// ------------------------------------------------------------------ récupération du propriétaire
test('récupération du propriétaire : garde-fous (motif, compte propriétaire, confirmation explicite)', async () => {
  await assert.rejects(recoverOwner({ username: 'admin', reason: 'court' }), /reason/);
  await assert.rejects(recoverOwner({ username: 'victime', reason: 'Téléphone perdu, identité vérifiée' }), /propriétaire/);
  await assert.rejects(recoverOwner({ username: 'nexistepas', reason: 'Téléphone perdu, identité vérifiée' }), /introuvable/);
  const r = spawnSync(process.execPath, ['src/db/owner-recovery.js', '--username', 'admin', '--reason', 'Téléphone perdu, identité vérifiée'], { encoding: 'utf8', env: { ...process.env } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--confirm "RECUPERER admin"/);
});

test('récupération du propriétaire : mot de passe temporaire, 2FA à reconfigurer, sessions révoquées, audit signé', async () => {
  const { password } = await recoverOwner({ username: 'admin', reason: 'Téléphone 2FA perdu — identité vérifiée par deux associés', operator: 'test' });
  assert.equal((await admin.get('/api/patients')).status, 401, 'sessions révoquées');
  assert.equal((await login('admin', 'Proprietaire2026')).loginRes.status, 401, 'ancien mot de passe invalide');
  const a = await login('admin', password);
  assert.equal(a.loginRes.status, 200);
  assert.equal(a.loginRes.body.mfa_required, undefined, '2FA désactivée par la procédure');
  let me = (await a.get('/api/auth/me')).body.user;
  assert.equal(me.mustChangePassword, true);
  await a.post('/api/auth/change-password').send({ currentPassword: password, newPassword: 'NouveauProprio2026' });
  const b = await login('admin', 'NouveauProprio2026');
  me = (await b.get('/api/auth/me')).body.user;
  assert.equal(me.mfaSetupRequired, true, '2FA à reconfigurer (obligatoire)');
  const { rows: [au] } = await pool.query(
    `SELECT a.*, s.sig FROM audit_log a JOIN audit_signatures s ON s.audit_id = a.id WHERE a.action = 'auth.owner_recovery'`);
  assert.ok(au && /^[0-9a-f]{64}$/.test(au.sig));
  assert.ok(!JSON.stringify(au).includes(password), 'mot de passe temporaire jamais journalisé');
  const { rows: [al] } = await pool.query(`SELECT severity FROM alerts WHERE type = 'recuperation_proprietaire'`);
  assert.equal(al.severity, 'haute');
  config.ownerMfaRequired = false;
  assert.equal((await b.get('/api/audit/verify')).body.ok, true);
});
