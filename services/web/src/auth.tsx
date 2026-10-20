import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { api, getToken, Role, setToken, setUnauthorizedHandler, User } from './api';

const ORDER: Role[] = ['operator', 'supervisor', 'manager', 'admin'];
export const atLeast = (role: Role | undefined, min: Role) => !!role && ORDER.indexOf(role) >= ORDER.indexOf(min);

interface AuthState {
  user: User | null;
  ready: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
}

const Ctx = createContext<AuthState>(null as unknown as AuthState);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(logout);
    if (!getToken()) { setReady(true); return; }
    api<User>('/auth/me').then(setUser).catch(() => setToken(null)).finally(() => setReady(true));
  }, [logout]);

  const login = useCallback(async (username: string, password: string) => {
    const res = await api<{ token: string; user: User }>('/auth/login', { method: 'POST', body: { username, password } });
    setToken(res.token);
    setUser(res.user);
  }, []);

  return <Ctx.Provider value={{ user, ready, login, logout }}>{children}</Ctx.Provider>;
}
