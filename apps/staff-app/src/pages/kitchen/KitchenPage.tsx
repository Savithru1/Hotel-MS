import {
  FOOD_ORDER_OPEN_STATUSES,
  LATE_ORDER_MINUTES,
  type FoodOrderStatus,
} from '@hospitality/constants';
import type { FoodOrderDto, FoodOrderSummaryDto } from '@hospitality/shared-types';
import { useState } from 'react';
import { useStaff } from '../../auth/AuthContext';
import { isManager } from '../../auth/permissions';
import {
  Async,
  Badge,
  Button,
  EmptyState,
  ErrorNotice,
  PageHeader,
  errorText,
  timeLabel,
} from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useGet, useList, useSend } from '../../hooks/queries';
import { useNow } from '../../hooks/useNow';
import { useRealtime, useRefetchOnEvents } from '../../realtime/RealtimeProvider';
import { CancelOrderDialog } from './CancelOrderDialog';
import { NewFoodOrderDialog } from './NewFoodOrderDialog';
import { describeSelections } from './cart';
import { playChime } from './chime';

const OPEN: readonly FoodOrderStatus[] = FOOD_ORDER_OPEN_STATUSES;

const COLUMNS = [
  { title: 'Received', status: 'received', empty: 'No new orders.' },
  { title: 'Preparing', status: 'preparing', empty: 'Nothing is being prepared.' },
  { title: 'Ready to serve', status: 'ready', empty: 'Nothing is waiting to be served.' },
] as const;

function minutesOld(order: FoodOrderDto, now: number): number {
  return Math.max(0, Math.floor((now - Date.parse(order.createdAt)) / 60_000));
}

/** Only an order that is still open can be late: a delivered one has nothing left to do. */
function isLate(order: FoodOrderDto, now: number): boolean {
  return (
    OPEN.includes(order.status) && now - Date.parse(order.createdAt) > LATE_ORDER_MINUTES * 60_000
  );
}

function OrderCard({
  order,
  now,
  canCook,
  onCancel,
}: {
  order: FoodOrderDto;
  now: number;
  canCook: boolean;
  onCancel: (order: FoodOrderDto) => void;
}) {
  const toast = useToast();
  const base = `/food-orders/${order.id}`;
  const refresh = ['/food-orders'];
  const start = useSend<FoodOrderDto, void>('post', `${base}/start`, refresh);
  const ready = useSend<FoodOrderDto, void>('post', `${base}/ready`, refresh);
  const deliver = useSend<FoodOrderDto, void>('post', `${base}/deliver`, refresh);
  const fail = (error: unknown): void => toast.error(errorText(error));
  const late = isLate(order, now);

  return (
    <li
      className={`rounded-lg p-3 ring-1 ring-inset ${late ? 'bg-rose-50 ring-rose-300' : 'bg-white ring-stone-200'}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-slate-900">Room {order.roomNumber}</p>
          <p className="text-xs text-slate-600">{order.guestName}</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className="font-mono text-xs text-slate-500">{order.code}</span>
          {late && <Badge tone="bad">Late</Badge>}
        </div>
      </div>

      <ul className="mt-2 space-y-1">
        {order.items.map((line, index) => (
          <li key={`${line.menuItemId}-${index}`} className="text-sm text-slate-800">
            <span>
              {line.quantity} × {line.name}
            </span>
            {line.options.length > 0 && (
              <span className="block text-xs text-slate-600">
                {describeSelections(line.options.map((o) => ({ group: o.group, choice: o.label })))}
              </span>
            )}
            {line.note && <span className="block text-xs text-slate-600">Note: {line.note}</span>}
          </li>
        ))}
      </ul>
      {order.notes && <p className="mt-2 text-xs text-slate-700">Order note: {order.notes}</p>}
      <p className="mt-2 text-xs text-slate-500">
        Ordered {timeLabel(order.createdAt)} · {minutesOld(order, now)} min ago
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        {order.status === 'received' && canCook && (
          <Button
            small
            disabled={start.isPending}
            onClick={() => start.mutate(undefined, { onError: fail })}
          >
            Start preparing
          </Button>
        )}
        {order.status === 'preparing' && canCook && (
          <Button
            small
            disabled={ready.isPending}
            onClick={() => ready.mutate(undefined, { onError: fail })}
          >
            Mark ready
          </Button>
        )}
        {order.status === 'ready' && (
          <Button
            small
            disabled={deliver.isPending}
            onClick={() => deliver.mutate(undefined, { onError: fail })}
          >
            Mark delivered
          </Button>
        )}
        {order.status === 'received' && (
          <Button variant="quiet" small onClick={() => onCancel(order)}>
            Cancel order
          </Button>
        )}
      </div>
    </li>
  );
}

function Column({
  title,
  orders,
  empty,
  now,
  canCook,
  onCancel,
}: {
  title: string;
  orders: FoodOrderDto[];
  empty: string;
  now: number;
  canCook: boolean;
  onCancel: (order: FoodOrderDto) => void;
}) {
  return (
    <section aria-label={title} className="min-w-0">
      <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-700">
        {title} <Badge>{orders.length}</Badge>
      </h2>
      {orders.length === 0 ? (
        <EmptyState>{empty}</EmptyState>
      ) : (
        <ul className="space-y-2">
          {orders.map((order) => (
            <OrderCard
              key={order.id}
              order={order}
              now={now}
              canCook={canCook}
              onCancel={onCancel}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

export function KitchenPage() {
  const { staff } = useStaff();
  const now = useNow();
  const [placing, setPlacing] = useState(false);
  const [cancelling, setCancelling] = useState<FoodOrderDto | null>(null);
  const [soundOn, setSoundOn] = useState(false);

  const open = useList<FoodOrderDto>('/food-orders', { open: true, limit: 100 });
  const delivered = useList<FoodOrderDto>('/food-orders', { status: 'delivered', limit: 10 });
  const summary = useGet<FoodOrderSummaryDto>('/food-orders/summary');

  const canCook = staff.role === 'kitchen' || isManager(staff.role);

  useRefetchOnEvents(['food_order.changed'], [['/food-orders'], ['/food-orders/summary']]);
  // A chime for each new order, for the people who cook. The switch starts off because browsers
  // only allow sound after the page has been clicked.
  useRealtime(
    (message) => {
      if (soundOn && canCook && message.data.change === 'created') playChime();
    },
    ['food_order.changed'],
  );

  const openCount = OPEN.reduce(
    (sum, status) => sum + (summary.data?.data.byStatus[status] ?? 0),
    0,
  );

  return (
    <div>
      <PageHeader
        title="Kitchen"
        subtitle="Orders from the rooms, updated live"
        actions={
          <>
            <Button
              variant="secondary"
              aria-pressed={soundOn}
              onClick={() => {
                if (!soundOn) playChime();
                setSoundOn((value) => !value);
              }}
            >
              {soundOn ? 'Turn sound off' : 'Turn sound on'}
            </Button>
            <Button onClick={() => setPlacing(true)}>New order</Button>
          </>
        }
      />
      {summary.data && (
        <p className="mb-4 text-sm text-slate-600">
          {openCount} open · {summary.data.data.late} late
        </p>
      )}

      {(delivered.isError || summary.isError) && (
        <div className="mb-4">
          <ErrorNotice
            error={delivered.error ?? summary.error}
            onRetry={() => {
              void delivered.refetch();
              void summary.refetch();
            }}
          />
        </div>
      )}

      <Async query={open}>
        <div className="grid gap-6 lg:grid-cols-2 xl:grid-cols-4">
          {COLUMNS.map((column) => (
            <Column
              key={column.status}
              title={column.title}
              orders={open.items.filter((order) => order.status === column.status)}
              empty={column.empty}
              now={now}
              canCook={canCook}
              onCancel={setCancelling}
            />
          ))}
          <Column
            title="Delivered (latest)"
            orders={delivered.items}
            empty={delivered.isError ? 'Could not be loaded.' : 'Nothing delivered yet.'}
            now={now}
            canCook={canCook}
            onCancel={setCancelling}
          />
        </div>
      </Async>

      {placing && <NewFoodOrderDialog onClose={() => setPlacing(false)} />}
      {cancelling && <CancelOrderDialog order={cancelling} onClose={() => setCancelling(null)} />}
    </div>
  );
}
