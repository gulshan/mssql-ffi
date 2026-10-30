import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ConnectionBusyError,
  ConnectionClosedError,
  open,
  openSync,
  SqlError,
} from '../../src/index.ts';
import type { Connection } from '../../src/index.ts';
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
  SELECT CAST(1 AS bit) AS b, CAST(9007199254740993 AS bigint) AS big, CAST(1.5 AS float) AS f,
         CAST(12.3456 AS decimal(10, 4)) AS dec, N'unicode ✓' AS nv,
         REPLICATE(CAST(N'x' AS nvarchar(max)), 5000) AS nmax, CAST(0x0102FF AS varbinary(10)) AS bin,
         CAST('2024-02-29' AS date) AS d, CAST('13:14:15.1234567' AS time(7)) AS t,
         CAST('2024-02-29T13:14:15.5-05:30' AS datetimeoffset(7)) AS dto, CAST(NULL AS int) AS nul;
  UPDATE #t SET id = id + 1 WHERE id > 1;
  SELECT id FROM #t ORDER BY id;
  DROP TABLE #t;`;

/** n = 1..count, enough rows for several partial chunks. */
const NUMBERS = (n: number) =>
  `SELECT TOP ${n} ROW_NUMBER() OVER (ORDER BY (SELECT 1)) AS n
   FROM sys.all_objects a CROSS JOIN sys.all_objects b ORDER BY n`;

describe.skipIf(skip)('Connection sync methods', () => {
  let db: Connection;
  beforeAll(() => {
    db = openSync(connectionString);
  });
  afterAll(() => db?.close());

  it('querySync agrees with query on the same connection', async () => {
    const a = await db.query(MIXED);
    const s = db.querySync(MIXED);
    expect(plain(s)).toEqual(plain(a));
    expect(s.counts).toEqual([3, 2]);
    expect(s.info.some((m) => m.includes('hello from print'))).toBe(true);
  });

  it('queryRawSync agrees with queryRaw', async () => {
    expect(plain(db.queryRawSync(MIXED))).toEqual(plain(await db.queryRaw(MIXED)));
  });

  it('reads results that span many partial chunks', () => {
    const { first } = db.querySync<{ n: number }>(NUMBERS(100_000));
    expect(first).toHaveLength(100_000);
    expect(first.at(-1)!.n).toBe(100_000);
  });

  it('binds parameters', () => {
    expect(db.querySync('SELECT ? AS a, ? AS b', [7, 'x']).first).toEqual([{ a: 7, b: 'x' }]);
  });

  it('throws SqlError with the stack of the call site', () => {
    const e = thrown(() => db.querySync('SELECT * FROM no_such_table')) as SqlError;
    expect(e).toBeInstanceOf(SqlError);
    expect(e.stack).toContain('sync-connection.test.ts');
    // The connection is still usable.
    expect(db.querySync('SELECT 1 AS n').first).toEqual([{ n: 1 }]);
  });

  it('timeoutMs cancels with SQLCancel and keeps the connection usable', () => {
    const t = performance.now();
    const e = thrown(() =>
      db.querySync("WAITFOR DELAY '00:00:05'", [], { timeoutMs: 300 }),
    ) as DOMException;
    expect(performance.now() - t).toBeLessThan(2000);
    expect(e.name).toBe('TimeoutError');
    expect(e.cause).toBeInstanceOf(SqlError);
    expect(db.querySync('SELECT 2 AS n').first).toEqual([{ n: 2 }]);
  });
});

describe.skipIf(skip)('mixing sync and async', () => {
  it('an async-opened connection takes sync calls and the reverse', async () => {
    await using a = await open(connectionString);
    expect(a.querySync('SELECT 1 AS n').first).toEqual([{ n: 1 }]);
    using s = openSync(connectionString);
    expect((await s.query('SELECT 2 AS n')).first).toEqual([{ n: 2 }]);
    expect(s.querySync('SELECT 3 AS n').first).toEqual([{ n: 3 }]);
  });

  it('sync calls see the session state of async ones', async () => {
    using db = openSync(connectionString);
    await db.query('CREATE TABLE #mix (n int); INSERT INTO #mix VALUES (1)');
    db.querySync('INSERT INTO #mix VALUES (2)');
    expect((await db.query('SELECT SUM(n) AS s FROM #mix')).first).toEqual([{ s: 3 }]);
  });
});

describe.skipIf(skip)('busy rule', () => {
  let db: Connection;
  beforeAll(async () => {
    db = await open(connectionString);
  });
  afterAll(() => db?.close());

  it('throws while an async query is in flight', async () => {
    const pending = db.query("WAITFOR DELAY '00:00:00.5'; SELECT 1 AS n");
    // Queued behind the lock: a query cannot run, but closing would be allowed (as with close()).
    expect(() => db.querySync('SELECT 1')).toThrow(ConnectionBusyError);
    await sleep(100);
    // In flight on the worker: neither can block for it.
    expect(() => db.querySync('SELECT 1')).toThrow(ConnectionBusyError);
    expect(() => db.closeSync()).toThrow(ConnectionBusyError);
    expect((await pending).first).toEqual([{ n: 1 }]);
    expect(db.querySync('SELECT 2 AS n').first).toEqual([{ n: 2 }]);
  });

  it('throws while a stream holds the connection', async () => {
    const rows = db.stream(NUMBERS(5000))[Symbol.asyncIterator]();
    await rows.next();
    expect(() => db.querySync('SELECT 1')).toThrow(ConnectionBusyError);
    await rows.return(undefined);
    expect(db.querySync('SELECT 3 AS n').first).toEqual([{ n: 3 }]);
  });

  it('throws on the connection while a transaction is active', async () => {
    const tx = await db.beginTransaction();
    expect(() => db.queryRawSync('SELECT 1')).toThrow(ConnectionBusyError);
    await tx.rollback();
    expect(db.querySync('SELECT 4 AS n').first).toEqual([{ n: 4 }]);
  });
});

describe.skipIf(skip)('sync lifecycle', () => {
  it('using closes the connection', () => {
    let ref: Connection | undefined;
    {
      using db = openSync(connectionString);
      ref = db;
      expect(db.isClosed()).toBe(false);
    }
    expect(ref.isClosed()).toBe(true);
  });

  it('after closeSync, sync and async calls fail with ConnectionClosedError', async () => {
    const db = openSync(connectionString);
    db.closeSync();
    expect(() => db.querySync('SELECT 1')).toThrow(ConnectionClosedError);
    await expect(db.query('SELECT 1')).rejects.toThrow(ConnectionClosedError);
    db.closeSync(); // idempotent
  });

  it('openSync throws the login error', () => {
    expect(() => openSync('Driver={mssql-ffi no such driver}')).toThrow(SqlError);
  });
});
