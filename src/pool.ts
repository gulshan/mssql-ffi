// pool.ts - a pool of connections, each with its own worker thread.
import { Connection, connectionLease } from './connection.ts';
import { lease } from './lease.ts';
import type { Lease } from './lease.ts';
import type { ProcCache } from './proc.ts';
import { Queryable } from './queryable.ts';
import { Transaction } from './transaction.ts';
import type { ConnectionOptions, TransactionOptions } from './types.ts';

export interface PoolOptions extends ConnectionOptions {
  connectionString: string;
  /** Connections kept open even when idle (default 0). */
  floor?: number | undefined;
  /** Maximum number of connections; further requests wait (default 4). */
  ceiling?: number | undefined;
  /** Idle connections above the floor are closed after this many seconds (default 30). */
  inactivityTimeoutSecs?: number | undefined;
}

export interface PoolStatus {
  /** Open (or opening) connections. */
  size: number;
  idle: number;
  busy: number;
  /** Requests waiting for a connection. */
  waiting: number;
}

/** A connection borrowed from the pool. Release it (or `using` it) when done. */
export interface PooledConnection extends Disposable {
  readonly connection: Connection;
  release(): void;
}

interface Idle {
  conn: Connection;
  since: number;
}

interface Waiter {
  resolve(conn: Connection): void;
  reject(reason: unknown): void;
  signal: AbortSignal | undefined;
}

export class PoolClosedError extends Error {
  override name = 'PoolClosedError';
}

export class Pool extends Queryable implements AsyncDisposable {
  readonly #options: PoolOptions;
  readonly #floor: number;
  readonly #ceiling: number;
  readonly #idleMs: number;
  readonly #idle: Idle[] = [];
  readonly #busy = new Set<Connection>();
  readonly #waiters: Waiter[] = [];
  readonly #procs: ProcCache = new Map();
  #opening = 0;
  #closed = false;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: PoolOptions) {
    super();
    this.#options = options;
    this.#floor = options.floor ?? 0;
    this.#ceiling = Math.max(options.ceiling ?? 4, 1, this.#floor);
    this.#idleMs = (options.inactivityTimeoutSecs ?? 30) * 1000;
  }

  /** Creates a pool and opens its `floor` connections. */
  static async open(options: PoolOptions): Promise<Pool> {
    const pool = new Pool(options);
    await pool.open();
    return pool;
  }

  /** Opens the `floor` connections (also done lazily on demand). */
  async open(): Promise<this> {
    this.#assertOpen();
    const missing = this.#floor - this.#size();
    const opened = await Promise.all(
      Array.from({ length: Math.max(missing, 0) }, () => this.#create()),
    );
    for (const conn of opened) this.#release(conn);
    this.#schedule();
    return this;
  }

  get status(): PoolStatus {
    return {
      size: this.#size(),
      idle: this.#idle.length,
      busy: this.#busy.size,
      waiting: this.#waiters.length,
    };
  }

  #size(): number {
    return this.#idle.length + this.#busy.size + this.#opening;
  }

  #assertOpen(): void {
    if (this.#closed) throw new PoolClosedError('Pool is closed');
  }

  async #create(): Promise<Connection> {
    this.#opening++;
    try {
      const { connectionString, ...options } = this.#options;
      return await Connection.open(connectionString, options);
    } finally {
      this.#opening--;
    }
  }

  /** Borrows a connection, opening one if below the ceiling, else waiting for one. */
  async acquire(signal?: AbortSignal): Promise<PooledConnection> {
    const conn = await this.#borrow(signal);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.#release(conn);
    };
    return { connection: conn, release, [Symbol.dispose]: release };
  }

  async #borrow(signal?: AbortSignal): Promise<Connection> {
    this.#assertOpen();
    signal?.throwIfAborted();
    while (this.#idle.length) {
      const { conn } = this.#idle.pop()!;
      if (conn.isClosed()) continue;
      this.#busy.add(conn);
      return conn;
    }
    if (this.#size() < this.#ceiling) {
      const conn = await this.#create();
      if (this.#closed) {
        await conn.close();
        this.#assertOpen();
      }
      this.#busy.add(conn);
      return conn;
    }
    return new Promise<Connection>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      this.#waiters.push(waiter);
      signal?.addEventListener(
        'abort',
        () => {
          const i = this.#waiters.indexOf(waiter);
          if (i !== -1) this.#waiters.splice(i, 1);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  }

  #release(conn: Connection): void {
    this.#busy.delete(conn);
    if (this.#closed || conn.isClosed()) {
      if (!conn.isClosed()) void conn.close().catch(() => {});
      this.#refill();
      return;
    }
    const waiter = this.#nextWaiter();
    if (waiter) {
      this.#busy.add(conn);
      waiter.resolve(conn);
      return;
    }
    this.#idle.push({ conn, since: performance.now() });
  }

  #nextWaiter(): Waiter | undefined {
    let w: Waiter | undefined;
    while ((w = this.#waiters.shift()) && w.signal?.aborted);
    return w;
  }

  /** A connection was discarded: open a replacement for a waiter, if any. */
  #refill(): void {
    if (this.#closed || !this.#waiters.length || this.#size() >= this.#ceiling) return;
    this.#create().then(
      (conn) => this.#release(conn),
      (e: unknown) => this.#nextWaiter()?.reject(e),
    );
  }

  #schedule(): void {
    if (this.#timer || this.#closed) return;
    this.#timer = setInterval(
      () => this.#reap(),
      Math.max(Math.min(this.#idleMs / 2, 10_000), 100),
    );
    this.#timer.unref();
  }

  #reap(): void {
    const now = performance.now();
    // Oldest idle connections are at the front.
    while (this.#idle.length && this.#size() > this.#floor) {
      const oldest = this.#idle[0]!;
      if (now - oldest.since < this.#idleMs && !oldest.conn.isClosed()) break;
      this.#idle.shift();
      void oldest.conn.close().catch(() => {});
    }
  }

  protected async lease(signal?: AbortSignal): Promise<Lease> {
    const conn = await this.#borrow(signal);
    this.#schedule();
    let inner: Lease;
    try {
      inner = await connectionLease(conn, signal);
    } catch (e) {
      this.#release(conn);
      throw e;
    }
    return lease(inner.channel, inner.decode, this.#procs, () => {
      inner.release();
      this.#release(conn);
    });
  }

  /** Starts a transaction on a borrowed connection, returned to the pool when it ends. */
  async beginTransaction(options?: TransactionOptions): Promise<Transaction> {
    const l = await this.lease();
    return Transaction.begin(l, options);
  }

  /** Runs `fn` in a transaction on a borrowed connection. */
  async transaction<R>(
    fn: (tx: Transaction) => Promise<R>,
    options?: TransactionOptions,
  ): Promise<R> {
    await using tx = await this.beginTransaction(options);
    const result = await fn(tx);
    if (tx.active) await tx.commit();
    return result;
  }

  /** Closes idle connections now and busy ones as they are released. Waiters are rejected. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#timer);
    const err = new PoolClosedError('Pool is closed');
    for (const w of this.#waiters.splice(0)) w.reject(err);
    const idle = this.#idle.splice(0);
    await Promise.allSettled(idle.map(({ conn }) => conn.close()));
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}
