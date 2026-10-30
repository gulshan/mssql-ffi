// mutex.ts - FIFO async lock with abortable waits.

export type Release = () => void;

export class Mutex {
  #tail: Promise<void> = Promise.resolve();

  /** Resolves with a release function once every earlier holder has released. */
  acquire(signal?: AbortSignal): Promise<Release> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const turn = Promise.withResolvers<void>();
    const prev = this.#tail;
    this.#tail = turn.promise;
    let released = false;
    const release: Release = () => {
      if (released) return;
      released = true;
      turn.resolve();
    };
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
}
