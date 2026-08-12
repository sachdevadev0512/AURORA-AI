import { createContext, useContext, useEffect, useState } from 'react';
import { login as loginRequest, register as registerRequest, getMe as getMeRequest } from '../api';
import { User } from '../types';

interface AuthContextValue {
  user: User | null;
  token: string | null;
  loading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<void>;
  logout: () => void;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

const storageTokenKey = 'aurora_token';

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(storageTokenKey));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const setSession = (newToken: string | null) => {
    setToken(newToken);
    if (newToken) {
      localStorage.setItem(storageTokenKey, newToken);
    } else {
      localStorage.removeItem(storageTokenKey);
    }
  };

  const refreshUser = async () => {
    if (!token) {
      setUser(null);
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      const session = await getMeRequest(token);
      setUser(session.data);
      setError(null);
    } catch (err) {
      setUser(null);
      setSession(null);
      setError('Session expired. Please login again.');
    } finally {
      setLoading(false);
    }
  };

  const login = async (email: string, password: string) => {
    try {
      setLoading(true);
      const response = await loginRequest(email, password);
      setSession(response.token);
      const session = await getMeRequest(response.token);
      setUser(session.data);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
      throw err;
    } finally {
      setLoading(false);
    }
  };

  const register = async (name: string, email: string, password: string) => {
    try {
      setLoading(true);
      const response = await registerRequest(name, email, password);
      setSession(response.token);
      const session = await getMeRequest(response.token);
      setUser(session.data);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
      throw err;
    } finally {
      setLoading(false);
    }
  };

  const logout = () => {
    setSession(null);
    setUser(null);
  };

  useEffect(() => {
    void refreshUser();
  }, [token]);

  return (
    <AuthContext.Provider value={{ user, token, loading, error, login, register, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}
