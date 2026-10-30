// transaction.ts - a transaction holds its connection until commit or rollback.
import { lease } from './lease.ts';
import type { Lease } from './lease.ts';
import { Mutex } from './mutex.ts';
import { PreparedStatement } from './prepared.ts';
import { Queryable } from './queryable.ts';
import type { TransactionOptions } from './types.ts';

export class Transaction extends Queryable implements AsyncDisposable {
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

  /** Prepares a statement that is freed when the transaction ends. */
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

  commit(): Promise<void> {
    return this.#end(true);
  }

  rollback(): Promise<void> {
    return this.#end(false);
  }

  async #end(commit: boolean): Promise<void> {
    this.#assertActive();
    // Wait for in-flight operations of this transaction.
    const release = await this.#mutex.acquire();
    try {
      this.#assertActive();
      this.#state = commit ? 'committed' : 'rolled back';
      const { channel } = this.#outer;
      for (const ps of this.#prepared) {
        ps.markFreed();
        // oxlint-disable-next-line no-await-in-loop -- one request at a time per connection
        await channel.call('prepared.free', { id: ps.id }).catch(() => {});
      }
      this.#prepared.clear();
      await channel.call(commit ? 'tx.commit' : 'tx.rollback', undefined);
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
}
