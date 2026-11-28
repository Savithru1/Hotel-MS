import type { NotificationDto } from '@hospitality/shared-types';
import { useNavigate } from 'react-router';
import { useStaff } from '../auth/AuthContext';
import { useList, useSend } from '../hooks/queries';
import { notificationPath } from './notification-links';
import { useToast } from './Toast';
import { Async, Badge, Button, EmptyState, dateTimeLabel, errorText } from './ui';

interface ItemProps {
  item: NotificationDto;
  path: string | null;
  onOpen: (item: NotificationDto, path: string) => void;
  onMarkRead: (item: NotificationDto) => void;
}

function NotificationItem({ item, path, onOpen, onMarkRead }: ItemProps) {
  const unread = item.readAt === null;
  const title = path ? (
    <button
      type="button"
      onClick={() => onOpen(item, path)}
      className="text-left text-sm font-semibold text-teal-900 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-teal-800"
    >
      {item.title}
    </button>
  ) : (
    <p className="text-sm font-semibold text-slate-900">{item.title}</p>
  );

  return (
    <li className={`flex items-start justify-between gap-2 py-3 ${unread ? '' : 'opacity-70'}`}>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          {title}
          {unread && <Badge tone="info">New</Badge>}
        </div>
        <p className="text-sm text-slate-700">{item.body}</p>
        <p className="text-xs text-slate-500">{dateTimeLabel(item.createdAt)}</p>
      </div>
      {unread && (
        <Button
          variant="quiet"
          small
          aria-label={`Mark "${item.title}" as read`}
          onClick={() => onMarkRead(item)}
        >
          Mark read
        </Button>
      )}
    </li>
  );
}

const PAGE_SIZE = 20;

/** The latest notifications for the signed-in person, with mark read and mark all read. */
export function NotificationPanel({ onClose }: { onClose: () => void }) {
  const { staff } = useStaff();
  const navigate = useNavigate();
  const toast = useToast();
  const list = useList<NotificationDto>('/notifications', { limit: PAGE_SIZE });
  const markRead = useSend<NotificationDto, { id: string }>(
    'post',
    (body) => `/notifications/${body.id}/read`,
    ['/notifications'],
  );
  const markAll = useSend<unknown, void>('post', '/notifications/read-all', ['/notifications']);
  const fail = (error: unknown): void => toast.error(errorText(error));
  const unread = list.items.filter((item) => item.readAt === null).length;

  function open(item: NotificationDto, path: string): void {
    if (item.readAt === null) markRead.mutate({ id: item.id }, { onError: fail });
    onClose();
    navigate(path);
  }

  return (
    <section
      id="notification-panel"
      aria-label="Notifications"
      className="absolute left-0 top-full z-40 mt-2 w-[22rem] max-w-[calc(100vw-2rem)] rounded-lg bg-white p-4 text-slate-900 shadow-xl ring-1 ring-stone-200"
    >
      <header className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold tracking-wide text-slate-700">Notifications</h2>
        <div className="flex gap-1">
          <Button
            variant="quiet"
            small
            disabled={unread === 0 || markAll.isPending}
            onClick={() => markAll.mutate(undefined, { onError: fail })}
          >
            Mark all read
          </Button>
          <Button variant="quiet" small aria-label="Close notifications" onClick={onClose}>
            ✕
          </Button>
        </div>
      </header>
      <Async query={list}>
        {list.items.length === 0 ? (
          <EmptyState>You have no notifications.</EmptyState>
        ) : (
          <ul className="max-h-96 divide-y divide-stone-100 overflow-y-auto">
            {list.items.map((item) => (
              <NotificationItem
                key={item.id}
                item={item}
                path={notificationPath(staff.role, item.link.kind)}
                onOpen={open}
                onMarkRead={(target) => markRead.mutate({ id: target.id }, { onError: fail })}
              />
            ))}
          </ul>
        )}
        {list.meta && list.meta.total > list.items.length && (
          <p className="mt-2 text-xs text-slate-500">
            Showing the latest {list.items.length} of {list.meta.total}
          </p>
        )}
      </Async>
    </section>
  );
}
