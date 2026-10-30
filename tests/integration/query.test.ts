import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConnectionClosedError, open, query, sql, SqlError } from '../../src/index.ts';
import type { Connection } from '../../src/index.ts';
import { connectionString, skip } from './helpers.ts';

describe.skipIf(skip)('Connection.query', () => {
  let db: Connection;
  beforeAll(async () => {
    db = await open(connectionString);
  });
  afterAll(() => db?.close());

  it('returns rows, meta and multiple result sets', async () => {
    const r = await db.query("SELECT 1 AS a, N'x' AS b; SELECT 2 AS c");
    expect(r.first).toEqual([{ a: 1, b: 'x' }]);
    expect(r.results).toEqual([[{ a: 1, b: 'x' }], [{ c: 2 }]]);
    expect(r.meta[0]!.map((m) => [m.name, m.type])).toEqual([
      ['a', 'int'],
      ['b', 'nvarchar'],
    ]);
  });

  it('reports row counts and PRINT messages', async () => {
    const r = await db.query(`
      CREATE TABLE #t (id int);
      INSERT INTO #t VALUES (1), (2), (3);
      PRINT 'hello from print';
      UPDATE #t SET id = id + 1 WHERE id > 1;
      SELECT COUNT(*) AS n FROM #t;
      DROP TABLE #t;`);
    expect(r.counts).toEqual([3, 2]);
    expect(r.info.some((m) => m.includes('hello from print'))).toBe(true);
    expect(r.first).toEqual([{ n: 3 }]);
  });

  it('queryRaw returns positional rows', async () => {
    const r = await db.queryRaw('SELECT 1 AS a, 2 AS a');
    expect(r.results).toEqual([[[1, 2]]]);
  });

  it('binds parameters', async () => {
    const r = await db.query('SELECT ? AS i, ? AS s, ? AS b, ? AS n', [42, 'héllo', true, null]);
    expect(r.first).toEqual([{ i: 42, s: 'héllo', b: true, n: null }]);
  });

  it('describes untyped NULLs so they convert to binary columns', async () => {
    const r = await db.query(
      `
      DECLARE @t TABLE (v varbinary(max));
      INSERT INTO @t (v) VALUES (?);
      SELECT v FROM @t;`,
      [null],
    );
    expect(r.first).toEqual([{ v: null }]);
  });

  it('throws SqlError with SQL Server details', async () => {
    const err = await db.query('SELECT * FROM dbo.does_not_exist').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SqlError);
    const e = err as SqlError;
    expect(e.sqlstate).toBe('42S02');
    expect(e.code).toBe(208);
    expect(e.severity).toBe(16);
    expect(e.lineNumber).toBe(1);
    expect(e.serverName).toBeTruthy();
    expect(e.stack).toContain('query.test.ts');
  });

  it('surfaces an error raised by a later statement of a batch', async () => {
    await expect(db.query("SELECT 1 AS a; RAISERROR('second failed', 16, 1);")).rejects.toThrow(
      /second failed/,
    );
  });

  it('is usable after an error', async () => {
    await db.query('SELECT 1/0').catch(() => {});
    expect((await db.query('SELECT 1 AS ok')).first).toEqual([{ ok: 1 }]);
  });

  it('serializes concurrent queries on one connection', async () => {
    const all = await Promise.all(
      Array.from({ length: 10 }, (_, i) => db.query('SELECT ? AS i', [i])),
    );
    expect(all.map((r) => r.first[0]!['i'])).toEqual([...Array(10).keys()]);
  });

  it('cancels a running statement on timeout', async () => {
    const started = performance.now();
    const err = await db.query("WAITFOR DELAY '00:00:10'", [], { timeoutMs: 300 }).catch((e) => e);
    expect(performance.now() - started).toBeLessThan(5000);
    expect((err as Error).name).toBe('TimeoutError');
    expect((err as Error).cause).toBeInstanceOf(SqlError);
    expect(((err as Error).cause as SqlError).sqlstate).toBe('HY008');
    expect((await db.query('SELECT 1 AS ok')).first).toEqual([{ ok: 1 }]);
  });

  it('cancels with an AbortSignal', async () => {
    const ac = new AbortController();
    const p = db.query("WAITFOR DELAY '00:00:10'", [], { signal: ac.signal });
    setTimeout(() => ac.abort(new Error('user abort')), 200);
    await expect(p).rejects.toThrow('user abort');
  });

  it('rejects immediately with an already aborted signal', async () => {
    await expect(db.query('SELECT 1', [], { signal: AbortSignal.abort() })).rejects.toThrow(
      /aborted/,
    );
  });
});

describe.skipIf(skip)('connection lifecycle', () => {
  it('top-level query() opens and closes a connection', async () => {
    const r = await query(connectionString, 'SELECT ? AS v', [sql.NVarChar('ok')]);
    expect(r.first).toEqual([{ v: 'ok' }]);
  });

  it('await using closes the connection', async () => {
    let conn: Connection;
    {
      await using c = await open(connectionString);
      conn = c;
      expect(c.isClosed()).toBe(false);
    }
    expect(conn.isClosed()).toBe(true);
    await expect(conn.query('SELECT 1')).rejects.toBeInstanceOf(ConnectionClosedError);
  });

  it('close() rejects queued queries and is idempotent', async () => {
    const conn = await open(connectionString);
    const running = conn.query("WAITFOR DELAY '00:00:00.200'; SELECT 1 AS a");
    const queued = conn.query('SELECT 2 AS b');
    const settled = Promise.allSettled([running, queued]);
    await conn.close();
    await conn.close();
    const results = await settled;
    expect(results.some((s) => s.status === 'rejected')).toBe(true);
  });

  it('a bad connection string fails with SqlError', async () => {
    await expect(
      open('Driver={ODBC Driver 18 for SQL Server};Server=127.0.0.1,1;Encrypt=no', {
        loginTimeoutSecs: 2,
      }),
    ).rejects.toBeInstanceOf(SqlError);
  });
});
