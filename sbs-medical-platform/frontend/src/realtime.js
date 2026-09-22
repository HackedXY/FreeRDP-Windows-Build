import { useEffect, useRef } from 'react';
import { io } from 'socket.io-client';

let socket = null;
const listeners = new Set();

export function connectRealtime() {
  if (socket) return socket;
  socket = io({ path: '/socket.io', withCredentials: true, transports: ['websocket', 'polling'] });
  socket.onAny((event, payload) => { for (const l of listeners) l(event, payload); });
  socket.on('connect', () => { for (const l of listeners) l('connect', null); });
  socket.on('disconnect', () => { for (const l of listeners) l('disconnect', null); });
  return socket;
}

export function disconnectRealtime() { if (socket) { socket.disconnect(); socket = null; } }

/** Abonnement aux événements temps réel : handler(event, payload). */
export function useRealtime(handler) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const l = (e, p) => ref.current(e, p);
    listeners.add(l);
    return () => listeners.delete(l);
  }, []);
}

export const isConnected = () => !!socket?.connected;
