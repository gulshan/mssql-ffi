// connection.ts - a connection: one worker thread owning one ODBC connection.
import { Channel, ConnectionBusyError } from './channel.ts';
import { decodeOptions } from './decode.ts';
import type { DecodeOptions } from './decode.ts';
import { lease } from './lease.ts';
import type { Lease } from './lease.ts';
import { Mutex } from './mutex.ts';
import { PreparedStatement } from './prepared.ts';
import type { ProcCache } from './proc.ts';
import { SyncQueryable } from './queryable.ts';
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

export class Connection extends SyncQueryable implements AsyncDisposable, Disposable {
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

  /**
   * Opens a connection with an ODBC connection string, blocking the calling thread until
   * the login completes. The connection supports both async and blocking calls.
   */
  static openSync(connectionString: string, options: ConnectionOptions = {}): Connection {
    const channel = new Channel();
    try {
      channel.callSync('open', { connectionString, loginTimeoutSecs: options.loginTimeoutSecs });
    } catch (e) {
      try {
        channel.closeSync();
      } catch {
        // the login error is the one to report
      }
      throw e;
    }
    return new Connection(channel, options);
  }

  protected async lease(signal?: AbortSignal): Promise<Lease> {
    const release = await this.#mutex.acquire(signal);
    return lease(this.#channel, this.#decode, this.#procs, release);
  }

  protected leaseSync(): Lease {
    const release = this.#mutex.tryAcquire();
    if (!release) {
      throw new ConnectionBusyError(
        'Connection is in use by an async query, stream or transaction; ' +
          'a blocking call cannot wait for it',
      );
    }
    return lease(this.#channel, this.#decode, this.#procs, release);
  }

  isClosed(): boolean {
    return this.#channel.closed;
  }

  #track(id: number, sql: string): PreparedStatement {
    const ps = new PreparedStatement(
      sql,
      id,
      (s) => this.lease(s),
      () => this.leaseSync(),
      (p) => this.#prepared.delete(p),
    );
    this.#prepared.add(ps);
    return ps;
  }

  /** Prepares a statement for repeated execution. Free it (or `await using` it) when done. */
  async prepare(sql: string): Promise<PreparedStatement> {
    using l = await this.lease();
    return this.#track(await l.channel.call('prepare', { sql }), sql);
  }

  /**
   * Blocking `prepare`. **Blocks the calling thread.** Free the statement (or `using` it)
   * when done.
   */
  prepareSync(sql: string): PreparedStatement {
    using l = this.leaseSync();
    return this.#track(l.channel.callSync('prepare', { sql }), sql);
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

  /**
   * Blocking `beginTransaction`. **Blocks the calling thread.** The connection is reserved
   * for the transaction until it ends.
   */
  beginTransactionSync(options?: TransactionOptions): Transaction {
    return Transaction.beginSync(this.leaseSync(), options);
  }

  /**
   * Blocking `transaction`. **Blocks the calling thread.** Runs `fn` in a transaction,
   * commits when it returns and rolls back when it throws. `fn` must be synchronous: a
   * returned promise rolls back and throws a TypeError, since its statements would run
   * after the commit.
   */
  transactionSync<R>(fn: (tx: Transaction) => R, options?: TransactionOptions): R {
    using tx = this.beginTransactionSync(options);
    const result = fn(tx);
    if (isThenable(result)) {
      // Its later statements fail on the rolled back transaction; that is reported here.
      Promise.resolve(result).catch(() => {});
      throw new TypeError(
        'transactionSync callback returned a promise; use transaction() for async callbacks',
      );
    }
    if (tx.active) tx.commitSync();
    return result;
  }

  /** Closes the connection. Statements still queued are rejected; an open transaction rolls back. */
  async close(): Promise<void> {
    for (const ps of this.#prepared) ps.markFreed();
    this.#prepared.clear();
    await this.#channel.close();
  }

  /**
   * Closes the connection. **Blocks the calling thread** until the worker has disconnected. Throws
   * ConnectionBusyError while an async request is in flight (use `close()` then).
   */
  closeSync(): void {
    try {
      this.#channel.closeSync();
    } finally {
      if (this.#channel.closed) {
        for (const ps of this.#prepared) ps.markFreed();
        this.#prepared.clear();
      }
    }
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  /** `using` support: `closeSync()`. **Blocks the calling thread.** */
  [Symbol.dispose](): void {
    this.closeSync();
  }
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return (
    (typeof v === 'object' || typeof v === 'function') &&
    v !== null &&
    typeof (v as { then?: unknown }).then === 'function'
  );
}

/** Opens a connection with an ODBC connection string. */
export function open(connectionString: string, options?: ConnectionOptions): Promise<Connection> {
  return Connection.open(connectionString, options);
}

/**
 * Opens a connection with an ODBC connection string. **Blocks the calling thread** until the
 * login completes; the connection supports both async and blocking calls.
 */
export function openSync(connectionString: string, options?: ConnectionOptions): Connection {
  return Connection.openSync(connectionString, options);
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
