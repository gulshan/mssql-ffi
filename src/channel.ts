// channel.ts - request/response RPC with the connection's worker thread.
import { Worker } from 'node:worker_threads';
import { CANCEL_BYTES, CancelSlot } from './cancel.ts';
import { deserializeError } from './errors.ts';
import { Flow, FLOW_BYTES } from './flow.ts';
import type { ArgsOf, Op, Partial, Response, ResultOf, WorkerData } from './protocol.ts';

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

export class Channel {
  readonly #worker: Worker;
  readonly #cancel: CancelSlot;
  readonly #flow: Flow;
  readonly #pending = new Map<number, Pending>();
  #seq = 0;
  #dead: Error | undefined;

  constructor() {
    const cancel = new SharedArrayBuffer(CANCEL_BYTES);
    this.#cancel = new CancelSlot(cancel);
    const flow = new SharedArrayBuffer(FLOW_BYTES);
    this.#flow = new Flow(flow);
    this.#worker = new Worker(WORKER_URL, {
      name: 'mssql-ffi',
      workerData: { cancel, flow } satisfies WorkerData,
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
    const err = deserializeError(res.error);
    const site = p.site.stack?.split('\n').slice(1).join('\n');
    if (site) err.stack = `${err.name}: ${err.message}\n${site}`;
    p.reject(err);
  }

  #fail(e: Error): void {
    this.#dead ??= e;
    for (const p of this.#pending.values()) p.reject(e);
    this.#pending.clear();
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
      await this.#worker.terminate();
    }
  }
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
