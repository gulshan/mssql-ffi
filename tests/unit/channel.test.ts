import { afterEach, describe, expect, it } from 'vitest';
import { Channel, ConnectionBusyError, ConnectionClosedError } from '../../src/channel.ts';
import type { Partial } from '../../src/protocol.ts';

const FAKE = new URL('../support/fake-worker.ts', import.meta.url);

/** The error `fn` throws; fails the test when it returns. */
function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected a throw');
}

const query = (sql: string) => ({ sql, params: [] });

const failDecode = (): never => {
  throw new Error('decode failed');
};

describe('Channel.callSync', () => {
  let channel: Channel;
  afterEach(async () => {
    await channel?.close().catch(() => {});
  });

  it('returns the reply, even before the worker has started', () => {
    channel = new Channel(FAKE);
    expect(channel.callSync('query', query('echo'))).toEqual(query('echo'));
  });

  it('hands over partials in order and releases flow control for each', () => {
    channel = new Channel(FAKE);
    const seen: number[] = [];
    // More chunks than the flow-control window: a missing release would deadlock here.
    const onPartial = (p: Partial) => seen.push(p.rows[0]![0] as number);
    channel.callSync('query', query('partials:20'), { onPartial });
    expect(seen).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it('throws worker errors with the stack of the call site', () => {
    channel = new Channel(FAKE);
    const e = thrown(() => channel.callSync('query', query('fail'))) as Error;
    expect(e.message).toBe('boom');
    expect(e.stack).toContain('channel.test.ts');
  });

  it('a failing partial handler throws after the request completes', () => {
    channel = new Channel(FAKE);
    expect(() =>
      channel.callSync('query', query('partials:10'), { onPartial: failDecode }),
    ).toThrow('decode failed');
    // Nothing of the failed request is left on the port.
    expect(channel.callSync('query', query('echo'))).toEqual(query('echo'));
  });

  it('ignores replies to other requests', () => {
    channel = new Channel(FAKE);
    expect(channel.callSync('query', query('stale'))).toBe('fresh');
  });

  it('notices a worker that exits while it waits', () => {
    channel = new Channel(FAKE);
    expect(() => channel.callSync('query', query('exit'))).toThrow(ConnectionClosedError);
    expect(channel.closed).toBe(true);
    expect(() => channel.callSync('query', query('echo'))).toThrow(ConnectionClosedError);
  });

  it('turns an error after the deadline into a TimeoutError', () => {
    channel = new Channel(FAKE);
    const t = performance.now();
    const e = thrown(() =>
      channel.callSync('query', query('sleepfail:300'), { timeoutMs: 50 }),
    ) as DOMException;
    expect(performance.now() - t).toBeGreaterThanOrEqual(250);
    expect(e.name).toBe('TimeoutError');
    expect((e.cause as Error).message).toBe('cancelled');
  });

  it('returns a reply that succeeds despite the deadline', () => {
    channel = new Channel(FAKE);
    expect(channel.callSync('query', query('sleep:100'), { timeoutMs: 10 })).toBe('slept');
  });

  it('mixes with async calls on the same worker', async () => {
    channel = new Channel(FAKE);
    expect(await channel.call('query', query('echo'))).toEqual(query('echo'));
    expect(channel.callSync('query', query('stale'))).toBe('fresh');
    const seen: unknown[] = [];
    await channel.call('query', query('partials:8'), undefined, (p) => seen.push(p.rows[0]![0]));
    expect(seen).toHaveLength(8);
  });

  it('refuses to block while an async request is in flight', async () => {
    channel = new Channel(FAKE);
    const pending = channel.call('query', query('sleep:100'));
    expect(() => channel.callSync('query', query('echo'))).toThrow(ConnectionBusyError);
    expect(() => channel.closeSync()).toThrow(ConnectionBusyError);
    expect(channel.closed).toBe(false);
    expect(await pending).toBe('slept');
    expect(channel.callSync('query', query('echo'))).toEqual(query('echo'));
  });

  it('closeSync closes the channel for both kinds of calls', async () => {
    channel = new Channel(FAKE);
    channel.closeSync();
    expect(channel.closed).toBe(true);
    expect(() => channel.callSync('query', query('echo'))).toThrow(ConnectionClosedError);
    await expect(channel.call('query', query('echo'))).rejects.toThrow(ConnectionClosedError);
  });
});
