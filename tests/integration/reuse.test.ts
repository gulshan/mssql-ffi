import { describe, expect, it } from 'vitest';
import { open, openSync, query, SqlError } from '../../src/index.ts';
import { connectionString, skip } from './helpers.ts';

/** Aborts one statement and times out another on a new connection, then queries it. */
async function cancelled(): Promise<unknown> {
  await using db = await open(connectionString);
  const ac = new AbortController();
  const p = db.query("WAITFOR DELAY '00:00:10'", [], { signal: ac.signal });
  setTimeout(() => ac.abort(new Error('user abort')), 100);
  await expect(p).rejects.toThrow('user abort');
  const t = performance.now();
  const err = await db.query("WAITFOR DELAY '00:00:10'", [], { timeoutMs: 200 }).catch((e) => e);
  expect((err as Error).name).toBe('TimeoutError');
  expect(performance.now() - t).toBeLessThan(5_000);
  return (await db.query('SELECT 1 AS n')).first;
}

// Connections opened one after another run on the same parked worker (see workers.ts).
describe.skipIf(skip)('reused workers', () => {
  it('a new connection on a reused worker starts with fresh session state', async () => {
    {
      await using a = await open(connectionString);
      await a.query('CREATE TABLE #reuse (id int)');
    }
    await using b = await open(connectionString);
    const r = await b.query("SELECT OBJECT_ID('tempdb..#reuse') AS id");
    expect(r.first).toEqual([{ id: null }]);
  });

  it('cancel and timeouts still reach the statement after a cancelled connection', async () => {
    expect(await cancelled()).toEqual([{ n: 1 }]);
    // Runs on the worker the first connection left behind.
    expect(await cancelled()).toEqual([{ n: 1 }]);
  });

  it('a failed login leaves the worker usable for the next connection', async () => {
    // ODBC uses the first occurrence of a repeated keyword.
    const bad = `Database=mssql_ffi_no_such_database;${connectionString}`;
    await expect(open(bad)).rejects.toThrow(SqlError);
    expect((await query(connectionString, 'SELECT 2 AS n')).first).toEqual([{ n: 2 }]);
  });

  it('async and blocking connections share parked workers', async () => {
    {
      using a = openSync(connectionString);
      expect(a.querySync('SELECT 3 AS n').first).toEqual([{ n: 3 }]);
    }
    await using b = await open(connectionString);
    expect(b.querySync('SELECT 4 AS n').first).toEqual([{ n: 4 }]);
    expect((await b.query('SELECT 5 AS n')).first).toEqual([{ n: 5 }]);
  });

  it('back-to-back one-shot queries run in parallel on separate workers', async () => {
    const rows = await Promise.all(
      Array.from({ length: 6 }, (_, i) => query(connectionString, 'SELECT ? AS n', [i])),
    );
    expect(rows.map((r) => r.first[0])).toEqual(Array.from({ length: 6 }, (_, n) => ({ n })));
  });
});
