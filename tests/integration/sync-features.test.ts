import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConnectionBusyError, openSync } from '../../src/index.ts';
import type { Connection, PreparedStatement, Transaction } from '../../src/index.ts';
import { connectionString, skip } from './helpers.ts';

describe.skipIf(skip)('prepareSync', () => {
  let db: Connection;
  beforeAll(() => {
    db = openSync(connectionString);
  });
  afterAll(() => db?.closeSync());

  it('runs a prepared statement repeatedly', () => {
    using ps = db.prepareSync('SELECT ? * 2 AS n');
    expect([1, 2, 3].map((n) => ps.querySync<{ n: number }>([n]).first[0]!.n)).toEqual([2, 4, 6]);
  });

  it('async-prepared statements run sync and the reverse', async () => {
    const a = await db.prepare('SELECT ? + 1 AS n');
    expect(a.querySync([1]).first).toEqual([{ n: 2 }]);
    a.freeSync();
    expect(a.freed).toBe(true);
    const s = db.prepareSync('SELECT ? + 2 AS n');
    expect((await s.query([1])).first).toEqual([{ n: 3 }]);
    await s.free();
  });

  it('using frees it; a freed statement throws', () => {
    let ref: PreparedStatement | undefined;
    {
      using ps = db.prepareSync('SELECT 1 AS n');
      ref = ps;
    }
    expect(ref.freed).toBe(true);
    expect(() => ref.querySync()).toThrow('freed');
  });

  it('freeSync while the connection is busy throws and keeps the statement', async () => {
    const ps = db.prepareSync('SELECT 1 AS n');
    const pending = db.query("WAITFOR DELAY '00:00:00.2'");
    expect(() => ps.freeSync()).toThrow(ConnectionBusyError);
    expect(ps.freed).toBe(false);
    await pending;
    ps.freeSync();
    expect(ps.freed).toBe(true);
  });
});

describe.skipIf(skip)('callProcSync', () => {
  let db: Connection;
  beforeAll(() => {
    db = openSync(connectionString);
    db.querySync('USE tempdb');
    db.querySync(`
      CREATE OR ALTER PROCEDURE dbo.mssql_ffi_sync_proc
        @a int, @total decimal(18,2) OUTPUT
      AS BEGIN
        SET NOCOUNT ON;
        SELECT @a AS a;
        SET @total = @a * 1.5 + ISNULL(@total, 0);
        RETURN 7;
      END`);
  });
  afterAll(() => {
    db?.querySync('DROP PROCEDURE IF EXISTS dbo.mssql_ffi_sync_proc');
    db?.closeSync();
  });

  it('returns result sets, output parameters and the return code', () => {
    const r = db.callProcSync('dbo.mssql_ffi_sync_proc', { a: 4, total: '1' });
    expect(r.first).toEqual([{ a: 4 }]);
    expect(r.output).toEqual({ total: '7.00' });
    expect(r.returns).toBe(7);
  });

  it('agrees with callProc, sharing its metadata cache', async () => {
    const a = await db.callProc('mssql_ffi_sync_proc', [2]);
    const s = db.callProcSync('mssql_ffi_sync_proc', [2]);
    expect(s).toEqual(a);
  });

  it('a missing procedure throws and is not cached', () => {
    expect(() => db.callProcSync('dbo.no_such_proc_sync')).toThrow('not found');
    expect(() => db.callProcSync('dbo.no_such_proc_sync')).toThrow('not found');
  });
});

describe.skipIf(skip)('sync transactions', () => {
  let db: Connection;
  const total = () => db.querySync<{ n: number }>('SELECT COUNT(*) AS n FROM #tx').first[0]!.n;

  beforeAll(() => {
    db = openSync(connectionString);
    db.querySync('CREATE TABLE #tx (n int)');
  });
  beforeEach(() => {
    db.querySync('DELETE FROM #tx');
  });
  afterAll(() => db?.closeSync());

  it('commitSync keeps the work, rollbackSync discards it', () => {
    const tx = db.beginTransactionSync();
    tx.querySync('INSERT INTO #tx VALUES (1)');
    tx.commitSync();
    expect(tx.active).toBe(false);
    const tx2 = db.beginTransactionSync();
    tx2.querySync('INSERT INTO #tx VALUES (2)');
    tx2.rollbackSync();
    expect(total()).toBe(1);
  });

  it('using rolls back a transaction left open', () => {
    {
      using tx = db.beginTransactionSync();
      tx.querySync('INSERT INTO #tx VALUES (1)');
    }
    expect(total()).toBe(0);
  });

  it('transactionSync commits on return and rolls back on throw', () => {
    expect(db.transactionSync((tx) => tx.querySync('INSERT INTO #tx VALUES (1)').counts)).toEqual([
      1,
    ]);
    expect(() =>
      db.transactionSync((tx) => {
        tx.querySync('INSERT INTO #tx VALUES (2)');
        throw new Error('nope');
      }),
    ).toThrow('nope');
    expect(total()).toBe(1);
  });

  it('transactionSync rejects an async callback and rolls back', () => {
    expect(() =>
      db.transactionSync(async (tx) => {
        tx.querySync('INSERT INTO #tx VALUES (1)');
      }),
    ).toThrow(TypeError);
    expect(total()).toBe(0);
  });

  it('a transaction begun one way ends the other way', async () => {
    const a = await db.beginTransaction();
    a.querySync('INSERT INTO #tx VALUES (1)');
    a.commitSync();
    const s = db.beginTransactionSync();
    await s.query('INSERT INTO #tx VALUES (2)');
    await s.commit();
    expect(total()).toBe(2);
  });

  it('applies the isolation level', () => {
    const level = db.transactionSync(
      (tx) =>
        tx.querySync<{ l: number }>(
          'SELECT transaction_isolation_level AS l FROM sys.dm_exec_sessions WHERE session_id = @@SPID',
        ).first[0]!.l,
      { isolationLevel: 'SERIALIZABLE' },
    );
    expect(level).toBe(4);
  });

  it('prepared statements of a transaction are freed when it ends', () => {
    let ps: PreparedStatement | undefined;
    db.transactionSync((tx) => {
      ps = tx.prepareSync('INSERT INTO #tx VALUES (?)');
      ps.querySync([1]);
      ps.querySync([2]);
    });
    expect(ps!.freed).toBe(true);
    expect(total()).toBe(2);
  });

  it('the connection is busy for blocking calls while a transaction is active', () => {
    const tx: Transaction = db.beginTransactionSync();
    expect(() => db.querySync('SELECT 1')).toThrow(ConnectionBusyError);
    expect(() => db.beginTransactionSync()).toThrow(ConnectionBusyError);
    tx.rollbackSync();
    expect(db.querySync('SELECT 1 AS n').first).toEqual([{ n: 1 }]);
  });

  it('a transaction busy with an async query refuses blocking calls', async () => {
    const tx = db.beginTransactionSync();
    const pending = tx.query("WAITFOR DELAY '00:00:00.3'");
    expect(() => tx.querySync('SELECT 1')).toThrow(ConnectionBusyError);
    await sleep(100);
    expect(() => tx.commitSync()).toThrow(ConnectionBusyError);
    expect(tx.active).toBe(true);
    await pending;
    tx.commitSync();
  });
});
