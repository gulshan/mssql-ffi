import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { describe, expect, it } from 'vitest';
import {
  open,
  query,
  queryRawSync,
  querySync,
  sql,
  SqlError,
  TRACE_CHANNEL,
} from '../../src/index.ts';
import type { QueryTraceContext, Row, Value } from '../../src/index.ts';
import { connectionString, skip } from './helpers.ts';

/** The error `fn` throws; fails the test when it returns. */
function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected a throw');
}

/** Temporal values have no own properties, so compare them by type and text. */
function plain(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(plain);
  if (v instanceof Uint8Array) return [...v];
  if (v !== null && typeof v === 'object') {
    const tag = (v as { [Symbol.toStringTag]?: string })[Symbol.toStringTag];
    if (tag?.startsWith('Temporal.')) return `${tag}:${String(v)}`;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  }
  return v;
}

const MIXED = `
  CREATE TABLE #t (id int);
  INSERT INTO #t VALUES (1), (2), (3);
  PRINT 'hello from print';
  SELECT CAST(1 AS bit) AS b, CAST(255 AS tinyint) AS ti, CAST(-5 AS smallint) AS si,
         CAST(2147483647 AS int) AS i, CAST(9007199254740993 AS bigint) AS big,
         CAST(1.5 AS float) AS f, CAST(12.3456 AS decimal(10, 4)) AS dec, CAST(3.5 AS money) AS m,
         N'unicode ✓' AS nv, CAST('ascii' AS varchar(10)) AS v, REPLICATE(CAST(N'x' AS nvarchar(max)), 5000) AS nmax,
         CAST(0x0102FF AS varbinary(10)) AS bin, CAST('6F9619FF-8B86-D011-B42D-00C04FC964FF' AS uniqueidentifier) AS g,
         CAST('2024-02-29' AS date) AS d, CAST('13:14:15.1234567' AS time(7)) AS t,
         CAST('2024-02-29T13:14:15.1234567' AS datetime2(7)) AS dt2, CAST('2024-02-29T13:14:15.123' AS datetime) AS dt,
         CAST('2024-02-29T13:14:15.5-05:30' AS datetimeoffset(7)) AS dto, CAST(NULL AS int) AS nul;
  UPDATE #t SET id = id + 1 WHERE id > 1;
  SELECT id FROM #t ORDER BY id;
  SELECT TOP 0 1 AS empty;
  DROP TABLE #t;`;

describe.skipIf(skip)('querySync / queryRawSync (in-thread)', () => {
  it('agrees with the async query on types, result sets, counts and info', async () => {
    const a = await query(connectionString, MIXED);
    const s = querySync(connectionString, MIXED);
    expect(plain(s)).toEqual(plain(a));
    expect(s.counts).toEqual([3, 2]);
    expect(s.info.some((m) => m.includes('hello from print'))).toBe(true);
    expect(s.results.map((r) => r.length)).toEqual([1, 3, 0]);
  });

  it('queryRawSync agrees with the async queryRaw, decode options included', async () => {
    const opts = { useNumericNumber: true, useBigIntAsNative: true };
    const a = await (async () => {
      await using db = await open(connectionString, opts);
      return await db.queryRaw(MIXED);
    })();
    const s = queryRawSync(connectionString, MIXED, [], opts);
    expect(plain(s)).toEqual(plain(a));
    const first = s.results[0]![0]!;
    expect(first[4]).toBe(9007199254740993n);
    expect(first[6]).toBe(12.3456);
  });

  it('binds parameters, typed ones included', () => {
    const r = querySync<{ a: number; b: string; c: Value }>(
      connectionString,
      'SELECT ? AS a, ? AS b, ? AS c',
      [41, 'text', sql.Decimal('1.25', 10, 2)],
    );
    expect(r.first).toEqual([{ a: 41, b: 'text', c: '1.25' }]);
  });

  it('throws SqlError for a failing statement', () => {
    expect(() => querySync(connectionString, 'SELECT 1/0 AS x')).toThrow(SqlError);
    const e = thrown(() => querySync(connectionString, "RAISERROR('boom %d', 16, 1, 42)"));
    expect(e).toBeInstanceOf(SqlError);
    expect((e as SqlError).message).toContain('boom 42');
    expect((e as SqlError).code).toBe(50000);
  });

  it('closes the connection even when the statement fails', async () => {
    const app = `mssql-ffi-oneshot-${process.pid}`;
    const cs = `${connectionString};APP=${app}`;
    for (let i = 0; i < 3; i++)
      expect(() => querySync(cs, 'SELECT * FROM no_such_table')).toThrow(/no_such_table/);
    querySync(cs, 'SELECT 1');
    const { first } = await query<{ n: number }>(
      connectionString,
      'SELECT COUNT(*) AS n FROM sys.dm_exec_sessions WHERE program_name = ?',
      [app],
    );
    expect(first[0]!.n).toBe(0);
  });

  it('fails on bad parameters before logging in', () => {
    // An unknown driver would fail the login with IM002; the parameter error comes first.
    expect(() =>
      querySync('Driver={mssql-ffi no such driver}', 'SELECT ?', [new Date(Number.NaN)]),
    ).toThrow(RangeError);
    expect(() => querySync('Driver={mssql-ffi no such driver}', 'SELECT 1')).toThrow(SqlError);
  });

  it('timeoutMs raises a TimeoutError with the driver error as cause', () => {
    const t = performance.now();
    const e = thrown(() =>
      querySync(connectionString, "WAITFOR DELAY '00:00:05'", [], { timeoutMs: 1000 }),
    );
    expect(performance.now() - t).toBeLessThan(4000);
    expect(e).toBeInstanceOf(DOMException);
    expect((e as DOMException).name).toBe('TimeoutError');
    expect((e as Error).cause).toBeInstanceOf(SqlError);
    expect(((e as Error).cause as SqlError).sqlstate).toBe('HYT00');
  });

  it('is traced synchronously on the query channel', () => {
    const seen: string[] = [];
    const onStart = (ctx: unknown) => {
      const c = ctx as QueryTraceContext;
      seen.push(`start:${c.operation}:${c.sync}`);
    };
    const onEnd = (ctx: unknown) => seen.push(`end:${(ctx as QueryTraceContext).sql}`);
    subscribe(`tracing:${TRACE_CHANNEL}:start`, onStart);
    subscribe(`tracing:${TRACE_CHANNEL}:end`, onEnd);
    try {
      querySync<Row>(connectionString, 'SELECT 1 AS traced');
    } finally {
      unsubscribe(`tracing:${TRACE_CHANNEL}:start`, onStart);
      unsubscribe(`tracing:${TRACE_CHANNEL}:end`, onEnd);
    }
    expect(seen).toEqual(['start:query:true', 'end:SELECT 1 AS traced']);
  });
});
