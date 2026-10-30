// prepared.ts - a statement prepared once and executed many times.
import type { Lease } from './lease.ts';
import { runPrepared, toQueryResult } from './queryable.ts';
import { combine } from './stream.ts';
import { traced } from './trace.ts';
import type { Param, QueryOptions, QueryResult, Row } from './types.ts';

export class PreparedStatement implements AsyncDisposable {
  readonly sql: string;
  readonly #id: number;
  readonly #lease: (signal?: AbortSignal) => Promise<Lease>;
  readonly #onFree: (ps: PreparedStatement) => void;
  #freed = false;

  /** @internal Created by `Connection.prepare` / `Transaction.prepare`. */
  constructor(
    sql: string,
    id: number,
    lease: (signal?: AbortSignal) => Promise<Lease>,
    onFree: (ps: PreparedStatement) => void,
  ) {
    this.sql = sql;
    this.#id = id;
    this.#lease = lease;
    this.#onFree = onFree;
  }

  get freed(): boolean {
    return this.#freed;
  }

  async query<T = Row>(
    params?: readonly Param[],
    options: QueryOptions = {},
  ): Promise<QueryResult<T>> {
    if (this.#freed) throw new Error('Prepared statement has been freed');
    const signal = combine(options.signal, options.timeoutMs);
    using lease = await this.#lease(signal);
    const c = await traced({ operation: 'prepared', sql: this.sql, params }, () =>
      runPrepared(lease, this.#id, params, signal),
    );
    return toQueryResult<T>(c);
  }

  async free(): Promise<void> {
    if (this.#freed) return;
    this.#freed = true;
    this.#onFree(this);
    using lease = await this.#lease();
    if (!lease.channel.closed) await lease.channel.call('prepared.free', { id: this.#id });
  }

  /** @internal The owner already freed it (transaction end, connection close). */
  markFreed(): void {
    this.#freed = true;
  }

  get id(): number {
    return this.#id;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.free();
  }
}
