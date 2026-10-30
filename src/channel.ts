// channel.ts - request/response RPC with the connection's worker thread.
import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads';
import type { MessagePort } from 'node:worker_threads';
import { CANCEL_BYTES, CancelSlot } from './cancel.ts';
import { deserializeError, timeoutError } from './errors.ts';
import type { SerializedError } from './errors.ts';
import { Flow, FLOW_BYTES } from './flow.ts';
import type { ArgsOf, Op, Partial, Response, ResultOf, WorkerData } from './protocol.ts';
import { SYNC_BYTES, SyncSignal } from './syncsignal.ts';

/** Longest single block in `callSync`, so worker death and deadlines are noticed. */
const WAIT_SLICE_MS = 50;

export interface CallSyncOptions {
  /** SQLCancels the request once this many milliseconds have passed. */
  timeoutMs?: number | undefined;
  onPartial?: ((p: Partial) => void) | undefined;
}

interface Pending {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
  /** Stack of the call site, so errors point at user code rather than the message handler. */
  site: { stack?: string };
  onPartial: ((p: Partial) => void) | undefined;
}

// Dev and tests run the TypeScript sources; the published build ships worker.mjs.
const WORKER_URL = new URL(
  import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.mjs',
  import.meta.url,
);

export class ConnectionClosedError extends Error {
  override name = 'ConnectionClosedError';
}

/** A blocking call was made while the connection is in use by an async operation. */
export class ConnectionBusyError extends Error {
  override name = 'ConnectionBusyError';

  constructor(
    message = 'Connection is busy with an async operation; a blocking call cannot wait for it',
  ) {
    super(message);
  }
}

export class Channel {
  readonly #worker: Worker;
  readonly #cancel: CancelSlot;
  readonly #flow: Flow;
  readonly #pending = new Map<number, Pending>();
  /** Main thread end of the sync port; read only with `receiveMessageOnPort`. */
  readonly #port: MessagePort;
  readonly #signal: SyncSignal;
  #seq = 0;
  #dead: Error | undefined;

  /** @param workerUrl tests substitute a fake worker that speaks the same protocol. */
  constructor(workerUrl: URL = WORKER_URL) {
    const cancel = new SharedArrayBuffer(CANCEL_BYTES);
    this.#cancel = new CancelSlot(cancel);
    const flow = new SharedArrayBuffer(FLOW_BYTES);
    this.#flow = new Flow(flow);
    const sync = new SharedArrayBuffer(SYNC_BYTES);
    this.#signal = new SyncSignal(sync);
    const { port1, port2 } = new MessageChannel();
    this.#port = port1;
    this.#worker = new Worker(workerUrl, {
      name: 'mssql-ffi',
      workerData: { cancel, flow, port: port2, sync } satisfies WorkerData,
      transferList: [port2],
    });
    // An idle connection must not keep the process alive; ref while requests are pending.
    this.#worker.unref();
    this.#worker.on('message', (res: Response) => this.#settle(res));
    this.#worker.on('error', (e: Error) => this.#fail(e));
    this.#worker.on('messageerror', (e: Error) => this.#fail(e));
    this.#worker.on('exit', (code) =>
      this.#fail(new ConnectionClosedError(`Connection worker exited (code ${code})`)),
    );
  }

  get closed(): boolean {
    return this.#dead !== undefined;
  }

  #settle(res: Response): void {
    if ('partial' in res) {
      try {
        this.#pending.get(res.id)?.onPartial?.(res.partial);
      } finally {
        this.#flow.release();
      }
      return;
    }
    const p = this.#pending.get(res.id);
    if (!p) return;
    this.#pending.delete(res.id);
    if (this.#pending.size === 0) this.#worker.unref();
    if (res.ok) {
      p.resolve(res.value);
      return;
    }
    p.reject(remoteError(res.error, p.site));
  }

  #fail(e: Error): void {
    this.#dead ??= e;
    for (const p of this.#pending.values()) p.reject(e);
    this.#pending.clear();
  }

  /**
   * Sends one request and blocks the calling thread until the worker replies. Partials are
   * decoded in between, so decoding still overlaps the worker's fetch. The caller must hold
   * the connection: nothing else may be in flight on this channel.
   */
  callSync<K extends Op>(op: K, args: ArgsOf<K>, options: CallSyncOptions = {}): ResultOf<K> {
    if (this.#dead) throw this.#dead;
    // Waiting here while async replies are due would deadlock: they need the event loop.
    if (this.#pending.size) throw new ConnectionBusyError();
    const { timeoutMs, onPartial } = options;
    const id = ++this.#seq;
    const site = {};
    Error.captureStackTrace(site, Channel.prototype.callSync);
    const deadline = timeoutMs === undefined ? Infinity : performance.now() + timeoutMs;
    let timedOut = false;
    let failure: { error: unknown } | undefined;
    this.#port.postMessage({ id, op, args });
    for (;;) {
      const seen = this.#signal.count;
      for (let m = receiveMessageOnPort(this.#port); m; m = receiveMessageOnPort(this.#port)) {
        const res = m.message as Response;
        if ('partial' in res) {
          try {
            // A failed decode keeps draining: the worker must finish before we can return.
            if (res.id === id && !failure) onPartial?.(res.partial);
          } catch (e) {
            failure = { error: e };
          } finally {
            this.#flow.release();
          }
          continue;
        }
        if (res.id !== id) continue;
        if (failure) throw failure.error;
        if (res.ok) return res.value as ResultOf<K>;
        const err = remoteError(res.error, site);
        throw timedOut ? timeoutError(err) : err;
      }
      if (this.#signal.dead) {
        this.#fail(new ConnectionClosedError('Connection worker exited'));
        throw this.#dead;
      }
      const left = deadline - performance.now();
      if (left <= 0) {
        // Repeated each slice: the statement may not have started executing yet.
        timedOut = true;
        this.#cancel.cancel(id);
      }
      this.#signal.wait(seen, left > 0 ? Math.min(WAIT_SLICE_MS, left) : WAIT_SLICE_MS);
    }
  }

  /** Closes the ODBC connection and stops the worker, blocking until the connection is closed. */
  closeSync(): void {
    if (this.#dead) return;
    // Checked before anything is torn down, so a busy connection stays usable.
    if (this.#pending.size) throw new ConnectionBusyError();
    try {
      this.callSync('close', undefined);
    } finally {
      this.#fail(new ConnectionClosedError('Connection is closed'));
      this.#port.close();
      void this.#worker.terminate();
    }
  }

  /** Sends one request. Aborting the signal SQLCancels it; the promise still waits for the worker. */
  call<K extends Op>(
    op: K,
    args: ArgsOf<K>,
    signal?: AbortSignal,
    onPartial?: (p: Partial) => void,
  ): Promise<ResultOf<K>> {
    if (this.#dead) return Promise.reject(this.#dead);
    if (signal?.aborted) return Promise.reject(signal.reason);
    const id = ++this.#seq;
    const site = {};
    Error.captureStackTrace(site, Channel.prototype.call);
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    let onAbort: (() => void) | undefined;
    if (signal) {
      onAbort = () => this.#cancel.cancel(id);
      signal.addEventListener('abort', onAbort, { once: true });
    }
    this.#pending.set(id, {
      resolve,
      // An aborted request rejects with the abort reason, keeping the driver error as cause.
      reject: (e) => reject(signal?.aborted ? withCause(signal.reason, e) : e),
      site,
      onPartial,
    });
    if (this.#pending.size === 1) this.#worker.ref();
    this.#worker.postMessage({ id, op, args });
    if (!signal || !onAbort) return promise as Promise<ResultOf<K>>;
    const listener = onAbort;
    return promise.finally(() => signal.removeEventListener('abort', listener)) as Promise<
      ResultOf<K>
    >;
  }

  /** Closes the ODBC connection and stops the worker. */
  async close(): Promise<void> {
    if (this.#dead) return;
    try {
      await this.call('close', undefined);
    } finally {
      this.#fail(new ConnectionClosedError('Connection is closed'));
      this.#port.close();
      await this.#worker.terminate();
    }
  }
}

/** Rebuilds a worker error with the stack of the call site, so it points at user code. */
function remoteError(error: SerializedError, site: { stack?: string }): Error {
  const err = deserializeError(error);
  const stack = site.stack?.split('\n').slice(1).join('\n');
  if (stack) err.stack = `${err.name}: ${err.message}\n${stack}`;
  return err;
}

function withCause(reason: unknown, cause: unknown): unknown {
  if (Error.isError(reason) && reason.cause === undefined) {
    try {
      Object.defineProperty(reason, 'cause', { value: cause, configurable: true, writable: true });
    } catch {
      // frozen reason: keep it as is
    }
  }
  return reason;
}
