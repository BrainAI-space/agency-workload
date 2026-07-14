import { createContext, type ReactNode, use, useEffect, useState } from "react";
import { api, type SessionResponse, type SessionUser } from "../lib/api";

type AuthStatus = "loading" | "authenticated" | "unauthenticated";

interface AuthContextValue {
  status: AuthStatus;
  user: SessionUser | null;
  csrfToken: string | null;
  requestCode(email: string): Promise<string>;
  verifyCode(email: string, code: string): Promise<void>;
  logout(): Promise<void>;
  refresh(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<SessionUser | null>(null);
  const [csrfToken, setCsrfToken] = useState<string | null>(null);

  const applySession = (session: SessionResponse) => {
    if (session.authenticated && session.user) {
      setStatus("authenticated");
      setUser(session.user);
      setCsrfToken(session.csrfToken ?? null);
    } else {
      setStatus("unauthenticated");
      setUser(null);
      setCsrfToken(null);
    }
  };

  const refresh = async () => {
    try {
      applySession(await api.getSession());
    } catch {
      applySession({ authenticated: false });
    }
  };

  useEffect(() => {
    let active = true;
    void api
      .getSession()
      .then((session) => {
        if (!active) return;
        if (session.authenticated && session.user) {
          setStatus("authenticated");
          setUser(session.user);
          setCsrfToken(session.csrfToken ?? null);
        } else {
          setStatus("unauthenticated");
          setUser(null);
          setCsrfToken(null);
        }
      })
      .catch(() => {
        if (active) setStatus("unauthenticated");
      });
    return () => {
      active = false;
    };
  }, []);

  const value: AuthContextValue = {
    status,
    user,
    csrfToken,
    requestCode: async (email) => (await api.requestCode(email)).message,
    verifyCode: async (email, code) => applySession(await api.verifyCode(email, code)),
    logout: async () => {
      if (!csrfToken) throw new Error("Session security token is unavailable");
      await api.logout(csrfToken);
      applySession({ authenticated: false });
    },
    refresh,
  };

  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): AuthContextValue {
  const context = use(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}
