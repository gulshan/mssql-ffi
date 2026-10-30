// fake-worker.ts - speaks the worker protocol without ODBC, for Channel tests.
// `query` takes a command in `sql`:
//   echo             → replies with the args
//   partials:N       → N one-row partials, then the final result
//   fail             → an error reply
//   exit             → the thread exits without replying
//   sleep:MS         → replies after MS milliseconds
//   sleepfail:MS     → an error reply after MS milliseconds
//   stale            → a reply for another request id first, then the real one
import { parentPort, workerData } from 'node:worker_threads';
import { Flow } from '../../src/flow.ts';
import type { Request, Response, WorkerData } from '../../src/protocol.ts';
import { SyncSignal } from '../../src/syncsignal.ts';

const data = workerData as WorkerData;
const flow = new Flow(data.flow);
const signal = new SyncSignal(data.sync);
process.on('exit', () => signal.exiting());

type Reply = (res: Response) => void;

const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const columns = {
  meta: [{ name: 'n', type: 'int', sqlType: 4, size: 10, scale: 0, nullable: false }],
  kinds: ['int' as const],
};

function serve(req: Request, reply: Reply): void {
  const command = req.op === 'query' ? req.args.sql : req.op;
  const [name, arg] = command.split(':');
  const ok = (value: unknown): void => reply({ id: req.id, ok: true, value });
  const fail = (message: string): void =>
    reply({ id: req.id, ok: false, error: { name: 'Error', message } });
  switch (name) {
    case 'partials': {
      const n = Number(arg);
      for (let i = 0; i < n; i++) {
        flow.acquire();
        reply({ id: req.id, partial: { set: 0, columns: i ? undefined : columns, rows: [[i]] } });
      }
      return ok({ results: [{ ...columns, rows: [] }], counts: [], info: [] });
    }
    case 'fail':
      return fail('boom');
    case 'exit':
      return process.exit(3);
    case 'sleep':
      sleep(Number(arg));
      return ok('slept');
    case 'sleepfail':
      sleep(Number(arg));
      return fail('cancelled');
    case 'stale':
      reply({ id: req.id + 1000, ok: true, value: 'stale' });
      return ok('fresh');
    default:
      return ok(req.args ?? null);
  }
}

parentPort!.on('message', (req: Request) => serve(req, (res) => parentPort!.postMessage(res)));
data.port.on('message', (req: Request) =>
  serve(req, (res) => {
    data.port.postMessage(res);
    signal.posted();
  }),
);
