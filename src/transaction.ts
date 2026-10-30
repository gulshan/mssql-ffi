// transaction.ts - a transaction holds its connection until commit or rollback.
import { ConnectionBusyError } from './channel.ts';
import { lease } from './lease.ts';
import type { Lease } from './lease.ts';
import { Mutex } from './mutex.ts';
import type { Release } from './mutex.ts';
import { PreparedStatement } from './prepared.ts';
import { SyncQueryable } from './queryable.ts';
import type { TransactionOptions } from './types.ts';

export class Transaction extends SyncQueryable implements AsyncDisposable, Disposable {
  readonly #outer: Lease;
  readonly #mutex = new Mutex();
  readonly #prepared = new Set<PreparedStatement>();
  readonly #onEnd: (() => void) | undefined;
  #state: 'active' | 'committed' | 'rolled back' = 'active';

  private constructor(outer: Lease, onEnd: (() => void) | undefined) {
    super();
    this.#outer = outer;
    this.#onEnd = onEnd;
  }

  /** @internal Takes ownership of `outer`, releasing it when the transaction ends. */
  static async begin(
    outer: Lease,
    options: TransactionOptions = {},
    onEnd?: () => void,
  ): Promise<Transaction> {
    try {
      await outer.channel.call('tx.begin', { isolationLevel: options.isolationLevel });
    } catch (e) {
      outer.release();
      onEnd?.();
      throw e;
    }
    return new Transaction(outer, onEnd);
  }

  /** @internal Blocking `begin`. */
  static beginSync(
    outer: Lease,
    options: TransactionOptions = {},
    onEnd?: () => void,
  ): Transaction {
    try {
      outer.channel.callSync('tx.begin', { isolationLevel: options.isolationLevel });
    } catch (e) {
      outer.release();
      onEnd?.();
      throw e;
    }
    return new Transaction(outer, onEnd);
  }

  get active(): boolean {
    return this.#state === 'active';
  }

  #assertActive(): void {
    if (this.#state !== 'active') throw new Error(`Transaction already ${this.#state}`);
  }

  protected async lease(signal?: AbortSignal): Promise<Lease> {
    this.#assertActive();
    const release = await this.#mutex.acquire(signal);
    if (this.#state !== 'active') {
      release();
      this.#assertActive();
    }
    return lease(this.#outer.channel, this.#outer.decode, this.#outer.procs, release);
  }

  protected leaseSync(): Lease {
    this.#assertActive();
    return lease(this.#outer.channel, this.#outer.decode, this.#outer.procs, this.#tryLock());
  }

  #tryLock(): Release {
    const release = this.#mutex.tryAcquire();
    if (!release) {
      throw new ConnectionBusyError(
        'Transaction is in use by an async operation; a blocking call cannot wait for it',
      );
    }
    return release;
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

  /** Prepares a statement that is freed when the transaction ends. */
  async prepare(sql: string): Promise<PreparedStatement> {
    using l = await this.lease();
    return this.#track(await l.channel.call('prepare', { sql }), sql);
  }

  /** Blocking `prepare`. */
  prepareSync(sql: string): PreparedStatement {
    using l = this.leaseSync();
    return this.#track(l.channel.callSync('prepare', { sql }), sql);
  }

  commit(): Promise<void> {
    return this.#end(true);
  }

  rollback(): Promise<void> {
    return this.#end(false);
  }

  /** Blocking `commit`. */
  commitSync(): void {
    this.#endSync(true);
  }

  /** Blocking `rollback`. */
  rollbackSync(): void {
    this.#endSync(false);
  }

  /** Marks the end and detaches the transaction's prepared statements. */
  #finish(commit: boolean): PreparedStatement[] {
    this.#state = commit ? 'committed' : 'rolled back';
    const prepared = [...this.#prepared];
    for (const ps of prepared) ps.markFreed();
    this.#prepared.clear();
    return prepared;
  }

  async #end(commit: boolean): Promise<void> {
    this.#assertActive();
    // Wait for in-flight operations of this transaction.
    const release = await this.#mutex.acquire();
    try {
      this.#assertActive();
      const { channel } = this.#outer;
      for (const ps of this.#finish(commit)) {
        // oxlint-disable-next-line no-await-in-loop -- one request at a time per connection
        await channel.call('prepared.free', { id: ps.id }).catch(() => {});
      }
      await channel.call(commit ? 'tx.commit' : 'tx.rollback', undefined);
    } finally {
      release();
      this.#outer.release();
      this.#onEnd?.();
    }
  }

  #endSync(commit: boolean): void {
    this.#assertActive();
    // Cannot wait for this transaction's async operations: busy until they are done.
    const release = this.#tryLock();
    try {
      const { channel } = this.#outer;
      for (const ps of this.#finish(commit)) {
        try {
          channel.callSync('prepared.free', { id: ps.id });
        } catch {
          // freed with the connection at the latest
        }
      }
      channel.callSync(commit ? 'tx.commit' : 'tx.rollback', undefined);
    } finally {
      release();
      this.#outer.release();
      this.#onEnd?.();
    }
  }

  /** Rolls back unless already committed or rolled back. */
  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#state === 'active') await this.rollback();
  }

  /** Blocking dispose: rolls back unless already committed or rolled back. */
  [Symbol.dispose](): void {
    if (this.#state === 'active') this.rollbackSync();
  }
}
