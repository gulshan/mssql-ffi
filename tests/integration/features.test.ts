import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { open, sql, SqlError, TRACE_CHANNEL } from '../../src/index.ts';
import type { Connection, QueryTraceContext } from '../../src/index.ts';
import { connectionString, skip } from './helpers.ts';

/** n = 1..count, in order. */
const NUMBERS = (n: number) =>
  `SELECT TOP ${n} ROW_NUMBER() OVER (ORDER BY (SELECT 1)) AS n
   FROM sys.all_objects a CROSS JOIN sys.all_objects b ORDER BY n`;

describe.skipIf(skip)('stream', () => {
  let db: Connection;
  beforeAll(async () => {
    db = await open(connectionString);
  });
  afterAll(() => db?.close());

  it('yields rows of every result set in batches', async () => {
    const stream = db.stream<{ n: number }>(
      `SELECT TOP 1000 ROW_NUMBER() OVER (ORDER BY (SELECT 1)) AS n FROM sys.all_objects a, sys.all_objects b;
       SELECT -1 AS n;`,
      [],
      { batchSize: 64 },
    );
    const seen: [number, number][] = [];
    for await (const row of stream) seen.push([stream.resultSet, row.n]);
    expect(seen).toHaveLength(1001);
    expect(seen[999]).toEqual([0, 1000]);
    expect(seen[1000]).toEqual([1, -1]);
    expect(stream.meta?.[0]?.name).toBe('n');
  });

  it('collects counts and info as they are reached', async () => {
    const stream = db.stream(`
      DECLARE @t TABLE (i int); INSERT INTO @t VALUES (1), (2);
      PRINT 'streamed';
      SELECT i FROM @t;`);
    expect(await stream.toArray()).toEqual([{ i: 1 }, { i: 2 }]);
    expect(stream.counts).toEqual([2]);
    expect(stream.info.join()).toContain('streamed');
  });

  it('breaking out closes the cursor and frees the connection', async () => {
    for await (const row of db.stream('SELECT name FROM sys.all_objects')) {
      expect(row).toHaveProperty('name');
      break;
    }
    expect((await db.query('SELECT 1 AS ok')).first).toEqual([{ ok: 1 }]);
  });

  it('holds the connection while iterating; other queries wait', async () => {
    const order: string[] = [];
    const stream = db.stream('SELECT 1 AS a UNION ALL SELECT 2');
    const iter = stream[Symbol.asyncIterator]();
    await iter.next();
    const other = db.query('SELECT 3 AS c').then(() => order.push('query'));
    await new Promise((r) => setTimeout(r, 50));
    order.push('stream');
    await iter.return(undefined);
    await other;
    expect(order).toEqual(['stream', 'query']);
  });

  it('a statement with no result sets yields nothing', async () => {
    expect(await db.stream('DECLARE @x int = 1').toArray()).toEqual([]);
  });

  it('propagates errors', async () => {
    await expect(db.stream('SELECT * FROM dbo.nope').toArray()).rejects.toBeInstanceOf(SqlError);
    expect((await db.query('SELECT 1 AS ok')).first).toEqual([{ ok: 1 }]);
  });

  it('an error in a prefetched batch surfaces in order, after the rows before it', async () => {
    const seen: number[] = [];
    const err = await (async () => {
      // Row 250 divides by zero: the failing batch is the prefetched one.
      for await (const row of db.stream<{ n: number }>(
        `SELECT n, 1 / (250 - n) AS x FROM (${NUMBERS(1000)}) q ORDER BY n`,
        [],
        { batchSize: 100 },
      )) {
        seen.push(row.n);
      }
    })().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SqlError);
    expect(seen.length).toBeGreaterThanOrEqual(100);
    expect(seen.every((n, i) => n === i + 1)).toBe(true);
    expect((await db.query('SELECT 1 AS ok')).first).toEqual([{ ok: 1 }]);
  });

  it('breaking out with a prefetch in flight leaves the connection usable', async () => {
    for (let round = 0; round < 3; round++) {
      let count = 0;
      // oxlint-disable-next-line no-await-in-loop -- rounds run one after another on purpose
      for await (const _ of db.stream(NUMBERS(5000), [], { batchSize: 50 })) {
        if (++count === 75) break;
      }
      expect(count).toBe(75);
    }
    expect((await db.query('SELECT 1 AS ok')).first).toEqual([{ ok: 1 }]);
  });

  it('aborting mid-iteration rejects and frees the connection', async () => {
    const ac = new AbortController();
    let count = 0;
    const run = (async () => {
      for await (const _ of db.stream(NUMBERS(20000), [], { batchSize: 100, signal: ac.signal })) {
        if (++count === 150) ac.abort(new Error('stop streaming'));
      }
    })();
    await expect(run).rejects.toThrow('stop streaming');
    expect((await db.query('SELECT 1 AS ok')).first).toEqual([{ ok: 1 }]);
  });

  it('result sets spanning several prefetched batches stay apart', async () => {
    const stream = db.stream<{ n: number }>(
      `${NUMBERS(250)}; SELECT -1 AS n; ${NUMBERS(130)}`,
      [],
      {
        batchSize: 60,
      },
    );
    const sets: number[] = [];
    for await (const _ of stream) sets[stream.resultSet] = (sets[stream.resultSet] ?? 0) + 1;
    expect(sets).toEqual([250, 1, 130]);
  });

  it('can only be iterated once', async () => {
    const s = db.stream('SELECT 1 AS a');
    await s.toArray();
    expect(() => s[Symbol.asyncIterator]()).toThrow(/once/);
  });
});

describe.skipIf(skip)('prepared statements', () => {
  it('executes repeatedly with different parameters', async () => {
    await using db = await open(connectionString);
    await using ps = await db.prepare('SELECT ? * 2 AS v, ? AS s');
    for (const i of [1, 2, 3]) {
      // oxlint-disable-next-line no-await-in-loop -- sequential re-execution is the point
      const r = await ps.query([i, `x${i}`]);
      expect(r.first).toEqual([{ v: i * 2, s: `x${i}` }]);
    }
  });

  it('rejects queries after free', async () => {
    await using db = await open(connectionString);
    const ps = await db.prepare('SELECT 1 AS a');
    await ps.free();
    expect(ps.freed).toBe(true);
    await expect(ps.query()).rejects.toThrow(/freed/);
  });
});

describe.skipIf(skip)('transactions', () => {
  let db: Connection;
  beforeAll(async () => {
    db = await open(connectionString);
    await db.query('CREATE TABLE ##mssql_ffi_tx (id int)');
  });
  afterAll(async () => {
    await db?.query('DROP TABLE IF EXISTS ##mssql_ffi_tx');
    await db?.close();
  });

  const count = async () =>
    (await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM ##mssql_ffi_tx')).first[0]!.n;

  it('commits when the callback resolves', async () => {
    const before = await count();
    const r = await db.transaction(async (tx) => {
      await tx.query('INSERT INTO ##mssql_ffi_tx VALUES (?)', [1]);
      return 'done';
    });
    expect(r).toBe('done');
    expect(await count()).toBe(before + 1);
  });

  it('rolls back when the callback throws', async () => {
    const before = await count();
    await expect(
      db.transaction(async (tx) => {
        await tx.query('INSERT INTO ##mssql_ffi_tx VALUES (?)', [2]);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await count()).toBe(before);
  });

  it('manual begin/commit with isolation level; the connection waits meanwhile', async () => {
    const tx = await db.beginTransaction({ isolationLevel: 'SERIALIZABLE' });
    const level = await tx.query<{ l: number }>(
      'SELECT transaction_isolation_level AS l FROM sys.dm_exec_sessions WHERE session_id = @@SPID',
    );
    expect(level.first[0]!.l).toBe(4); // SERIALIZABLE
    let outsideDone = false;
    const outside = db.query('SELECT 1 AS a').then(() => (outsideDone = true));
    await tx.query('INSERT INTO ##mssql_ffi_tx VALUES (3)');
    expect(outsideDone).toBe(false);
    await tx.commit();
    await outside;
    expect(outsideDone).toBe(true);
    const after = await db.query<{ l: number }>(
      'SELECT transaction_isolation_level AS l FROM sys.dm_exec_sessions WHERE session_id = @@SPID',
    );
    expect(after.first[0]!.l).toBe(2); // back to READ COMMITTED
    await expect(tx.query('SELECT 1')).rejects.toThrow(/already committed/);
  });

  it('await using rolls back an unfinished transaction', async () => {
    const before = await count();
    {
      await using tx = await db.beginTransaction();
      await tx.query('INSERT INTO ##mssql_ffi_tx VALUES (4)');
    }
    expect(await count()).toBe(before);
  });

  it('prepared statements inside a transaction are freed with it', async () => {
    let ps: Awaited<ReturnType<Connection['prepare']>> | undefined;
    await db.transaction(async (tx) => {
      ps = await tx.prepare('INSERT INTO ##mssql_ffi_tx VALUES (?)');
      await ps.query([5]);
      await ps.query([6]);
    });
    expect(ps?.freed).toBe(true);
  });
});

describe.skipIf(skip)('callProc', () => {
  let db: Connection;
  beforeAll(async () => {
    db = await open(connectionString);
    await db.query('USE tempdb');
    await db.query(`
      CREATE OR ALTER PROCEDURE dbo.mssql_ffi_proc
        @a int, @name nvarchar(20) = N'default', @total decimal(18,2) OUTPUT, @echo nvarchar(20) = NULL OUTPUT
      AS BEGIN
        SET NOCOUNT ON;
        SELECT @a AS a, @name AS name;
        SET @total = @a * 1.5 + ISNULL(@total, 0);
        SET @echo = UPPER(@name);
        RETURN 7;
      END`);
  });
  afterAll(async () => {
    await db?.query('DROP PROCEDURE IF EXISTS dbo.mssql_ffi_proc');
    await db?.close();
  });

  it('returns result sets, output parameters and the return code', async () => {
    const r = await db.callProc('dbo.mssql_ffi_proc', { a: 3, name: 'bob' });
    expect(r.first).toEqual([{ a: 3, name: 'bob' }]);
    expect(r.output).toEqual({ total: '4.50', echo: 'BOB' });
    expect(r.returns).toBe(7);
  });

  it('positional arguments, defaults and input/output values', async () => {
    const r = await db.callProc('mssql_ffi_proc', [2, undefined, '10']);
    expect(r.first).toEqual([{ a: 2, name: null }]);
    expect(r.output['total']).toBe('13.00');

    const d = await db.callProc('mssql_ffi_proc', { a: 1 });
    expect(d.first).toEqual([{ a: 1, name: 'default' }]);
  });

  it('fails for unknown procedures and parameters', async () => {
    await expect(db.callProc('dbo.nope')).rejects.toThrow(/not found/);
    await expect(db.callProc('dbo.mssql_ffi_proc', { zzz: 1 })).rejects.toThrow(/no parameter/);
  });

  it('accepts typed parameters', async () => {
    const r = await db.callProc('dbo.mssql_ffi_proc', {
      a: sql.Int(4),
      name: sql.NVarChar('x', 20),
    });
    expect(r.output['echo']).toBe('X');
  });
});

describe.skipIf(skip)('tracing', () => {
  it('publishes start/end events on the tracing channel', async () => {
    await using db = await open(connectionString);
    const seen: string[] = [];
    const onStart = (ctx: unknown) => seen.push(`start:${(ctx as QueryTraceContext).operation}`);
    const onEnd = (ctx: unknown) => seen.push(`end:${(ctx as QueryTraceContext).sql}`);
    subscribe(`tracing:${TRACE_CHANNEL}:start`, onStart);
    subscribe(`tracing:${TRACE_CHANNEL}:asyncEnd`, onEnd);
    try {
      await db.query('SELECT 1 AS traced');
    } finally {
      unsubscribe(`tracing:${TRACE_CHANNEL}:start`, onStart);
      unsubscribe(`tracing:${TRACE_CHANNEL}:asyncEnd`, onEnd);
    }
    expect(seen).toEqual(['start:query', 'end:SELECT 1 AS traced']);
  });
});
