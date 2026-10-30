// stream.ts - pull-based row streaming: rows are fetched in batches as the consumer iterates.
import { decoders, decodeRow, toObject } from './decode.ts';
import type { Lease } from './lease.ts';
import { encodeParams } from './params.ts';
import type { CursorBatch, CursorColumns } from './protocol.ts';
import { traced } from './trace.ts';
import type { ColumnMeta, Param, QueryOptions, Row } from './types.ts';

export interface StreamOptions extends QueryOptions {
  /** Rows fetched per round trip to the worker (default 256). */
  batchSize?: number | undefined;
}

/**
 * Rows of every result set of a statement, fetched lazily. Iterate once with `for await`;
 * breaking out of the loop (or disposing the stream) closes the cursor.
 */
export class QueryStream<T = Row> implements AsyncIterable<T>, AsyncDisposable {
  readonly #acquire: (signal?: AbortSignal) => Promise<Lease>;
  readonly #sql: string;
  readonly #params: readonly Param[] | undefined;
  readonly #options: StreamOptions;
  #iterator: AsyncGenerator<T> | undefined;

  /** Columns of the result set the latest row belongs to. */
  meta: ColumnMeta[] | undefined;
  /** Index of the result set the latest row belongs to. */
  resultSet = -1;
  /** Row counts of statements without columns, as they are reached. */
  readonly counts: number[] = [];
  /** Informational messages, as they are reached. */
  readonly info: string[] = [];

  constructor(
    acquire: (signal?: AbortSignal) => Promise<Lease>,
    sql: string,
    params: readonly Param[] | undefined,
    options: StreamOptions,
  ) {
    this.#acquire = acquire;
    this.#sql = sql;
    this.#params = params;
    this.#options = options;
  }

  [Symbol.asyncIterator](): AsyncGenerator<T> {
    if (this.#iterator) throw new Error('A QueryStream can only be iterated once');
    this.#iterator = this.#rows();
    return this.#iterator;
  }

  /** Reads every remaining row into an array. */
  toArray(): Promise<T[]> {
    return Array.fromAsync(this);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.#iterator?.return(undefined);
  }

  async *#rows(): AsyncGenerator<T> {
    const { signal, timeoutMs, batchSize = 256 } = this.#options;
    const sig = combine(signal, timeoutMs);
    using lease = await this.#acquire(sig);
    const { channel } = lease;
    const opened = await traced({ operation: 'stream', sql: this.#sql, params: this.#params }, () =>
      channel.call('cursor.open', { sql: this.#sql, params: encodeParams(this.#params) }, sig),
    );
    this.counts.push(...opened.counts);
    this.info.push(...opened.info);
    let done = opened.done;
    let columns = opened.columns;
    const fetch = (): Promise<CursorBatch> => {
      const p = channel.call('cursor.fetch', { max: batchSize }, sig);
      // Handled when awaited; this keeps a failure during prefetch from being "unhandled".
      p.catch(() => {});
      return p;
    };
    // One batch is always in flight: the worker reads the next one while rows are consumed.
    let pending = columns ? fetch() : undefined;
    let decs: ReturnType<typeof decoders> = [];
    let names: string[] = [];
    try {
      while (pending && columns) {
        // oxlint-disable-next-line no-await-in-loop -- batches arrive one after another
        const batch = await pending;
        pending = batch.done ? undefined : fetch();
        done = batch.done;
        this.counts.push(...batch.counts);
        this.info.push(...batch.info);
        if (this.#enter(columns)) {
          decs = decoders(columns.kinds, lease.decode);
          names = columns.meta.map((m) => m.name);
        }
        for (const r of batch.rows) yield toObject(names, decodeRow(r, decs)) as T;
        if (batch.next) columns = batch.next;
      }
    } finally {
      // Let an in-flight prefetch land before closing; it may also have finished the cursor.
      if (pending) done = (await pending.catch(() => undefined))?.done ?? done;
      if (!done) await channel.call('cursor.close', undefined).catch(() => {});
    }
  }

  /** Tracks the current result set; true when `columns` starts a new one. */
  #enter(columns: CursorColumns): boolean {
    if (this.meta === columns.meta) return false;
    this.meta = columns.meta;
    this.resultSet++;
    return true;
  }
}

export function combine(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): AbortSignal | undefined {
  if (timeoutMs === undefined) return signal;
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
