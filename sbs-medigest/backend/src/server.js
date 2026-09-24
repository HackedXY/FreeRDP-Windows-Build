import http from 'node:http';
import { Server } from 'socket.io';
import { parseCookie } from 'cookie';
import { config, requireRuntimeKeys } from './config.js';
import { createApp } from './app.js';
import { migrate } from './db/migrate.js';
import { seed } from './db/seed.js';
import { setIo, makeContext, startRealtimeSweep } from './lib/realtime.js';
import { userFromToken, SESSION_COOKIE } from './lib/auth.js';
import { connected, disconnected } from './lib/presence.js';
import { checkExpiries } from './lib/stock.js';
import { checkBackups } from './lib/backupmon.js';
import { checkUnpaidSales } from './lib/receivables.js';
import { tx, pool } from './db/pool.js';

/**
 * Refuse de démarrer si l'application est connectée avec le rôle propriétaire du
 * schéma ou un superutilisateur : ces droits permettraient de réécrire l'audit.
 */
async function assertLeastPrivilege() {
  const { rows: [r] } = await pool.query(
    `SELECT r.rolsuper AS superuser,
       pg_has_role(current_user, (SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'audit_log'), 'MEMBER') AS owner
     FROM pg_roles r WHERE r.rolname = current_user`);
  if (r.superuser || r.owner) {
    const msg = 'La connexion applicative (DATABASE_URL) dispose des droits propriétaire/superutilisateur : utilisez le rôle restreint sbs_app.';
    if (config.isProd) throw new Error(msg);
    console.warn(`⚠️  ${msg} (toléré hors production)`);
  }
}

/** Origine autorisée pour la poignée de main WebSocket (protection contre le détournement inter-sites). */
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // clients non navigateurs : l'authentification par session reste exigée
  try {
    const o = new URL(origin);
    if (config.corsOrigin && origin === config.corsOrigin) return true;
    return o.host === req.headers.host || o.host === req.headers['x-forwarded-host'];
  } catch { return false; }
}

export function attachRealtime(server) {
  const io = new Server(server, {
    path: '/socket.io', serveClient: false,
    cors: config.corsOrigin ? { origin: config.corsOrigin, credentials: true } : undefined,
    allowRequest: (req, cb) => cb(null, originAllowed(req)),
  });
  io.use(async (socket, next) => {
    try {
      const cookies = parseCookie(socket.handshake.headers.cookie || '');
      const token = cookies[SESSION_COOKIE] || socket.handshake.auth?.token;
      const user = await userFromToken(token, { touch: false });
      if (!user || user.mustChangePassword || user.mfaSetupRequired) return next(new Error('unauthorized'));
      // aucun salon par permission : l'autorisation est vérifiée à chaque livraison
      socket.data = { userId: user.id, sessionId: user.sessionId, expiresAt: user.sessionExpiresAt, user, checkedAt: Date.now() };
      next();
    } catch (e) { next(e); }
  });
  io.on('connection', (socket) => {
    connected(socket.data.userId);
    socket.on('disconnect', () => disconnected(socket.data.userId));
  });
  setIo(io);
  startRealtimeSweep();
  return io;
}

async function runPeriodicChecks() {
  try {
    const ctx = makeContext({ deferred: false });
    await tx((db) => checkExpiries(db, ctx));
    await tx((db) => checkUnpaidSales(db, ctx));
    if (config.backupMonitoring) await tx((db) => checkBackups(db, ctx, { maxAgeHours: config.backupMaxAgeHours }));
  } catch (e) { console.error('Contrôle périodique en échec :', e.message); }
}

async function main() {
  // Les migrations ne s'exécutent que si les identifiants propriétaire sont fournis
  // (service « migrate » en production ; jamais dans le conteneur applicatif).
  requireRuntimeKeys(); // clés de chiffrement et d'audit : obligatoires pour l'application
  if (config.migrationDatabaseUrl) { await migrate(); await seed(); }
  await assertLeastPrivilege();
  const app = createApp();
  const server = http.createServer(app);
  attachRealtime(server);
  server.listen(config.port, () => console.log(`✔ API SBS démarrée sur le port ${config.port}`));
  runPeriodicChecks();
  setInterval(runPeriodicChecks, 60 * 60 * 1000);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
