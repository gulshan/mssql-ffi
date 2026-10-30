// mutex.ts - FIFO async lock with abortable waits.

export type Release = () => void;

export class Mutex {
  #tail: Promise<void> = Promise.resolve();
  /** Holders plus waiters (including aborted ones whose turn has not come yet). */
  #count = 0;

  #enqueue(): { prev: Promise<void>; release: Release } {
    const turn = Promise.withResolvers<void>();
    const prev = this.#tail;
    this.#tail = turn.promise;
    this.#count++;
    let released = false;
    const release: Release = () => {
      if (released) return;
      released = true;
      this.#count--;
      turn.resolve();
    };
    return { prev, release };
  }

  /** Resolves with a release function once every earlier holder has released. */
  acquire(signal?: AbortSignal): Promise<Release> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const { prev, release } = this.#enqueue();
    if (!signal) return prev.then(() => release);

    const { promise, resolve, reject } = Promise.withResolvers<Release>();
    const onAbort = (): void => {
      // Give up the place in line without blocking those queued behind it.
      void prev.then(release);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void prev.then(() => {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) release();
      else resolve(release);
    });
    return promise;
  }

  /**
   * Takes the lock now if nobody holds or waits for it; undefined otherwise. A lock just
   * released to a waiter that has not resumed yet still counts as taken.
   */
  tryAcquire(): Release | undefined {
    if (this.#count > 0) return undefined;
    return this.#enqueue().release;
  }
}
