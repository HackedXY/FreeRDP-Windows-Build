// Diffusion temps réel (Socket.IO). Les sockets rejoignent des « salons »
// user:<id> et perm:<code> selon leurs permissions ; les événements ne sont
// donc reçus que par les utilisateurs autorisés à les voir.
let io = null;

export function setIo(instance) { io = instance; }

export function emit(room, event, payload) {
  if (io) io.to(room).emit(event, payload);
}

/** Déconnecte toutes les sockets d'un utilisateur (compte désactivé, etc.). */
export function disconnectUser(userId) {
  if (io) io.in(`user:${userId}`).disconnectSockets(true);
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
