// cancel.ts - lets the main thread SQLCancel the statement a blocked worker is executing.
//
// Layout of the SharedArrayBuffer:
//   Int32[0]    spin lock (0 = free, 1 = held)
//   BigInt64[1] statement handle being executed (0n = none)
//   BigInt64[2] id of the request that owns it
// The worker clears the slot under the lock before freeing the handle, so the main
// thread never cancels a freed statement.
import { odbc } from './odbc/ffi.ts';

export const CANCEL_BYTES = 24;

export class CancelSlot {
  readonly #lock: Int32Array;
  readonly #slot: BigInt64Array;

  constructor(buffer: SharedArrayBuffer) {
    this.#lock = new Int32Array(buffer, 0, 1);
    this.#slot = new BigInt64Array(buffer, 8, 2);
  }

  #with<T>(fn: () => T): T {
    while (Atomics.compareExchange(this.#lock, 0, 0, 1) !== 0) Atomics.pause();
    try {
      return fn();
    } finally {
      Atomics.store(this.#lock, 0, 0);
    }
  }

  /** Worker: marks `handle` as executing on behalf of request `id`. */
  publish(handle: bigint, id: number): void {
    this.#with(() => {
      this.#slot[0] = handle;
      this.#slot[1] = BigInt(id);
    });
  }

  /** Worker: clears the slot. Must happen before the handle is freed. */
  clear(): void {
    this.#with(() => {
      this.#slot[0] = 0n;
      this.#slot[1] = 0n;
    });
  }

  /** Main thread: cancels request `id` if it is still executing. */
  cancel(id: number): boolean {
    return this.#with(() => {
      const handle = this.#slot[0]!;
      if (handle === 0n || this.#slot[1] !== BigInt(id)) return false;
      odbc().SQLCancel(handle);
      return true;
    });
  }
}
