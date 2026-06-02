/**
 * useIauditAuth — iAudit email/password auth state hook
 *
 * Stores the access token in memory (not localStorage — avoids XSS).
 * The refresh token is stored as an HttpOnly cookie by the server.
 *
 * Usage:
 *   const { user, accessToken, login, logout, isAuthenticated } = useIauditAuth();
 */

import { useState, useCallback, useEffect } from "react";
import { trpc } from "@/lib/trpc";

export interface IauditUser {
  id: string;
  email: string;
  name: string;
  accountType: "solo" | "agency" | "admin";
  emailVerified: boolean;
  creditsRemaining: number;
}

interface IauditAuthState {
  user: IauditUser | null;
  accessToken: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
}

// Module-level token store (survives re-renders, cleared on page unload)
let _accessToken: string | null = null;
let _user: IauditUser | null = null;
const _listeners: Set<() => void> = new Set();

function notifyListeners() {
  _listeners.forEach((fn) => fn());
}

export function setIauditSession(token: string, user: IauditUser) {
  _accessToken = token;
  _user = user;
  notifyListeners();
}

export function clearIauditSession() {
  _accessToken = null;
  _user = null;
  notifyListeners();
}

export function getAccessToken(): string | null {
  return _accessToken;
}

export function getIauditUserId(): string | null {
  return _user?.id ?? null;
}

export function useIauditAuth(): IauditAuthState & {
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<boolean>;
} {
  const [, forceUpdate] = useState(0);
  const refreshMutation = trpc.iauth.refresh.useMutation();
  const logoutMutation = trpc.iauth.logout.useMutation();
  const loginMutation = trpc.iauth.login.useMutation();

  useEffect(() => {
    const listener = () => forceUpdate((n) => n + 1);
    _listeners.add(listener);
    return () => {
      _listeners.delete(listener);
    };
  }, []);

  // Attempt silent token refresh on mount (uses HttpOnly cookie)
  useEffect(() => {
    if (!_accessToken) {
      refreshMutation.mutate(
        {},
        {
          onSuccess: (data) => {
            if (data.accessToken && data.user) {
              setIauditSession(data.accessToken, data.user as IauditUser);
            }
          },
          onError: () => {
            // No valid session — user needs to log in
          },
        }
      );
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      const data = await loginMutation.mutateAsync({ email, password });
      setIauditSession(data.accessToken, data.user as IauditUser);
    },
    [loginMutation]
  );

  const logout = useCallback(async () => {
    try {
      await logoutMutation.mutateAsync({});
    } catch {
      // ignore
    }
    clearIauditSession();
  }, [logoutMutation]);

  const refresh = useCallback(async (): Promise<boolean> => {
    try {
      const data = await refreshMutation.mutateAsync({});
      if (data.accessToken && data.user) {
        setIauditSession(data.accessToken, data.user as IauditUser);
        return true;
      }
      return false;
    } catch {
      clearIauditSession();
      return false;
    }
  }, [refreshMutation]);

  return {
    user: _user,
    accessToken: _accessToken,
    isAuthenticated: !!_accessToken && !!_user,
    isLoading: refreshMutation.isPending && !_accessToken,
    login,
    logout,
    refresh,
  };
}
