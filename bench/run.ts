// Runs every scenario for both libraries, each in its own process, and prints a table.
// Usage: node --run bench  (from bench/; reads MSSQL_CONNECTION_STRING from ../.env)
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { open } from 'mssql-ffi';
import { COLUMNS, createSql, ROWS, TABLE } from './schema.ts';

// Generate the synthetic table once (kept in tempdb until the server restarts).
{
  await using db = await open(process.env['MSSQL_CONNECTION_STRING']!);
  const { first } = await db
    .query<{ rows: number | null; cols: number | null }>(
      `SELECT (SELECT COUNT(*) FROM ${TABLE}) AS rows, (SELECT COUNT(*) FROM sys.columns WHERE object_id = OBJECT_ID(?)) AS cols`,
      [TABLE],
    )
    .catch(() => ({ first: [{ rows: null, cols: null }] }));
  if (first[0]?.rows !== ROWS || first[0]?.cols !== COLUMNS.length) {
    process.stderr.write(`creating ${TABLE}: ${ROWS} rows x ${COLUMNS.length} columns ... `);
    const t = performance.now();
    await db.query(createSql(ROWS));
    process.stderr.write(`${Math.round(performance.now() - t)} ms
`);
  }
}

const scenarios = (
  process.env['SCENARIOS'] ?? 'query,query-nomax,raw,stream,small,concurrent'
).split(',');
const iterations = process.env['ITERATIONS'] ?? '5';
const libs = ['ffi', 'v8'];

interface Result {
  lib: string;
  scenario: string;
  ms: number[];
  rows: number;
  loopMaxMs: number;
  loopP99Ms: number;
  rssMb: number;
}

const median = (xs: number[]): number => {
  const s = xs.toSorted((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

const results: Result[] = [];
for (const scenario of scenarios) {
  for (const lib of libs) {
    process.stderr.write(`${scenario} / ${lib} ... `);
    const stdout = execFileSync(
      process.execPath,
      ['--no-warnings', 'case.ts', lib, scenario, iterations],
      { encoding: 'utf8', env: process.env, maxBuffer: 1 << 24 },
    );
    const r = JSON.parse(stdout.trim().split('\n').at(-1)!) as Result;
    results.push(r);
    process.stderr.write(`${median(r.ms).toFixed(0)} ms\n`);
  }
}

const rows = results.map((r) => ({
  scenario: r.scenario,
  lib: r.lib === 'ffi' ? 'mssql-ffi' : 'msnodesqlv8',
  'median ms': Math.round(median(r.ms)),
  'min ms': Math.round(Math.min(...r.ms)),
  rows: r.rows,
  'rows/s': r.scenario === 'small' ? '-' : Math.round(r.rows / (median(r.ms) / 1000)),
  'loop max ms': Math.round(r.loopMaxMs),
  'loop p99 ms': Math.round(r.loopP99Ms),
  'peak RSS MB': r.rssMb,
}));
console.table(rows);
writeFileSync('results.json', `${JSON.stringify(results, null, 2)}\n`);
