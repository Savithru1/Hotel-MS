import {
  Schema,
  Types,
  type ClientSession,
  type HydratedDocument,
  type Model,
  type SchemaDefinition,
  type UpdateQuery,
} from 'mongoose';
import { badRequest, conflict, notFound } from './errors';
import { getContext, type Principal } from './request-context';

export interface StateMachine<S extends string = string> {
  readonly name: string;
  readonly initial: S;
  readonly states: readonly S[];
  readonly transitions: Readonly<Record<S, readonly S[]>>;
}

/** One recorded move. Stored on the document so its whole life can be reviewed. */
export interface HistoryEntry {
  from: string | null;
  to: string;
  at: Date;
  by?: Principal;
  note?: string;
}

/** The fields a document needs to be moved by `transition`. */
export interface Stateful {
  status: string;
  history: HistoryEntry[];
}

interface Definition<S extends string> {
  name: string;
  initial: S;
  transitions: Record<S, readonly S[]>;
}

/**
 * Declares a workflow as a table of allowed moves. A move that is not in the table can never
 * happen, whatever the caller asks for.
 */
export function defineStateMachine<S extends string>(definition: Definition<S>): StateMachine<S> {
  const states = Object.keys(definition.transitions) as S[];

  if (!states.includes(definition.initial)) {
    throw new Error(`State machine "${definition.name}": initial state is not a known state.`);
  }
  for (const [from, targets] of Object.entries<readonly string[]>(definition.transitions)) {
    for (const target of targets) {
      if (!states.includes(target as S)) {
        throw new Error(
          `State machine "${definition.name}": "${from}" points at unknown state "${target}".`,
        );
      }
    }
  }

  return {
    name: definition.name,
    initial: definition.initial,
    states,
    transitions: definition.transitions,
  };
}

export function canTransition(machine: StateMachine, from: string, to: string): boolean {
  const targets = (machine.transitions as Record<string, readonly string[]>)[from];
  return targets?.includes(to) ?? false;
}

export function isTerminal(machine: StateMachine, state: string): boolean {
  const targets = (machine.transitions as Record<string, readonly string[]>)[state];
  return targets?.length === 0;
}

const historyEntrySchema = new Schema<HistoryEntry>(
  {
    from: { type: String, default: null },
    to: { type: String, required: true },
    at: { type: Date, required: true },
    by: { type: Schema.Types.Mixed },
    note: { type: String },
  },
  { _id: false },
);

/** Schema fields for a document that follows `machine`: `status` and an append-only `history`. */
export function stateFields(machine: StateMachine): SchemaDefinition {
  return {
    status: {
      type: String,
      enum: [...machine.states],
      default: machine.initial,
      required: true,
      index: true,
    },
    history: { type: [historyEntrySchema], default: [] },
  };
}

export interface TransitionInput<TDoc extends Stateful> {
  model: Model<TDoc>;
  id: Types.ObjectId | string;
  machine: StateMachine;
  /** Plain string on purpose: the target often comes from a request and is checked here. */
  to: string;
  /** Defaults to the signed-in principal of the current request. */
  actor?: Principal;
  note?: string;
  /** Extra fields to change in the same atomic update (for example `assignedTo`). */
  set?: Record<string, unknown>;
  /** Pass the session of a surrounding transaction so the move commits or rolls back with it. */
  session?: ClientSession;
}

const PROTECTED_FIELDS = ['_id', 'status', 'history', 'propertyId'];

/**
 * Moves a document to its next state, safely under concurrency.
 *
 * The update only applies if the document is still in the state we just read, so two requests
 * racing to move the same document can never both succeed. The loser gets a 409.
 */
export async function transition<TDoc extends Stateful>(
  input: TransitionInput<TDoc>,
): Promise<HydratedDocument<TDoc>> {
  const { model, id, machine, to, note, set, session } = input;

  if (!Types.ObjectId.isValid(id)) {
    throw badRequest('Invalid id', 'invalid_id');
  }
  for (const key of Object.keys(set ?? {})) {
    if (PROTECTED_FIELDS.includes(key)) {
      throw new Error(`transition(): "${key}" cannot be changed through "set".`);
    }
  }

  const current = await model
    .findOne({ _id: id } as never, { status: 1 })
    .session(session ?? null)
    .lean<{ status: string }>();
  if (!current) {
    throw notFound(`${machine.name} not found`);
  }
  if (!canTransition(machine, current.status, to)) {
    throw conflict(
      `Cannot move ${machine.name} from "${current.status}" to "${to}"`,
      'bad_transition',
    );
  }

  const by = input.actor ?? getContext()?.principal;
  const entry: HistoryEntry = {
    from: current.status,
    to,
    at: new Date(),
    ...(by ? { by } : {}),
    ...(note ? { note } : {}),
  };

  const update = {
    $set: { status: to, ...set },
    $push: { history: entry },
  } as UpdateQuery<TDoc>;

  const updated = await model.findOneAndUpdate(
    { _id: id, status: current.status } as never,
    update,
    { returnDocument: 'after', session: session ?? null, runValidators: true },
  );
  if (!updated) {
    throw conflict(
      `${machine.name} was changed by someone else while you were updating it, please try again`,
      'conflict',
    );
  }
  return updated;
}
