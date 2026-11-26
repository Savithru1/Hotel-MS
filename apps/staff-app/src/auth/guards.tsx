import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { Spinner } from '../components/ui';
import { useAuth } from './AuthContext';
import { canOpen, homePathFor } from './permissions';

/** Keeps signed-out visitors on the sign-in page and sends a pending password change to its page. */
export function RequireAuth() {
  const { state } = useAuth();
  const location = useLocation();

  if (state.status === 'loading') return <Spinner label="Checking your session" />;
  if (state.status === 'signedOut') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  if (state.staff.mustChangePassword && location.pathname !== '/account/password') {
    return <Navigate to="/account/password" replace />;
  }
  return <Outlet />;
}

/**
 * Only lets roles that may open `path` through. Hiding a link is not security (the server
 * refuses the request anyway); this stops a person landing on a page that would only show errors.
 */
export function RequirePage({ path, children }: { path: string; children: ReactNode }) {
  const { state } = useAuth();
  if (state.status !== 'signedIn') return null;
  if (!canOpen(state.staff.role, path)) {
    return <Navigate to={homePathFor(state.staff.role)} replace />;
  }
  return <>{children}</>;
}

/** The sign-in page is not for people who are already signed in. */
export function RedirectIfSignedIn({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  if (state.status === 'signedIn') return <Navigate to={homePathFor(state.staff.role)} replace />;
  return <>{children}</>;
}
