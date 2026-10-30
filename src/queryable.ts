// queryable.ts - the query surface shared by Connection, Transaction and Pool.
import { Collector, toQueryResult } from './collect.ts';
import type { Collected } from './collect.ts';
import type { Lease } from './lease.ts';
import { encodeParams } from './params.ts';
import { buildProcCall, PROC_META_SQL, procInfoFrom, toProcResult } from './proc.ts';
import type { ProcParamInfo } from './proc.ts';
import type { Partial } from './protocol.ts';
import { combine, QueryStream } from './stream.ts';
import type { StreamOptions } from './stream.ts';
import { traced, tracedSync } from './trace.ts';
import type {
  Param,
  ProcResult,
  QueryOptions,
  QueryResult,
  RawResult,
  SyncQueryOptions,
  Row,
  Value,
  WireQueryResult,
} from './types.ts';

export type ProcArgs = readonly Param[] | Readonly<Record<string, Param>>;

type Send = (onPartial: (p: Partial) => void) => Promise<WireQueryResult>;

/**
 * Runs a statement whose rows arrive in chunks ahead of the final response, decoding
 * each chunk as it lands (overlapping the worker's fetch).
 */
async function collect<R extends Row | Value[]>(
  collector: Collector<R>,
  send: Send,
): Promise<Collected<R>> {
  return collector.finish(await send(collector.onPartial));
}

/** Runs `sql` and returns row objects per result set. */
export function runQuery(
  lease: Lease,
  sql: string,
  params: readonly Param[] | undefined,
  signal: AbortSignal | undefined,
): Promise<Collected<Row>> {
  return collect(Collector.rows(lease.decode), (onPartial) =>
    lease.channel.call('query', { sql, params: encodeParams(params) }, signal, onPartial),
  );
}

/** Runs a prepared statement and returns row objects per result set. */
export function runPrepared(
  lease: Lease,
  id: number,
  params: readonly Param[] | undefined,
  signal: AbortSignal | undefined,
): Promise<Collected<Row>> {
  return collect(Collector.rows(lease.decode), (onPartial) =>
    lease.channel.call('prepared.query', { id, params: encodeParams(params) }, signal, onPartial),
  );
}

async function procInfo(lease: Lease, name: string, signal?: AbortSignal): Promise<ProcParamInfo> {
  const key = name.toLowerCase();
  const cached = lease.procs.get(key);
  if (cached) return cached;
  const lookup = runQuery(lease, PROC_META_SQL, [name], signal).then((c) =>
    procInfoFrom(c.results),
  );
  lease.procs.set(key, lookup);
  // Keep the settled value (sync callers cannot await); do not cache failures.
  lookup.then(
    (info) => {
      if (lease.procs.get(key) === lookup) lease.procs.set(key, info);
    },
    () => {
      if (lease.procs.get(key) === lookup) lease.procs.delete(key);
    },
  );
  return lookup;
}

export abstract class Queryable {
  /** Exclusive access to a connection for one operation. */
  protected abstract lease(signal?: AbortSignal): Promise<Lease>;

  /** Runs a statement (or batch) and returns every result set as row objects. */
  async query<T = Row>(
    sql: string,
    params?: readonly Param[],
    options: QueryOptions = {},
  ): Promise<QueryResult<T>> {
    const signal = combine(options.signal, options.timeoutMs);
    using lease = await this.lease(signal);
    const c = await traced({ operation: 'query', sql, params }, () =>
      runQuery(lease, sql, params, signal),
    );
    return toQueryResult<T>(c);
  }

  /** Like `query`, with rows as positional arrays. */
  async queryRaw(
    sql: string,
    params?: readonly Param[],
    options: QueryOptions = {},
  ): Promise<RawResult> {
    const signal = combine(options.signal, options.timeoutMs);
    using lease = await this.lease(signal);
    return traced({ operation: 'queryRaw', sql, params }, () =>
      collect(Collector.raw(lease.decode), (onPartial) =>
        lease.channel.call('query', { sql, params: encodeParams(params) }, signal, onPartial),
      ),
    );
  }

  /** Streams rows of every result set; the connection is held until iteration ends. */
  stream<T = Row>(
    sql: string,
    params?: readonly Param[],
    options: StreamOptions = {},
  ): QueryStream<T> {
    return new QueryStream<T>((signal) => this.lease(signal), sql, params, options);
  }

  /**
   * Calls a stored procedure. `args` are positional or keyed by parameter name; values
   * take the declared parameter types. Output parameters come back in `output`.
   */
  async callProc<T = Row>(
    name: string,
    args?: ProcArgs,
    options: QueryOptions = {},
  ): Promise<ProcResult<T>> {
    const signal = combine(options.signal, options.timeoutMs);
    using lease = await this.lease(signal);
    const info = await procInfo(lease, name, signal);
    const call = buildProcCall(info, args);
    const c = await traced({ operation: 'callProc', sql: call.sql, params: call.params }, () =>
      runQuery(lease, call.sql, call.params, signal),
    );
    return toProcResult<T>(c, call.outputs);
  }
}

/** Runs `sql` with a blocking call; rows are decoded as they arrive. */
export function runQuerySync<R extends Row | Value[]>(
  lease: Lease,
  collector: Collector<R>,
  sql: string,
  params: readonly Param[] | undefined,
  timeoutMs: number | undefined,
): Collected<R> {
  const args = { sql, params: encodeParams(params) };
  const wire = lease.channel.callSync('query', args, {
    timeoutMs,
    onPartial: collector.onPartial,
  });
  return collector.finish(wire);
}

/**
 * Adds blocking variants to the query surface. They run on the same worker and ODBC
 * connection as the async methods but **block the calling thread** until the statement
 * completes. A blocking call cannot wait for the connection: it throws
 * `ConnectionBusyError` while an async operation, a stream or a transaction holds it.
 */
export abstract class SyncQueryable extends Queryable {
  /** Exclusive access to the connection right now, or ConnectionBusyError. */
  protected abstract leaseSync(): Lease;

  /** Blocking `query`. */
  querySync<T = Row>(
    sql: string,
    params?: readonly Param[],
    options: SyncQueryOptions = {},
  ): QueryResult<T> {
    using lease = this.leaseSync();
    const c = tracedSync({ operation: 'query', sql, params }, () =>
      runQuerySync(lease, Collector.rows(lease.decode), sql, params, options.timeoutMs),
    );
    return toQueryResult<T>(c);
  }

  /** Blocking `queryRaw`. */
  queryRawSync(sql: string, params?: readonly Param[], options: SyncQueryOptions = {}): RawResult {
    using lease = this.leaseSync();
    return tracedSync({ operation: 'queryRaw', sql, params }, () =>
      runQuerySync(lease, Collector.raw(lease.decode), sql, params, options.timeoutMs),
    );
  }
}
