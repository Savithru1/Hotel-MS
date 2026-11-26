import type { PropertySummaryDto, StaffDto } from '@hospitality/shared-types';
import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useApi } from '../api/ApiContext';

type AuthState =
  | { status: 'loading' }
  | { status: 'signedOut'; expired: boolean }
  | { status: 'signedIn'; staff: StaffDto; property: PropertySummaryDto };

export interface AuthContextValue {
  state: AuthState;
  signIn(input: { propertySlug: string; email: string; password: string }): Promise<void>;
  signOut(): Promise<void>;
  changePassword(currentPassword: string, newPassword: string): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Owns who is signed in. On load it tries to resume from the stored refresh token. The role it
 * exposes is what the server returned; it is used to decide which links and pages to show, and
 * the server checks every request again.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const queries = useQueryClient();
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    api
      .restore()
      .then((session) => {
        if (cancelled) return;
        setState(
          session
            ? { status: 'signedIn', staff: session.staff, property: session.property }
            : { status: 'signedOut', expired: false },
        );
      })
      .catch(() => {
        // The server could not be reached; show the sign-in page, which reports the problem.
        if (!cancelled) setState({ status: 'signedOut', expired: false });
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  // When the API client gives up renewing the session, show the sign-in page.
  useEffect(() => {
    return api.onTokenChange((token) => {
      if (token === null) {
        setState((current) =>
          current.status === 'signedIn' ? { status: 'signedOut', expired: true } : current,
        );
        queries.clear();
      }
    });
  }, [api, queries]);

  const signIn = useCallback<AuthContextValue['signIn']>(
    async (input) => {
      const session = await api.login(input);
      queries.clear();
      setState({ status: 'signedIn', staff: session.staff, property: session.property });
    },
    [api, queries],
  );

  const signOut = useCallback(async () => {
    // Set first, so the token-change listener does not report this as an expired session.
    setState({ status: 'signedOut', expired: false });
    await api.logout();
    queries.clear();
  }, [api, queries]);

  const changePassword = useCallback<AuthContextValue['changePassword']>(
    async (currentPassword, newPassword) => {
      const session = await api.changePassword(currentPassword, newPassword);
      setState({ status: 'signedIn', staff: session.staff, property: session.property });
    },
    [api],
  );

  const value = useMemo(
    () => ({ state, signIn, signOut, changePassword }),
    [state, signIn, signOut, changePassword],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}

/** The signed-in staff member. Only call this below a route guard. */
export function useStaff(): { staff: StaffDto; property: PropertySummaryDto } {
  const { state } = useAuth();
  if (state.status !== 'signedIn') throw new Error('useStaff used while signed out');
  return { staff: state.staff, property: state.property };
}
