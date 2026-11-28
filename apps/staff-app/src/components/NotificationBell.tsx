import type { UnreadCountDto } from '@hospitality/shared-types';
import { useRef, useState, type KeyboardEvent } from 'react';
import { useGet } from '../hooks/queries';
import { useRefetchOnEvents } from '../realtime/RealtimeProvider';
import { NotificationPanel } from './NotificationPanel';

const MAX_BADGE = 99;

/**
 * The bell in the menu for every role. The unread count comes from the server and is refetched
 * when a `notification.created` event arrives (and after a reconnect, when the provider refreshes
 * everything), so it is never worked out on this device.
 */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const count = useGet<UnreadCountDto>('/notifications/unread-count');
  useRefetchOnEvents(
    ['notification.created'],
    [['/notifications/unread-count'], ['/notifications']],
  );

  const unread = count.data?.data.unread ?? 0;
  const label = unread > 0 ? `Notifications, ${unread} unread` : 'Notifications';

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && open) {
      setOpen(false);
      button.current?.focus();
    }
  }

  return (
    <div className="relative" onKeyDown={onKeyDown}>
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls="notification-panel"
        onClick={() => setOpen((now) => !now)}
        className="relative rounded-md p-2 text-slate-200 hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-amber-300"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="h-5 w-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
        >
          <path d="M6 9a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z" strokeLinejoin="round" />
          <path d="M10 19a2 2 0 0 0 4 0" strokeLinecap="round" />
        </svg>
        {unread > 0 && (
          <span
            aria-hidden="true"
            className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-rose-600 px-1 text-center text-[10px] font-semibold leading-4 text-white"
          >
            {unread > MAX_BADGE ? `${MAX_BADGE}+` : unread}
          </span>
        )}
      </button>
      <span aria-live="polite" className="sr-only">
        {unread > 0 ? `${unread} unread notifications` : ''}
      </span>
      {open && <NotificationPanel onClose={() => setOpen(false)} />}
    </div>
  );
}
