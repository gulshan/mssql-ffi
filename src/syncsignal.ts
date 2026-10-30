// syncsignal.ts - lets a blocked main thread wait for replies on the worker's sync port.
//
// Layout of the SharedArrayBuffer:
//   Int32[0]  replies posted on the sync port so far (the main thread waits on it)
//   Int32[1]  1 once the worker thread is exiting
// A blocked thread cannot get 'message' or 'exit' events, so both travel through here.

export const SYNC_BYTES = 8;

export class SyncSignal {
  readonly #state: Int32Array;

  constructor(buffer: SharedArrayBuffer) {
    this.#state = new Int32Array(buffer, 0, 2);
  }

  /** Worker: a reply has been posted (call after `postMessage`). */
  posted(): void {
    Atomics.add(this.#state, 0, 1);
    Atomics.notify(this.#state, 0);
  }

  /** Worker: the thread is going away; wakes a waiting main thread. */
  exiting(): void {
    Atomics.store(this.#state, 1, 1);
    Atomics.add(this.#state, 0, 1);
    Atomics.notify(this.#state, 0);
  }

  /** Main thread: replies posted so far. Read before draining the port. */
  get count(): number {
    return Atomics.load(this.#state, 0);
  }

  get dead(): boolean {
    return Atomics.load(this.#state, 1) !== 0;
  }

  /** Main thread: blocks until the count moves past `seen`, or for at most `ms`. */
  wait(seen: number, ms: number): void {
    Atomics.wait(this.#state, 0, seen, ms);
  }
}
