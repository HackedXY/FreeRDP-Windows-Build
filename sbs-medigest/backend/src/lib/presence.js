// Présence en ligne (nombre de sockets ouvertes par utilisateur)
const counts = new Map();
export function connected(userId) { counts.set(userId, (counts.get(userId) || 0) + 1); }
export function disconnected(userId) {
  const n = (counts.get(userId) || 1) - 1;
  if (n <= 0) counts.delete(userId); else counts.set(userId, n);
}
export function onlineUserIds() { return [...counts.keys()]; }
