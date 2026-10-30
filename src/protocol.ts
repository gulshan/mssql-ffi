// protocol.ts - messages between the main thread (channel.ts) and worker.ts
import type { SerializedError } from './errors.ts';
import type {
  ColumnMeta,
  IsolationLevel,
  Kind,
  WireParam,
  WireQueryResult,
  WireValue,
} from './types.ts';

export interface StatementArgs {
  sql: string;
  params: WireParam[];
}

export interface CursorColumns {
  meta: ColumnMeta[];
  kinds: Kind[];
}

export interface CursorBatch {
  rows: WireValue[][];
  /** Columns of the next result set, when the batch ended the current one. */
  next?: CursorColumns | undefined;
  /** True once every result has been read; the cursor is closed by then. */
  done: boolean;
  counts: number[];
  info: string[];
}

export interface CursorOpened {
  columns: CursorColumns | undefined;
  done: boolean;
  counts: number[];
  info: string[];
}

/** op -> [arguments, result] */
export interface Ops {
  open: [{ connectionString: string; loginTimeoutSecs?: number | undefined }, void];
  close: [undefined, void];
  query: [StatementArgs, WireQueryResult];
  'cursor.open': [StatementArgs, CursorOpened];
  'cursor.fetch': [{ max: number }, CursorBatch];
  'cursor.close': [undefined, void];
  prepare: [{ sql: string }, number];
  'prepared.query': [{ id: number; params: WireParam[] }, WireQueryResult];
  'prepared.free': [{ id: number }, void];
  'tx.begin': [{ isolationLevel?: IsolationLevel | undefined }, void];
  'tx.commit': [undefined, void];
  'tx.rollback': [undefined, void];
}

export type Op = keyof Ops;
export type ArgsOf<K extends Op> = Ops[K][0];
export type ResultOf<K extends Op> = Ops[K][1];

export type Request = { [K in Op]: { id: number; op: K; args: ArgsOf<K> } }[Op];

/** Rows of result set `set`, sent ahead of the final response; `columns` comes with the first. */
export interface Partial {
  set: number;
  columns?: CursorColumns | undefined;
  rows: WireValue[][];
}

export type Response =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: SerializedError }
  | { id: number; partial: Partial };

export interface WorkerData {
  cancel: SharedArrayBuffer;
  flow: SharedArrayBuffer;
}
