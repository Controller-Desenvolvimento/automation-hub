import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from 'react';
import { api, getStoredToken, setStoredToken } from '../lib/api';
import type { SessionResponse, User } from '../lib/types';

type AuthContextValue = {
  user: User | null;
  bootstrapping: boolean;
  login: (payload: { login: string; password: string }) => Promise<void>;
  logout: () => Promise<void>;
  updateUser: (patch: Partial<User>) => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: PropsWithChildren) {
  const [user, setUser] = useState<User | null>(null);
  const [bootstrapping, setBootstrapping] = useState(true);

  useEffect(() => {
    async function restoreSession() {
      const token = getStoredToken();
      if (!token) {
        setBootstrapping(false);
        return;
      }

      try {
        const me = await api<User>('/auth/me');
        setUser(me);
      } catch {
        setStoredToken(null);
        setUser(null);
      } finally {
        setBootstrapping(false);
      }
    }

    void restoreSession();
  }, []);

  const login = useCallback(async (payload: { login: string; password: string }) => {
    const session = await api<SessionResponse>('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    setStoredToken(session.token);
    setUser(session.user);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } finally {
      setStoredToken(null);
      setUser(null);
    }
  }, []);

  const updateUser = useCallback((patch: Partial<User>) => {
    setUser((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  const value = useMemo(
    () => ({ user, bootstrapping, login, logout, updateUser }),
    [bootstrapping, login, logout, updateUser, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
