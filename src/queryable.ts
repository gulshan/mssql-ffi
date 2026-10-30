// queryable.ts - the query surface shared by Connection, Transaction and Pool.
import { decoders, decodeRow, toObject } from './decode.ts';
import type { Lease } from './lease.ts';
import { encodeParams } from './params.ts';
import { buildProcCall, PROC_META_SQL } from './proc.ts';
import type { ProcParam, ProcParamInfo } from './proc.ts';
import type { Partial } from './protocol.ts';
import { combine, QueryStream } from './stream.ts';
import type { StreamOptions } from './stream.ts';
import { traced } from './trace.ts';
import type {
  ColumnMeta,
  Param,
  ProcResult,
  QueryOptions,
  QueryResult,
  RawResult,
  Row,
  Value,
  WireQueryResult,
} from './types.ts';

export type ProcArgs = readonly Param[] | Readonly<Record<string, Param>>;

interface Collected<R> {
  results: R[][];
  meta: ColumnMeta[][];
  counts: number[];
  info: string[];
}

type Send = (onPartial: (p: Partial) => void) => Promise<WireQueryResult>;

/**
 * Runs a statement whose rows arrive in chunks ahead of the final response, decoding
 * each chunk as it lands (overlapping the worker's fetch) into objects or arrays.
 */
async function collect(lease: Lease, raw: true, send: Send): Promise<Collected<Value[]>>;
async function collect(lease: Lease, raw: false, send: Send): Promise<Collected<Row>>;
async function collect(lease: Lease, raw: boolean, send: Send): Promise<Collected<Row | Value[]>> {
  const sets: (Row | Value[])[][] = [];
  const readers: { decs: ReturnType<typeof decoders>; names: string[] }[] = [];
  const r = await send((p) => {
    let reader = readers[p.set];
    if (!reader) {
      const cols = p.columns!;
      reader = { decs: decoders(cols.kinds, lease.decode), names: cols.meta.map((m) => m.name) };
      readers[p.set] = reader;
    }
    const out = (sets[p.set] ??= []);
    for (const row of p.rows) {
      const values = decodeRow(row, reader.decs);
      out.push(raw ? values : toObject(reader.names, values));
    }
  });
  return {
    results: r.results.map((_, i) => sets[i] ?? []),
    meta: r.results.map((set) => set.meta),
    counts: r.counts,
    info: r.info,
  };
}

/** Runs `sql` and returns row objects per result set. */
export function runQuery(
  lease: Lease,
  sql: string,
  params: readonly Param[] | undefined,
  signal: AbortSignal | undefined,
): Promise<Collected<Row>> {
  return collect(lease, false, (onPartial) =>
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
  return collect(lease, false, (onPartial) =>
    lease.channel.call('prepared.query', { id, params: encodeParams(params) }, signal, onPartial),
  );
}

export function toQueryResult<T>(c: Collected<Row>): QueryResult<T> {
  const results = c.results as T[][];
  return { first: results[0] ?? [], results, meta: c.meta, counts: c.counts, info: c.info };
}

async function procInfo(lease: Lease, name: string, signal?: AbortSignal): Promise<ProcParamInfo> {
  const key = name.toLowerCase();
  let info = lease.procs.get(key);
  if (!info) {
    info = runQuery(lease, PROC_META_SQL, [name], signal).then(({ results: [head, params] }) => ({
      qualifiedName: String(head?.[0]?.['qualifiedName']),
      params: (params ?? []) as unknown as ProcParam[],
    }));
    lease.procs.set(key, info);
    // Do not cache failures (missing procedure, cancelled lookup...).
    info.catch(() => lease.procs.delete(key));
  }
  return info;
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
      collect(lease, true, (onPartial) =>
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
    // The trailing result set holds the return code and output parameters.
    const [values] = c.results.pop() ?? [];
    c.meta.pop();
    const output: ProcResult['output'] = {};
    for (const key of call.outputs) output[key] = values?.[key] ?? null;
    return { ...toQueryResult<T>(c), output, returns: Number(values?.['returns'] ?? 0) };
  }
}
