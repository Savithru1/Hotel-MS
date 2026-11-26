import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { ApiProvider } from './api/ApiContext';
import { ApiError, type ApiClient } from './api/client';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { RedirectIfSignedIn, RequireAuth, RequirePage } from './auth/guards';
import { homePathFor } from './auth/permissions';
import { ToastProvider } from './components/Toast';
import { AppLayout } from './layouts/AppLayout';
import { BookingsPage } from './pages/front-desk/BookingsPage';
import { CalendarPage } from './pages/front-desk/CalendarPage';
import { FrontDeskPage } from './pages/front-desk/FrontDeskPage';
import { GuestsPage } from './pages/front-desk/GuestsPage';
import { NewBookingPage } from './pages/front-desk/NewBookingPage';
import { HousekeepingPage } from './pages/housekeeping/HousekeepingPage';
import { ChangePasswordPage } from './pages/login/ChangePasswordPage';
import { LoginPage } from './pages/login/LoginPage';
import { MaintenancePage } from './pages/maintenance/MaintenancePage';
import { PropertyPage } from './pages/manager/PropertyPage';
import { RoomTypesPage } from './pages/manager/RoomTypesPage';
import { RoomsPage } from './pages/manager/RoomsPage';
import { StaffPage } from './pages/manager/StaffPage';
import { WelcomePage } from './pages/WelcomePage';
import { RealtimeProvider, type SocketFactory } from './realtime/RealtimeProvider';

/** A refused request will not succeed by asking again, so only network and server faults retry. */
function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (count, error) =>
          count < 2 && !(error instanceof ApiError && error.status >= 400 && error.status < 500),
        refetchOnWindowFocus: true,
        staleTime: 5_000,
      },
    },
  });
}

export function AppProviders({ client, children }: { client: ApiClient; children: ReactNode }) {
  const [queries] = useState(createQueryClient);
  return (
    <QueryClientProvider client={queries}>
      <ApiProvider client={client}>
        <AuthProvider>
          <ToastProvider>{children}</ToastProvider>
        </AuthProvider>
      </ApiProvider>
    </QueryClientProvider>
  );
}

function HomeRedirect() {
  const { state } = useAuth();
  if (state.status !== 'signedIn') return null;
  return <Navigate to={homePathFor(state.staff.role)} replace />;
}

function Shell({ createSocket }: { createSocket?: SocketFactory }) {
  return (
    <RealtimeProvider {...(createSocket ? { createSocket } : {})}>
      <AppLayout />
    </RealtimeProvider>
  );
}

const page = (path: string, element: ReactNode) => (
  <Route path={path.slice(1)} element={<RequirePage path={path}>{element}</RequirePage>} />
);

export function AppRoutes({ createSocket }: { createSocket?: SocketFactory }) {
  return (
    <Routes>
      <Route
        path="/login"
        element={
          <RedirectIfSignedIn>
            <LoginPage />
          </RedirectIfSignedIn>
        }
      />
      <Route element={<RequireAuth />}>
        <Route element={<Shell {...(createSocket ? { createSocket } : {})} />}>
          <Route index element={<HomeRedirect />} />
          <Route path="welcome" element={<WelcomePage />} />
          <Route path="account/password" element={<ChangePasswordPage />} />
          {page('/front-desk', <FrontDeskPage />)}
          {page('/bookings', <BookingsPage />)}
          {page('/bookings/new', <NewBookingPage />)}
          {page('/calendar', <CalendarPage />)}
          {page('/guests', <GuestsPage />)}
          {page('/housekeeping', <HousekeepingPage />)}
          {page('/maintenance', <MaintenancePage />)}
          {page('/rooms', <RoomsPage />)}
          {page('/room-types', <RoomTypesPage />)}
          {page('/staff', <StaffPage />)}
          {page('/property', <PropertyPage />)}
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
