// prepared.ts - a statement prepared once and executed many times.
import { toQueryResult } from './collect.ts';
import type { Lease } from './lease.ts';
import { runPrepared, runPreparedSync } from './queryable.ts';
import { combine } from './stream.ts';
import { traced, tracedSync } from './trace.ts';
import type { Param, QueryOptions, QueryResult, Row, SyncQueryOptions } from './types.ts';

export class PreparedStatement implements AsyncDisposable, Disposable {
  readonly sql: string;
  readonly #id: number;
  readonly #lease: (signal?: AbortSignal) => Promise<Lease>;
  readonly #leaseSync: () => Lease;
  readonly #onFree: (ps: PreparedStatement) => void;
  #freed = false;

  /** @internal Created by `Connection.prepare` / `Transaction.prepare` and their sync forms. */
  constructor(
    sql: string,
    id: number,
    lease: (signal?: AbortSignal) => Promise<Lease>,
    leaseSync: () => Lease,
    onFree: (ps: PreparedStatement) => void,
  ) {
    this.sql = sql;
    this.#id = id;
    this.#lease = lease;
    this.#leaseSync = leaseSync;
    this.#onFree = onFree;
  }

  get freed(): boolean {
    return this.#freed;
  }

  #assertUsable(): void {
    if (this.#freed) throw new Error('Prepared statement has been freed');
  }

  async query<T = Row>(
    params?: readonly Param[],
    options: QueryOptions = {},
  ): Promise<QueryResult<T>> {
    this.#assertUsable();
    const signal = combine(options.signal, options.timeoutMs);
    using lease = await this.#lease(signal);
    const c = await traced({ operation: 'prepared', sql: this.sql, params }, () =>
      runPrepared(lease, this.#id, params, signal),
    );
    return toQueryResult<T>(c);
  }

  /** Blocking `query`. **Blocks the calling thread** until the statement completes. */
  querySync<T = Row>(params?: readonly Param[], options: SyncQueryOptions = {}): QueryResult<T> {
    this.#assertUsable();
    using lease = this.#leaseSync();
    const c = tracedSync({ operation: 'prepared', sql: this.sql, params }, () =>
      runPreparedSync(lease, this.#id, params, options.timeoutMs),
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

  /**
   * Blocking `free`. **Blocks the calling thread.** Throws ConnectionBusyError (and stays
   * usable) while the connection is busy.
   */
  freeSync(): void {
    if (this.#freed) return;
    using lease = this.#leaseSync();
    this.#freed = true;
    this.#onFree(this);
    if (!lease.channel.closed) lease.channel.callSync('prepared.free', { id: this.#id });
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

  /** `using` support: `freeSync()`. **Blocks the calling thread.** */
  [Symbol.dispose](): void {
    this.freeSync();
  }
}
