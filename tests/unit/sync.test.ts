import { describe, expect, it } from 'vitest';
import { Collector } from '../../src/collect.ts';
import type { DecodeOptions } from '../../src/decode.ts';
import { Mutex } from '../../src/mutex.ts';
import { timeoutSecs } from '../../src/oneshot.ts';
import type { ColumnMeta, Kind, WireQueryResult, WireValue } from '../../src/types.ts';

const defaults: DecodeOptions = { useNumericNumber: false, useBigIntAsNative: false };

function columns(kinds: Kind[], names: string[]): { meta: ColumnMeta[]; kinds: Kind[] } {
  const meta = names.map((name): ColumnMeta => ({
    name,
    type: '',
    sqlType: 0,
    size: 0,
    scale: 0,
    nullable: true,
  }));
  return { meta, kinds };
}

describe('Mutex.tryAcquire', () => {
  it('takes a free lock and refuses a held one', () => {
    const m = new Mutex();
    const release = m.tryAcquire();
    expect(release).toBeTypeOf('function');
    expect(m.tryAcquire()).toBeUndefined();
    release!();
    const again = m.tryAcquire();
    expect(again).toBeTypeOf('function');
    again!();
  });

  it('async waiters queue behind a sync holder', async () => {
    const m = new Mutex();
    const release = m.tryAcquire()!;
    let granted = false;
    const waiter = m.acquire().then((r) => {
      granted = true;
      return r;
    });
    await Promise.resolve();
    expect(granted).toBe(false);
    release();
    (await waiter)();
    expect(granted).toBe(true);
  });

  it('counts a lock handed to a waiter that has not resumed yet as taken', async () => {
    const m = new Mutex();
    const first = await m.acquire();
    const second = m.acquire();
    first();
    // `second` has not run its continuation yet, but the lock is already promised to it.
    expect(m.tryAcquire()).toBeUndefined();
    (await second)();
    expect(m.tryAcquire()).toBeTypeOf('function');
  });

  it('an aborted waiter frees its place once its turn comes', async () => {
    const m = new Mutex();
    const first = await m.acquire();
    const ac = new AbortController();
    const aborted = m.acquire(ac.signal);
    ac.abort(new Error('stop'));
    await expect(aborted).rejects.toThrow('stop');
    expect(m.tryAcquire()).toBeUndefined();
    first();
    await Promise.resolve();
    await Promise.resolve();
    expect(m.tryAcquire()).toBeTypeOf('function');
  });
});

describe('Collector', () => {
  const cols = columns(['int', 'date'], ['n', 'd']);
  const rows: WireValue[][] = [
    [1, [2024, 2, 29]],
    [2, null],
  ];

  it('decodes rows carried by the final result', () => {
    const wire: WireQueryResult = {
      results: [{ ...cols, rows }],
      counts: [5],
      info: ['hi'],
    };
    const c = Collector.rows(defaults).finish(wire);
    expect(c.results[0]!.map((r) => [r['n'], String(r['d'])])).toEqual([
      [1, '2024-02-29'],
      [2, 'null'],
    ]);
    expect(c.meta).toEqual([cols.meta]);
    expect(c.counts).toEqual([5]);
    expect(c.info).toEqual(['hi']);
  });

  it('gives the same result for chunks and for a final result', () => {
    const chunked = Collector.raw(defaults);
    chunked.onPartial({ set: 0, columns: cols, rows: rows.slice(0, 1) });
    chunked.onPartial({ set: 0, rows: rows.slice(1) });
    const a = chunked.finish({ results: [{ ...cols, rows: [] }], counts: [], info: [] });
    const b = Collector.raw(defaults).finish({
      results: [{ ...cols, rows }],
      counts: [],
      info: [],
    });
    expect(a.results.map((s) => s.map((r) => r.map(String)))).toEqual(
      b.results.map((s) => s.map((r) => r.map(String))),
    );
  });

  it('keeps empty result sets', () => {
    const c = Collector.rows(defaults).finish({
      results: [
        { ...cols, rows: [] },
        { ...cols, rows },
      ],
      counts: [],
      info: [],
    });
    expect(c.results.map((s) => s.length)).toEqual([0, 2]);
  });
});

describe('timeoutSecs', () => {
  it('rounds up to whole seconds, at least 1', () => {
    expect(timeoutSecs(undefined)).toBeUndefined();
    expect(timeoutSecs(0)).toBe(1);
    expect(timeoutSecs(1)).toBe(1);
    expect(timeoutSecs(1000)).toBe(1);
    expect(timeoutSecs(1001)).toBe(2);
  });
});
