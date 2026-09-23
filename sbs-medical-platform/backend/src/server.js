import http from 'node:http';
import { Server } from 'socket.io';
import { parseCookie } from 'cookie';
import { config } from './config.js';
import { createApp } from './app.js';
import { migrate } from './db/migrate.js';
import { seed } from './db/seed.js';
import { setIo, makeContext } from './lib/realtime.js';
import { userFromToken, SESSION_COOKIE } from './lib/auth.js';
import { connected, disconnected } from './lib/presence.js';
import { checkExpiries } from './lib/stock.js';
import { checkBackups } from './lib/backupmon.js';
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

export function attachRealtime(server) {
  const io = new Server(server, { path: '/socket.io', serveClient: false, cors: config.corsOrigin ? { origin: config.corsOrigin, credentials: true } : undefined });
  io.use(async (socket, next) => {
    try {
      const cookies = parseCookie(socket.handshake.headers.cookie || '');
      const token = cookies[SESSION_COOKIE] || socket.handshake.auth?.token;
      const user = await userFromToken(token);
      if (!user || user.mustChangePassword) return next(new Error('unauthorized'));
      socket.data.user = user;
      next();
    } catch (e) { next(e); }
  });
  io.on('connection', (socket) => {
    const u = socket.data.user;
    socket.join(`user:${u.id}`);
    for (const p of u.permissions) socket.join(`perm:${p}`);
    connected(u.id);
    socket.on('disconnect', () => disconnected(u.id));
  });
  setIo(io);
  return io;
}

async function runPeriodicChecks() {
  try {
    const ctx = makeContext({ deferred: false });
    await tx((db) => checkExpiries(db, ctx));
    if (config.backupMonitoring) await tx((db) => checkBackups(db, ctx, { maxAgeHours: config.backupMaxAgeHours }));
  } catch (e) { console.error('Contrôle périodique en échec :', e.message); }
}

async function main() {
  // Les migrations ne s'exécutent que si les identifiants propriétaire sont fournis
  // (service « migrate » en production ; jamais dans le conteneur applicatif).
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
