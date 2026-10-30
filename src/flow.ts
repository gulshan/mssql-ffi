// flow.ts - back-pressure for partial results. The worker may run ahead of the main thread
// by at most MAX_IN_FLIGHT undecoded chunks. Node delivers all queued messages in one go, so
// an unbounded backlog would turn into one long event loop stall (and unbounded memory).

export const MAX_IN_FLIGHT = 4;
export const FLOW_BYTES = 4;

export class Flow {
  readonly #count: Int32Array;

  constructor(buffer: SharedArrayBuffer) {
    this.#count = new Int32Array(buffer, 0, 1);
  }

  /** Worker: waits while too many chunks are undecoded, then counts one more. */
  acquire(): void {
    for (;;) {
      const n = Atomics.load(this.#count, 0);
      if (n < MAX_IN_FLIGHT) {
        // The worker is the only producer, so load + add cannot race with another add.
        Atomics.add(this.#count, 0, 1);
        return;
      }
      // Bounded wait: re-checks even if a notify is missed.
      Atomics.wait(this.#count, 0, n, 100);
    }
  }

  /** Main thread: one chunk has been decoded. */
  release(): void {
    Atomics.sub(this.#count, 0, 1);
    Atomics.notify(this.#count, 0);
  }
}
