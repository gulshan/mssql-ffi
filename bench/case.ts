// One benchmark case in a fresh process: node case.ts <lib> <scenario> <iterations>
// Prints one JSON line with per-iteration timings, rows, event-loop delay and peak RSS.
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { open as ffiOpen } from 'mssql-ffi';
import sqlv8 from 'msnodesqlv8';
import { SELECT_ALL, SELECT_NO_MAX } from './schema.ts';

const SMALL = SELECT_ALL.replace('SELECT *', 'SELECT TOP 1 *');
const MEDIUM = SELECT_ALL.replace('SELECT *', 'SELECT TOP 10000 *');

const [lib = '', scenario = '', iterArg = '5'] = process.argv.slice(2);
const iterations = Number(iterArg);
const cs = process.env['MSSQL_CONNECTION_STRING']!;

interface Client {
  /** Full result as row objects; returns the row count. */
  query(sql: string): Promise<number>;
  /** Positional rows; returns the row count. */
  raw(sql: string): Promise<number>;
  /** Row-by-row consumption; returns the row count. */
  stream(sql: string): Promise<number>;
  close(): Promise<void>;
}

async function ffiClient(): Promise<Client> {
  const db = await ffiOpen(cs);
  return {
    query: async (sql) => (await db.query(sql)).first.length,
    raw: async (sql) => (await db.queryRaw(sql)).results[0]!.length,
    stream: async (sql) => {
      let n = 0;
      for await (const _ of db.stream(sql, [], { batchSize: 512 })) n++;
      return n;
    },
    close: () => db.close(),
  };
}

async function v8Client(): Promise<Client> {
  const conn = await sqlv8.promises.open(cs);
  return {
    query: async (sql) => (await conn.promises.query(sql)).first.length,
    raw: (sql) =>
      new Promise((resolve, reject) => {
        let rows = 0;
        conn.queryRaw(sql, (err, res, more) => {
          if (err) return reject(err);
          rows += res?.rows.length ?? 0;
          if (!more) resolve(rows);
        });
      }),
    stream: (sql) =>
      new Promise((resolve, reject) => {
        // Event API: one 'column' event per value, 'row' per row.
        let rows = 0;
        const q = conn.query(sql);
        q.on('row', () => rows++);
        q.on('error', reject);
        q.on('done', () => resolve(rows));
      }),
    close: () => conn.promises.close(),
  };
}

const connect = lib === 'ffi' ? ffiClient : v8Client;

interface Result {
  lib: string;
  scenario: string;
  ms: number[];
  rows: number;
  loopMaxMs: number;
  loopP99Ms: number;
  rssMb: number;
}

let peakRss = 0;
const sampler = setInterval(() => (peakRss = Math.max(peakRss, process.memoryUsage.rss())), 20);

async function timed(fn: () => Promise<number>): Promise<{ ms: number[]; rows: number }> {
  await fn(); // warm-up: JIT, worker start-up and caches are not part of the measurement
  loop.enable();
  const ms: number[] = [];
  let rows = 0;
  for (let i = 0; i < iterations; i++) {
    const t = performance.now();
    rows = await fn();
    ms.push(performance.now() - t);
  }
  return { ms, rows };
}

const loop = monitorEventLoopDelay({ resolution: 10 });
let out: { ms: number[]; rows: number };

if (scenario === 'concurrent') {
  // 4 connections, 8 medium queries in flight at once.
  const clients = await Promise.all(Array.from({ length: 4 }, connect));
  out = await timed(async () => {
    const counts = await Promise.all(
      Array.from({ length: 8 }, (_, i) => clients[i % 4]!.query(MEDIUM)),
    );
    return counts.reduce((a, b) => a + b, 0);
  });
  loop.disable();
  await Promise.all(clients.map((c) => c.close()));
} else {
  const client = await connect();
  if (scenario === 'small') {
    // Per-call overhead: 200 sequential single-row queries per iteration.
    out = await timed(async () => {
      for (let i = 0; i < 200; i++) await client.query(SMALL);
      return 200;
    });
  } else {
    const fn =
      scenario === 'raw' ? client.raw : scenario === 'stream' ? client.stream : client.query;
    const sql = scenario === 'query-nomax' ? SELECT_NO_MAX : SELECT_ALL;
    out = await timed(() => fn(sql));
  }
  loop.disable();
  await client.close();
}
clearInterval(sampler);

const result: Result = {
  lib,
  scenario,
  ...out,
  loopMaxMs: loop.max / 1e6,
  loopP99Ms: loop.percentile(99) / 1e6,
  rssMb: Math.round(peakRss / 2 ** 20),
};
console.log(JSON.stringify(result));
