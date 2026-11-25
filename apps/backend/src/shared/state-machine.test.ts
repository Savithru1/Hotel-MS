import mongoose, { Schema, Types } from 'mongoose';
import { beforeAll, describe, expect, it } from 'vitest';
import { twoTenants, useTestDatabase } from '../../test/db';
import { HttpError } from './errors';
import { runAsPlatform, runWithTenant } from './request-context';
import {
  canTransition,
  defineStateMachine,
  isTerminal,
  stateFields,
  transition,
  type HistoryEntry,
} from './state-machine';
import { TenantContextError, tenantPlugin } from './tenant-plugin';

useTestDatabase();

const orderMachine = defineStateMachine({
  name: 'order',
  initial: 'received',
  transitions: {
    received: ['preparing', 'cancelled'],
    preparing: ['ready'],
    ready: ['delivered'],
    delivered: [],
    cancelled: [],
  },
});

interface Order {
  label: string;
  note?: string;
  status: string;
  history: HistoryEntry[];
  propertyId: Types.ObjectId;
}

const orderSchema = new Schema<Order>({
  label: { type: String, required: true },
  note: String,
  ...stateFields(orderMachine),
});
orderSchema.plugin(tenantPlugin);
const Order = mongoose.model<Order>('StateOrder', orderSchema);

const { a: A, b: B } = twoTenants();

beforeAll(async () => {
  await Order.init();
});

async function newOrder(propertyId = A): Promise<Order & { _id: Types.ObjectId }> {
  return runAsPlatform(async () => {
    const doc = await Order.create({ propertyId, label: 'order' });
    return doc.toObject() as Order & { _id: Types.ObjectId };
  });
}

async function statusOf(id: Types.ObjectId): Promise<string | undefined> {
  return (await runAsPlatform(() => Order.findById(id)))?.status;
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof HttpError ? error.code : `not-http:${String(error)}`;
  }
}

describe('defineStateMachine', () => {
  it('derives the states from the transition table', () => {
    expect([...orderMachine.states].sort()).toEqual(
      ['cancelled', 'delivered', 'preparing', 'ready', 'received'].sort(),
    );
    expect(orderMachine.initial).toBe('received');
  });

  it('allows only listed transitions', () => {
    expect(canTransition(orderMachine, 'received', 'preparing')).toBe(true);
    expect(canTransition(orderMachine, 'received', 'cancelled')).toBe(true);
    expect(canTransition(orderMachine, 'received', 'delivered')).toBe(false);
    expect(canTransition(orderMachine, 'ready', 'preparing')).toBe(false);
    expect(canTransition(orderMachine, 'delivered', 'received')).toBe(false);
  });

  it('knows terminal states', () => {
    expect(isTerminal(orderMachine, 'delivered')).toBe(true);
    expect(isTerminal(orderMachine, 'cancelled')).toBe(true);
    expect(isTerminal(orderMachine, 'received')).toBe(false);
  });

  it('rejects a machine whose transition points at an unknown state', () => {
    expect(() =>
      defineStateMachine({
        name: 'bad',
        initial: 'a',
        transitions: { a: ['zzz'], b: [] },
      } as never),
    ).toThrow(/unknown state/i);
  });

  it('rejects a machine whose initial state is not a state', () => {
    expect(() =>
      defineStateMachine({ name: 'bad', initial: 'nope', transitions: { a: [] } } as never),
    ).toThrow(/initial/i);
  });

  it('builds schema fields with the initial status and an empty history', async () => {
    const created = await runWithTenant(A, () => Order.create({ label: 'x' }));
    expect(created.status).toBe('received');
    expect(created.history).toHaveLength(0);
  });

  it('rejects a status that is not in the machine at the schema level', async () => {
    await expect(
      runWithTenant(A, () => Order.create({ label: 'x', status: 'flying' })),
    ).rejects.toThrow(/status/);
  });
});

describe('transition', () => {
  it('moves the document, appends history and applies extra fields', async () => {
    const order = await newOrder();
    const updated = await runWithTenant(A, () =>
      transition({
        model: Order,
        id: order._id,
        machine: orderMachine,
        to: 'preparing',
        actor: { kind: 'staff', id: 'staff-1', role: 'kitchen' },
        note: 'started',
        set: { note: 'on the stove' },
      }),
    );

    expect(updated.status).toBe('preparing');
    expect(updated.note).toBe('on the stove');
    expect(updated.history).toHaveLength(1);
    const entry = updated.history[0];
    expect(entry?.from).toBe('received');
    expect(entry?.to).toBe('preparing');
    expect(entry?.note).toBe('started');
    expect(entry?.by).toEqual({ kind: 'staff', id: 'staff-1', role: 'kitchen' });
    expect(entry?.at).toBeInstanceOf(Date);
  });

  it('walks a whole life cycle in order', async () => {
    const order = await newOrder();
    for (const to of ['preparing', 'ready', 'delivered']) {
      await runWithTenant(A, () =>
        transition({ model: Order, id: order._id, machine: orderMachine, to }),
      );
    }
    expect(await statusOf(order._id)).toBe('delivered');
  });

  it('refuses an illegal transition with 409 and changes nothing', async () => {
    const order = await newOrder();
    const code = await codeOf(
      runWithTenant(A, () =>
        transition({ model: Order, id: order._id, machine: orderMachine, to: 'delivered' }),
      ),
    );
    expect(code).toBe('bad_transition');
    expect(await statusOf(order._id)).toBe('received');
  });

  it('refuses to leave a terminal state', async () => {
    const order = await newOrder();
    await runWithTenant(A, () =>
      transition({ model: Order, id: order._id, machine: orderMachine, to: 'cancelled' }),
    );
    const code = await codeOf(
      runWithTenant(A, () =>
        transition({ model: Order, id: order._id, machine: orderMachine, to: 'preparing' }),
      ),
    );
    expect(code).toBe('bad_transition');
  });

  it('refuses a target state that does not exist', async () => {
    const order = await newOrder();
    const code = await codeOf(
      runWithTenant(A, () =>
        transition({ model: Order, id: order._id, machine: orderMachine, to: 'teleported' }),
      ),
    );
    expect(code).toBe('bad_transition');
  });

  it('answers 404 for a missing document and for another tenant document', async () => {
    const mine = await newOrder(A);
    const theirs = await newOrder(B);
    const missing = await codeOf(
      runWithTenant(A, () =>
        transition({
          model: Order,
          id: new Types.ObjectId(),
          machine: orderMachine,
          to: 'preparing',
        }),
      ),
    );
    const crossTenant = await codeOf(
      runWithTenant(A, () =>
        transition({ model: Order, id: theirs._id, machine: orderMachine, to: 'preparing' }),
      ),
    );
    expect(missing).toBe('not_found');
    expect(crossTenant).toBe('not_found');
    expect(await statusOf(theirs._id)).toBe('received');
    expect(await statusOf(mine._id)).toBe('received');
  });

  it('answers 400 for a malformed id', async () => {
    const code = await codeOf(
      runWithTenant(A, () =>
        transition({ model: Order, id: 'not-an-id', machine: orderMachine, to: 'preparing' }),
      ),
    );
    expect(code).toBe('invalid_id');
  });

  it('refuses to run without a tenant context', async () => {
    const order = await newOrder();
    await expect(
      transition({ model: Order, id: order._id, machine: orderMachine, to: 'preparing' }),
    ).rejects.toBeInstanceOf(TenantContextError);
  });

  it('lets exactly one of two racing, conflicting transitions win', async () => {
    for (let round = 0; round < 15; round++) {
      const order = await newOrder();
      const results = await Promise.allSettled([
        runWithTenant(A, () =>
          transition({ model: Order, id: order._id, machine: orderMachine, to: 'preparing' }),
        ),
        runWithTenant(A, () =>
          transition({ model: Order, id: order._id, machine: orderMachine, to: 'cancelled' }),
        ),
      ]);
      const wins = results.filter((r) => r.status === 'fulfilled');
      const losses = results.filter((r) => r.status === 'rejected');
      expect(wins).toHaveLength(1);
      expect(losses).toHaveLength(1);
      const loser = (losses[0] as PromiseRejectedResult).reason as HttpError;
      expect(loser).toBeInstanceOf(HttpError);
      expect(loser.status).toBe(409);
      const final = await runAsPlatform(() => Order.findById(order._id));
      expect(final?.history).toHaveLength(1);
    }
  });

  it('lets exactly one of two identical racing transitions win', async () => {
    const order = await newOrder();
    const results = await Promise.allSettled([
      runWithTenant(A, () =>
        transition({ model: Order, id: order._id, machine: orderMachine, to: 'preparing' }),
      ),
      runWithTenant(A, () =>
        transition({ model: Order, id: order._id, machine: orderMachine, to: 'preparing' }),
      ),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('rolls back with the surrounding transaction', async () => {
    const order = await newOrder();
    await expect(
      runWithTenant(A, () =>
        mongoose.connection.transaction(async (session) => {
          await transition({
            model: Order,
            id: order._id,
            machine: orderMachine,
            to: 'preparing',
            session,
          });
          throw new Error('boom');
        }),
      ),
    ).rejects.toThrow('boom');
    expect(await statusOf(order._id)).toBe('received');
  });

  it('commits with the surrounding transaction', async () => {
    const order = await newOrder();
    await runWithTenant(A, () =>
      mongoose.connection.transaction(async (session) => {
        await transition({
          model: Order,
          id: order._id,
          machine: orderMachine,
          to: 'preparing',
          session,
        });
      }),
    );
    expect(await statusOf(order._id)).toBe('preparing');
  });
});
