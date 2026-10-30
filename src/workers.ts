// workers.ts - connection worker threads, kept between connections.
//
// Starting a worker thread costs far more than an ODBC login on a warm driver, so a worker
// whose connection closed cleanly is parked here, unref'd, and the next open takes it. A
// parked worker holds no ODBC connection; it exits after IDLE_MS unused.
import { MessageChannel, Worker } from 'node:worker_threads';
import type { MessagePort } from 'node:worker_threads';
import { CANCEL_BYTES, CancelSlot } from './cancel.ts';
import { Flow, FLOW_BYTES } from './flow.ts';
import type { WorkerData } from './protocol.ts';
import { SYNC_BYTES, SyncSignal } from './syncsignal.ts';

/** Most workers kept parked; more are terminated when their connection closes. */
export const MAX_IDLE = 4;
/** A parked worker exits after this long unused. */
export const IDLE_MS = 10_000;

/** A started worker and the shared state its connections use. */
export interface Thread {
  readonly worker: Worker;
  /** Main thread end of the sync port; read only with `receiveMessageOnPort`. */
  readonly port: MessagePort;
  readonly cancel: CancelSlot;
  readonly flow: Flow;
  readonly signal: SyncSignal;
  /**
   * Last request id sent to this worker. It carries over to the next connection, so a late
   * cancel or reply from a closed connection can never match a newer request.
   */
  seq: number;
}

interface Parked {
  thread: Thread;
  timer: NodeJS.Timeout;
  onExit(): void;
}

/** Parked workers by worker URL, most recently parked last. */
const idle = new Map<string, Parked[]>();

function spawn(url: URL): Thread {
  const cancel = new SharedArrayBuffer(CANCEL_BYTES);
  const flow = new SharedArrayBuffer(FLOW_BYTES);
  const sync = new SharedArrayBuffer(SYNC_BYTES);
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(url, {
    name: 'mssql-ffi',
    workerData: { cancel, flow, port: port2, sync } satisfies WorkerData,
    transferList: [port2],
  });
  // An idle connection must not keep the process alive; channels ref while requests are pending.
  worker.unref();
  return {
    worker,
    port: port1,
    cancel: new CancelSlot(cancel),
    flow: new Flow(flow),
    signal: new SyncSignal(sync),
    seq: 0,
  };
}

function unpark(list: Parked[], p: Parked): void {
  const i = list.indexOf(p);
  if (i !== -1) list.splice(i, 1);
  clearTimeout(p.timer);
  p.thread.worker.off('exit', p.onExit).off('error', p.onExit);
}

/** A started worker for a new connection: the most recently parked one if any, else a new one. */
export function take(url: URL): Thread {
  const list = idle.get(url.href) ?? [];
  for (let p = list.at(-1); p; p = list.at(-1)) {
    unpark(list, p);
    // Skips a worker that has exited but whose 'exit' event is not delivered yet.
    if (p.thread.worker.threadId !== -1 && !p.thread.signal.dead) return p.thread;
    p.thread.port.close();
  }
  return spawn(url);
}

/**
 * Keeps the worker of a closed connection for the next one, or terminates it when enough
 * are parked. Call only once its ODBC connection is closed and nothing is in flight.
 */
export function park(url: URL, thread: Thread): Promise<void> {
  let list = idle.get(url.href);
  if (list && list.length >= MAX_IDLE) return retire(thread);
  if (!list) idle.set(url.href, (list = []));
  const parked: Parked = {
    thread,
    timer: setTimeout(() => {
      unpark(list, parked);
      void retire(thread);
    }, IDLE_MS).unref(),
    // A parked worker that dies is simply forgotten.
    onExit: () => unpark(list, parked),
  };
  thread.worker.unref();
  thread.worker.on('exit', parked.onExit).on('error', parked.onExit);
  list.push(parked);
  return Promise.resolve();
}

/** Stops a worker for good. */
export async function retire(thread: Thread): Promise<void> {
  thread.port.close();
  await thread.worker.terminate();
}
