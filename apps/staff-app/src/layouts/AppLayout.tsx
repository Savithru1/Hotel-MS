import { NavLink, Outlet } from 'react-router';
import { useAuth, useStaff } from '../auth/AuthContext';
import { NAV_ITEMS, navFor, type NavItem } from '../auth/permissions';
import { Button, words } from '../components/ui';
import { useConnectionStatus, type ConnectionStatus } from '../realtime/RealtimeProvider';

const GROUPS: NavItem['group'][] = ['Front desk', 'Operations', 'Setup'];

const STATUS_TEXT: Record<ConnectionStatus, string> = {
  connecting: 'Connecting to live updates…',
  connected: 'Live',
  reconnecting: 'Reconnecting… screens may be out of date',
  offline: 'Offline. Reload the page to reconnect',
};

export function ConnectionIndicator() {
  const status = useConnectionStatus();
  const healthy = status === 'connected';
  return (
    <p
      role="status"
      aria-label="Live update connection"
      className={`flex items-center gap-2 text-xs ${healthy ? 'text-emerald-300' : 'text-amber-300'}`}
    >
      <span
        aria-hidden="true"
        className={`h-2 w-2 rounded-full ${healthy ? 'bg-emerald-400' : 'animate-pulse bg-amber-400'}`}
      />
      {STATUS_TEXT[status]}
    </p>
  );
}

export function AppLayout() {
  const { staff, property } = useStaff();
  const { signOut } = useAuth();
  const items = navFor(staff.role);

  return (
    <div className="min-h-screen md:flex">
      <aside className="flex flex-col gap-6 bg-slate-900 p-4 text-slate-200 md:min-h-screen md:w-60 md:shrink-0">
        <div>
          <p className="font-serif text-lg text-amber-200">{property.name}</p>
          <p className="text-xs text-slate-400">Staff</p>
        </div>

        <nav aria-label="Main" className="flex flex-1 flex-col gap-4">
          {GROUPS.map((group) => {
            const inGroup = items.filter((item) => item.group === group);
            if (inGroup.length === 0) return null;
            return (
              <div key={group}>
                <p className="mb-1 px-2 text-xs uppercase tracking-wider text-slate-500">{group}</p>
                <ul className="flex flex-wrap gap-1 md:block">
                  {inGroup.map((item) => (
                    <li key={item.path}>
                      <NavLink
                        to={item.path}
                        end={item.path === '/bookings'}
                        className={({ isActive }) =>
                          `block rounded-md px-2 py-1.5 text-sm ${
                            isActive
                              ? 'bg-slate-700 text-white'
                              : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                          }`
                        }
                      >
                        {item.label}
                      </NavLink>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </nav>

        <div className="flex flex-col gap-3 border-t border-slate-700 pt-4">
          <ConnectionIndicator />
          <div className="text-sm">
            <p className="font-medium text-white">{staff.name}</p>
            <p className="text-xs capitalize text-slate-400">{words(staff.role)}</p>
          </div>
          <div className="flex gap-2">
            <NavLink
              to="/account/password"
              className="rounded-md px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
            >
              Password
            </NavLink>
            <Button
              variant="quiet"
              small
              className="!text-slate-200 hover:!bg-slate-800"
              onClick={() => void signOut()}
            >
              Sign out
            </Button>
          </div>
        </div>
      </aside>

      <main className="min-w-0 flex-1 p-4 md:p-8">
        <Outlet />
      </main>
    </div>
  );
}

export { NAV_ITEMS };
