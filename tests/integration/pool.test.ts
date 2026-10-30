import { describe, expect, it } from 'vitest';
import { Pool, PoolClosedError } from '../../src/index.ts';
import { connectionString, skip } from './helpers.ts';

describe.skipIf(skip)('Pool', () => {
  it('opens the floor and runs queries', async () => {
    await using pool = await Pool.open({ connectionString, floor: 2, ceiling: 3 });
    expect(pool.status).toMatchObject({ size: 2, idle: 2, busy: 0 });
    const r = await pool.query('SELECT ? AS v', [1]);
    expect(r.first).toEqual([{ v: 1 }]);
    expect(pool.status.idle).toBe(2);
  });

  it('never exceeds the ceiling; extra work waits', async () => {
    await using pool = new Pool({ connectionString, ceiling: 2 });
    const spids = await Promise.all(
      Array.from({ length: 6 }, () =>
        pool.query<{ spid: number }>("WAITFOR DELAY '00:00:00.100'; SELECT @@SPID AS spid"),
      ),
    );
    expect(new Set(spids.map((r) => r.first[0]!.spid)).size).toBeLessThanOrEqual(2);
    expect(pool.status.size).toBeLessThanOrEqual(2);
  });

  it('acquire() lends a connection until released', async () => {
    await using pool = new Pool({ connectionString, ceiling: 1 });
    {
      using lease = await pool.acquire();
      expect(pool.status.busy).toBe(1);
      await lease.connection.query('SELECT 1');
    }
    expect(pool.status).toMatchObject({ busy: 0, idle: 1 });
  });

  it('a waiting acquire can be aborted', async () => {
    await using pool = new Pool({ connectionString, ceiling: 1 });
    using held = await pool.acquire();
    const waiting = pool.acquire(AbortSignal.timeout(100));
    await expect(waiting).rejects.toThrow(/timeout/);
    expect(pool.status.waiting).toBe(0);
    held.release();
  });

  it('transactions and streams hold a pooled connection until they end', async () => {
    await using pool = new Pool({ connectionString, ceiling: 2 });
    const v = await pool.transaction(async (tx) => {
      expect(pool.status.busy).toBe(1);
      return (await tx.query('SELECT 5 AS v')).first[0]!['v'];
    });
    expect(v).toBe(5);
    expect(pool.status.busy).toBe(0);
    expect(await pool.stream('SELECT 1 AS a UNION ALL SELECT 2').toArray()).toHaveLength(2);
    expect(pool.status.busy).toBe(0);
  });

  it('callProc caches metadata per pool', async () => {
    await using pool = new Pool({ connectionString });
    const r = await pool.callProc('sp_server_info', { attribute_id: 1 });
    expect(r.first.length).toBe(1);
    expect(r.returns).toBe(0);
  });

  it('closes idle connections after the inactivity timeout, keeping the floor', async () => {
    await using pool = await Pool.open({
      connectionString,
      floor: 1,
      ceiling: 3,
      inactivityTimeoutSecs: 0.2,
    });
    await Promise.all([pool.query('SELECT 1'), pool.query('SELECT 2'), pool.query('SELECT 3')]);
    expect(pool.status.size).toBeGreaterThan(1);
    await new Promise((r) => setTimeout(r, 600));
    expect(pool.status.size).toBe(1);
  });

  it('rejects use after close', async () => {
    const pool = new Pool({ connectionString });
    await pool.query('SELECT 1');
    await pool.close();
    await expect(pool.query('SELECT 1')).rejects.toBeInstanceOf(PoolClosedError);
  });
});
