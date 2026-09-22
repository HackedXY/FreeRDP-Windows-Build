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
import { tx } from './db/pool.js';

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
  } catch (e) { console.error('Contrôle périodique en échec :', e.message); }
}

async function main() {
  await migrate();
  await seed();
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
