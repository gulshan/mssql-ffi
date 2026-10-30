// oneshot.ts - querySync / queryRawSync: one statement on a short-lived connection, run
// in the calling thread. No worker is involved; nothing outlives the call.
import { Collector, toQueryResult } from './collect.ts';
import type { Collected } from './collect.ts';
import { decodeOptions } from './decode.ts';
import { SqlError } from './errors.ts';
import { Connection } from './odbc/connection.ts';
import { encodeParams } from './params.ts';
import { tracedSync } from './trace.ts';
import type { QueryTraceContext } from './trace.ts';
import type {
  ConnectionOptions,
  Param,
  QueryResult,
  RawResult,
  Row,
  SyncQueryOptions,
  Value,
} from './types.ts';

export type OneShotOptions = ConnectionOptions & SyncQueryOptions;

/** SQL_ATTR_QUERY_TIMEOUT takes whole seconds; 0 would mean "no timeout". */
export function timeoutSecs(timeoutMs: number | undefined): number | undefined {
  return timeoutMs === undefined ? undefined : Math.max(1, Math.ceil(timeoutMs / 1000));
}

/** A statement timeout surfaces like an async `timeoutMs`: TimeoutError, driver error as cause. */
function timedOut(e: unknown): unknown {
  if (!(e instanceof SqlError) || e.sqlstate !== 'HYT00') return e;
  return new DOMException('The operation was aborted due to timeout', {
    name: 'TimeoutError',
    cause: e,
  });
}

function run<R extends Row | Value[]>(
  operation: QueryTraceContext['operation'],
  collector: Collector<R>,
  connectionString: string,
  sql: string,
  params: readonly Param[] | undefined,
  options: OneShotOptions,
): Collected<R> {
  // Encoded first, so bad parameters fail before the login.
  const args = { sql, params: encodeParams(params), timeoutSecs: timeoutSecs(options.timeoutMs) };
  const conn = Connection.open(connectionString, options.loginTimeoutSecs);
  try {
    return tracedSync({ operation, sql, params }, () => collector.finish(conn.query(args)));
  } catch (e) {
    throw timedOut(e);
  } finally {
    conn.close();
  }
}

/**
 * Opens a connection, runs one statement (or batch) and closes it, all in the calling
 * thread. **Blocks the thread**, timers and I/O included, for the login and the query.
 * Meant for scripts, CLIs and start-up code.
 */
export function querySync<T = Row>(
  connectionString: string,
  sql: string,
  params?: readonly Param[],
  options: OneShotOptions = {},
): QueryResult<T> {
  const c = run(
    'query',
    Collector.rows(decodeOptions(options)),
    connectionString,
    sql,
    params,
    options,
  );
  return toQueryResult<T>(c);
}

/** Like `querySync`, with rows as positional arrays. **Blocks the calling thread.** */
export function queryRawSync(
  connectionString: string,
  sql: string,
  params?: readonly Param[],
  options: OneShotOptions = {},
): RawResult {
  return run(
    'queryRaw',
    Collector.raw(decodeOptions(options)),
    connectionString,
    sql,
    params,
    options,
  );
}
