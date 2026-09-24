import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, setAuthHandlers } from './api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [state, setState] = useState({ loading: true, user: null, clinic: null, expenseCategories: [] });

  const refresh = useCallback(async () => {
    try {
      const me = await api.get('/auth/me');
      setState({ loading: false, expired: false, ...me });
    } catch {
      setState({ loading: false, user: null, clinic: null, expenseCategories: [] });
    }
  }, []);

  useEffect(() => {
    setAuthHandlers({
      // session expirée (inactivité, durée maximale) ou révoquée : retour à l'écran de connexion
      onUnauthorized: () => setState((s) => ({ ...s, user: null, expired: !!s.user })),
      // mot de passe temporaire ou 2FA obligatoire non configurée : on relit l'état réel de la session
      onPasswordChange: () => refresh(),
    });
    refresh();
  }, [refresh]);

  // Retourne { mfa_required, mfa_token } si la double authentification est activée pour ce compte
  const login = async (username, password) => {
    const r = await api.post('/auth/login', { username, password });
    if (r?.mfa_required) return r;
    await refresh();
    return r;
  };
  const loginMfa = async (mfaToken, { code, recoveryCode }) => {
    await api.post('/auth/login/mfa', { mfa_token: mfaToken, code: code || undefined, recovery_code: recoveryCode || undefined });
    await refresh();
  };
  const logout = async () => {
    try { await api.post('/auth/logout'); } finally {
      navigator.serviceWorker?.controller?.postMessage('purge'); // purge des caches à la déconnexion
      setState((s) => ({ ...s, user: null }));
    }
  };
  const can = (...perms) => !!state.user && (state.user.superadmin || perms.some((p) => state.user.permissions.includes(p)));

  return <AuthContext.Provider value={{ ...state, refresh, login, loginMfa, logout, can }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
