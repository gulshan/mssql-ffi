// worker.ts - owns one ODBC connection so blocking FFI calls stay off the main thread.
import { parentPort, workerData } from 'node:worker_threads';
import { CancelSlot } from './cancel.ts';
import { serializeError } from './errors.ts';
import { Flow } from './flow.ts';
import { Connection } from './odbc/connection.ts';
import type { Track } from './odbc/connection.ts';
import type { OnRows } from './odbc/statement.ts';
import type { Request, Response, WorkerData } from './protocol.ts';
import type { WireValue } from './types.ts';

if (!parentPort) throw new Error('mssql-ffi: worker.ts must run as a worker thread');
const port = parentPort;
const slot = new CancelSlot((workerData as WorkerData).cancel);
const flow = new Flow((workerData as WorkerData).flow);

let conn: Connection | undefined;

function connection(): Connection {
  if (!conn) throw new Error('Not connected');
  return conn;
}

/** Binary values are freshly allocated in the worker, so their memory can be moved, not copied. */
function transferables(rows: WireValue[][], out: ArrayBuffer[]): void {
  for (const row of rows) {
    for (const v of row) if (v instanceof Uint8Array) out.push(v.buffer as ArrayBuffer);
  }
}

function handle(req: Request): { value: unknown; transfer?: ArrayBuffer[] } {
  const track: Track = (stmt, fn) => {
    slot.publish(stmt.handle, req.id);
    try {
      return fn();
    } finally {
      slot.clear();
    }
  };
  // Query rows go out in chunks as they are read: the main thread decodes them while the
  // worker keeps fetching, and no single huge message stalls its event loop.
  const onRows: OnRows = (set, columns, rows) => {
    const transfer: ArrayBuffer[] = [];
    transferables(rows, transfer);
    const res: Response = { id: req.id, partial: { set, columns, rows } };
    flow.acquire();
    port.postMessage(res, transfer);
  };
  switch (req.op) {
    case 'open':
      conn?.close();
      conn = Connection.open(req.args.connectionString, req.args.loginTimeoutSecs);
      return { value: undefined };
    case 'close':
      conn?.close();
      conn = undefined;
      return { value: undefined };
    case 'query': {
      return { value: connection().query(req.args, track, onRows) };
    }
    case 'cursor.open':
      return { value: connection().cursorOpen(req.args, track) };
    case 'cursor.fetch': {
      const value = connection().cursorFetch(req.args.max, track);
      const transfer: ArrayBuffer[] = [];
      transferables(value.rows, transfer);
      return { value, transfer };
    }
    case 'cursor.close':
      connection().cursorClose();
      return { value: undefined };
    case 'prepare':
      return { value: connection().prepare(req.args.sql) };
    case 'prepared.query': {
      return { value: connection().preparedQuery(req.args.id, req.args.params, track, onRows) };
    }
    case 'prepared.free':
      connection().preparedFree(req.args.id);
      return { value: undefined };
    case 'tx.begin':
      connection().begin(req.args.isolationLevel);
      return { value: undefined };
    case 'tx.commit':
      connection().end(true);
      return { value: undefined };
    case 'tx.rollback':
      connection().end(false);
      return { value: undefined };
  }
}

port.on('message', (req: Request) => {
  let res: Response;
  let transfer: ArrayBuffer[] = [];
  try {
    const out = handle(req);
    res = { id: req.id, ok: true, value: out.value };
    transfer = out.transfer ?? [];
  } catch (e) {
    res = { id: req.id, ok: false, error: serializeError(e) };
  }
  port.postMessage(res, transfer);
});
