// Diffusion temps réel (Socket.IO) avec autorisation vérifiée À CHAQUE LIVRAISON.
//
// Les droits ne sont pas figés à la connexion : pour chaque événement, chaque socket
// est réautorisée (session valide et non expirée, compte actif, permission requise).
// Les révocations (déconnexion, désactivation, réinitialisation de mot de passe,
// retrait de permission ou modification de rôle) rafraîchissent immédiatement les
// sockets concernées, avant la réponse HTTP ; un cache court (REALTIME_AUTH_CACHE_MS)
// et un contrôle périodique couvrent les révocations faites hors de l'application.
// Hypothèse : une seule instance de l'API (pas d'adaptateur multi-nœuds).
import { userFromSessionId, can } from './auth.js';

let io = null;
const CACHE_MS = Number(process.env.REALTIME_AUTH_CACHE_MS ?? 2000);
let chain = Promise.resolve();

export function setIo(instance) { io = instance; }

const sockets = () => (io ? [...io.of('/').sockets.values()] : []);

/** (Ré)autorise une socket ; la déconnecte si la session n'est plus valide. */
export async function authorizeSocket(socket, force = false) {
  const d = socket.data;
  if (!d?.sessionId) { socket.disconnect(true); return null; }
  if (!force && d.expiresAt <= Date.now()) { socket.disconnect(true); return null; }
  if (force || Date.now() - d.checkedAt > CACHE_MS) {
    const user = await userFromSessionId(d.sessionId);
    if (!user || user.mustChangePassword || user.sessionExpiresAt <= Date.now()) { socket.disconnect(true); return null; }
    d.user = user; d.expiresAt = user.sessionExpiresAt; d.checkedAt = Date.now();
  }
  return d.user;
}

async function deliver(room, event, payload) {
  const [kind, ...rest] = room.split(':');
  const key = rest.join(':');
  for (const socket of sockets()) {
    if (kind === 'user' && socket.data.userId !== Number(key)) continue;
    const user = await authorizeSocket(socket);
    if (!user) continue;
    if (kind === 'perm' && !can(user, key)) continue;
    socket.emit(event, payload);
  }
}

/** Émission autorisée ; les événements sont livrés dans l'ordre d'émission. */
export function emit(room, event, payload) {
  chain = chain.then(() => deliver(room, event, payload)).catch((e) => console.error('Temps réel :', e.message));
  return chain;
}

/** Rafraîchit immédiatement les droits des sockets concernées (ou de toutes). */
export async function refreshRealtime({ userIds = null } = {}) {
  await chain;
  for (const socket of sockets()) {
    if (userIds && !userIds.includes(socket.data.userId)) continue;
    await authorizeSocket(socket, true);
  }
}

/** Déconnecte toutes les sockets d'un utilisateur (compte désactivé, mot de passe réinitialisé). */
export function disconnectUser(userId) {
  for (const s of sockets()) if (s.data.userId === userId) s.disconnect(true);
}

/** Déconnecte les sockets ouvertes avec une session donnée (déconnexion). */
export function disconnectSession(sessionId) {
  for (const s of sockets()) if (s.data.sessionId === sessionId) s.disconnect(true);
}

/** Contrôle périodique : révocations faites directement en base, sessions expirées. */
export function startRealtimeSweep(intervalMs = 30000) {
  return setInterval(() => { refreshRealtime().catch(() => {}); }, intervalMs).unref();
}

/**
 * Contexte d'exécution : utilisateur courant + file d'événements temps réel
 * différés (émis seulement après la réussite de la requête / transaction).
 */
export function makeContext({ user = null, ip = null, userAgent = null, deferred = true } = {}) {
  const queue = [];
  return {
    user, ip, userAgent,
    emit(room, event, payload) {
      if (deferred) queue.push([room, event, payload]);
      else emit(room, event, payload);
    },
    flush() {
      for (const [room, event, payload] of queue.splice(0)) emit(room, event, payload);
    },
    discard() { queue.length = 0; },
  };
}
