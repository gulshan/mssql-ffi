// connection.ts - a connection: one worker thread owning one ODBC connection.
import { Channel } from './channel.ts';
import { decodeOptions } from './decode.ts';
import type { DecodeOptions } from './decode.ts';
import { lease } from './lease.ts';
import type { Lease } from './lease.ts';
import { Mutex } from './mutex.ts';
import { PreparedStatement } from './prepared.ts';
import type { ProcCache } from './proc.ts';
import { Queryable } from './queryable.ts';
import { Transaction } from './transaction.ts';
import type {
  ConnectionOptions,
  Param,
  QueryOptions,
  QueryResult,
  Row,
  TransactionOptions,
} from './types.ts';

let leaseOf: (conn: Connection, signal?: AbortSignal) => Promise<Lease>;

/** @internal Lets the pool lease its connections without exposing `lease` publicly. */
export function connectionLease(conn: Connection, signal?: AbortSignal): Promise<Lease> {
  return leaseOf(conn, signal);
}

export class Connection extends Queryable implements AsyncDisposable {
  static {
    leaseOf = (conn, signal) => conn.lease(signal);
  }

  readonly #channel: Channel;
  readonly #mutex = new Mutex();
  readonly #decode: DecodeOptions;
  readonly #procs: ProcCache = new Map();
  readonly #prepared = new Set<PreparedStatement>();

  private constructor(channel: Channel, options: ConnectionOptions) {
    super();
    this.#channel = channel;
    this.#decode = decodeOptions(options);
  }

  /** Opens a connection with an ODBC connection string. */
  static async open(
    connectionString: string,
    options: ConnectionOptions = {},
  ): Promise<Connection> {
    const channel = new Channel();
    try {
      await channel.call('open', { connectionString, loginTimeoutSecs: options.loginTimeoutSecs });
    } catch (e) {
      await channel.close().catch(() => {});
      throw e;
    }
    return new Connection(channel, options);
  }

  protected async lease(signal?: AbortSignal): Promise<Lease> {
    const release = await this.#mutex.acquire(signal);
    return lease(this.#channel, this.#decode, this.#procs, release);
  }

  isClosed(): boolean {
    return this.#channel.closed;
  }

  /** Prepares a statement for repeated execution. Free it (or `await using` it) when done. */
  async prepare(sql: string): Promise<PreparedStatement> {
    using l = await this.lease();
    const id = await l.channel.call('prepare', { sql });
    const ps = new PreparedStatement(
      sql,
      id,
      (s) => this.lease(s),
      (p) => this.#prepared.delete(p),
    );
    this.#prepared.add(ps);
    return ps;
  }

  /**
   * Starts a transaction. The connection is reserved for it until commit/rollback:
   * run its statements through the returned Transaction.
   */
  async beginTransaction(options?: TransactionOptions): Promise<Transaction> {
    return Transaction.begin(await this.lease(), options);
  }

  /** Runs `fn` in a transaction: commits when it resolves, rolls back when it throws. */
  async transaction<R>(
    fn: (tx: Transaction) => Promise<R>,
    options?: TransactionOptions,
  ): Promise<R> {
    await using tx = await this.beginTransaction(options);
    const result = await fn(tx);
    if (tx.active) await tx.commit();
    return result;
  }

  /** Closes the connection. Statements still queued are rejected; an open transaction rolls back. */
  async close(): Promise<void> {
    for (const ps of this.#prepared) ps.markFreed();
    this.#prepared.clear();
    await this.#channel.close();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}

/** Opens a connection with an ODBC connection string. */
export function open(connectionString: string, options?: ConnectionOptions): Promise<Connection> {
  return Connection.open(connectionString, options);
}

/** Opens a connection, runs one query and closes it. */
export async function query<T = Row>(
  connectionString: string,
  sql: string,
  params?: readonly Param[],
  options?: ConnectionOptions & QueryOptions,
): Promise<QueryResult<T>> {
  await using conn = await open(connectionString, options);
  // Awaited here so the connection is not disposed before the query settles.
  return await conn.query<T>(sql, params, options);
}
