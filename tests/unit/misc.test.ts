import { describe, expect, it } from 'vitest';
import { deserializeError, serializeError, SqlError } from '../../src/errors.ts';
import { Mutex } from '../../src/mutex.ts';
import { currentPlatform } from '../../src/odbc/platform.ts';

describe('Mutex', () => {
  it('grants the lock in FIFO order', async () => {
    const m = new Mutex();
    const order: number[] = [];
    const run = async (n: number) => {
      const release = await m.acquire();
      order.push(n);
      await Promise.resolve();
      release();
    };
    await Promise.all([run(1), run(2), run(3)]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('an aborted waiter leaves the queue without blocking others', async () => {
    const m = new Mutex();
    const first = await m.acquire();
    const ac = new AbortController();
    const aborted = m.acquire(ac.signal);
    const third = m.acquire();
    ac.abort(new Error('stop'));
    await expect(aborted).rejects.toThrow('stop');
    first();
    const release = await third;
    release();
  });

  it('rejects immediately when already aborted', async () => {
    await expect(new Mutex().acquire(AbortSignal.abort())).rejects.toThrow(/aborted/);
  });

  it('release is idempotent', async () => {
    const m = new Mutex();
    const r = await m.acquire();
    r();
    r();
    const next = await m.acquire();
    expect(next).toBeTypeOf('function');
    next();
  });
});

describe('errors', () => {
  it('SqlError exposes the first diagnostic', () => {
    const e = SqlError.from('SQLExecDirect', [
      {
        sqlstate: '42S02',
        code: 208,
        message: "Invalid object name 'x'.",
        severity: 16,
        lineNumber: 1,
      },
      { sqlstate: '42000', code: 8180, message: 'Statement(s) could not be prepared.' },
    ]);
    expect(e.message).toBe(
      "SQLExecDirect: [42S02] Invalid object name 'x'.\n[42000] Statement(s) could not be prepared.",
    );
    expect([e.sqlstate, e.code, e.severity, e.lineNumber]).toEqual(['42S02', 208, 16, 1]);
    expect(Error.isError(e)).toBe(true);
  });

  it('round-trips through structured clone', () => {
    const e = SqlError.from('x', [{ sqlstate: 'HY008', code: 0, message: 'Operation canceled' }]);
    const back = deserializeError(structuredClone(serializeError(e)));
    expect(back).toBeInstanceOf(SqlError);
    expect((back as SqlError).sqlstate).toBe('HY008');

    const plain = deserializeError(structuredClone(serializeError(new TypeError('bad'))));
    expect([plain.name, plain.message]).toEqual(['TypeError', 'bad']);
    expect(deserializeError(serializeError('str')).message).toBe('str');
  });
});

describe('currentPlatform', () => {
  it('supports 64-bit Windows', () => {
    expect(currentPlatform('win32', 'x64').library).toBe('odbc32.dll');
    expect(currentPlatform('win32', 'arm64').library).toBe('odbc32.dll');
  });

  it('rejects other platforms and 32-bit', () => {
    expect(() => currentPlatform('linux', 'x64')).toThrow(/unsupported platform 'linux'/);
    expect(() => currentPlatform('win32', 'ia32')).toThrow(/unsupported architecture/);
  });
});
