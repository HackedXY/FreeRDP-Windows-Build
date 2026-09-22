import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, setAuthHandlers } from './api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [state, setState] = useState({ loading: true, user: null, clinic: null, expenseCategories: [] });

  const refresh = useCallback(async () => {
    try {
      const me = await api.get('/auth/me');
      setState({ loading: false, ...me });
    } catch {
      setState({ loading: false, user: null, clinic: null, expenseCategories: [] });
    }
  }, []);

  useEffect(() => {
    setAuthHandlers({
      onUnauthorized: () => setState((s) => ({ ...s, user: null })),
      onPasswordChange: () => setState((s) => (s.user ? { ...s, user: { ...s.user, mustChangePassword: true } } : s)),
    });
    refresh();
  }, [refresh]);

  const login = async (username, password) => { await api.post('/auth/login', { username, password }); await refresh(); };
  const logout = async () => { try { await api.post('/auth/logout'); } finally { setState((s) => ({ ...s, user: null })); } };
  const can = (...perms) => !!state.user && (state.user.superadmin || perms.some((p) => state.user.permissions.includes(p)));

  return <AuthContext.Provider value={{ ...state, refresh, login, logout, can }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
