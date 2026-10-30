import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Channel, ConnectionClosedError } from '../../src/channel.ts';
import { IDLE_MS, MAX_IDLE } from '../../src/workers.ts';

const FAKE = new URL('../support/fake-worker.ts', import.meta.url);

const query = (sql: string) => ({ sql, params: [] });

interface ThreadInfo {
  threadId: number;
  id: number;
}

const info = (c: Channel): Promise<ThreadInfo> =>
  c.call('query', query('thread')) as Promise<unknown> as Promise<ThreadInfo>;

const infoSync = (c: Channel): ThreadInfo =>
  c.callSync('query', query('thread')) as unknown as ThreadInfo;

describe('worker reuse', () => {
  const open: Channel[] = [];
  const channel = (): Channel => {
    const c = new Channel(FAKE);
    open.push(c);
    return c;
  };
  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(open.splice(0).map((c) => c.close().catch(() => {})));
  });

  it('the next connection takes the worker of a closed one', async () => {
    const a = channel();
    const first = await info(a);
    await a.close();
    const b = channel();
    const second = await info(b);
    expect(second.threadId).toBe(first.threadId);
    // Request ids carry on, so nothing from the closed connection can match a new request.
    expect(second.id).toBeGreaterThan(first.id);
  });

  it('closeSync parks the worker too, and blocking calls work on the reused one', () => {
    const a = channel();
    const first = infoSync(a);
    a.closeSync();
    const b = channel();
    expect(infoSync(b).threadId).toBe(first.threadId);
    // More chunks than the flow-control window: leftover flow state would deadlock here.
    let seen = 0;
    b.callSync('query', query('partials:20'), { onPartial: () => seen++ });
    expect(seen).toBe(20);
  });

  it('async partials and flow control work on a reused worker', async () => {
    const a = channel();
    await a.call('query', query('partials:10'), undefined, () => {});
    await a.close();
    const b = channel();
    let seen = 0;
    await b.call('query', query('partials:20'), undefined, () => seen++);
    expect(seen).toBe(20);
  });

  it('a worker that exited is not reused', async () => {
    const a = channel();
    const first = await info(a);
    await expect(a.call('query', query('exit'))).rejects.toThrow(ConnectionClosedError);
    await a.close();
    const b = channel();
    expect((await info(b)).threadId).not.toBe(first.threadId);
  });

  it('a worker whose close failed is terminated, not reused', async () => {
    const a = channel();
    const first = await info(a);
    await a.call('query', query('failclose'));
    await expect(a.close()).rejects.toThrow('close failed');
    const b = channel();
    expect((await info(b)).threadId).not.toBe(first.threadId);
  });

  it(`keeps at most ${MAX_IDLE} workers parked`, async () => {
    const batch = Array.from({ length: MAX_IDLE + 2 }, channel);
    const before = new Set((await Promise.all(batch.map(info))).map((i) => i.threadId));
    await Promise.all(batch.map((c) => c.close()));
    const next = Array.from({ length: MAX_IDLE + 2 }, channel);
    const after = (await Promise.all(next.map(info))).map((i) => i.threadId);
    expect(after.filter((t) => before.has(t))).toHaveLength(MAX_IDLE);
  });

  it('a parked worker exits once it has been idle for a while', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const a = channel();
    const first = await info(a);
    await a.close();
    vi.advanceTimersByTime(IDLE_MS);
    // Workers parked by earlier tests may be taken instead; none of them may be this one.
    const next = Array.from({ length: MAX_IDLE + 1 }, channel);
    const after = (await Promise.all(next.map(info))).map((i) => i.threadId);
    expect(after).not.toContain(first.threadId);
  });

  it('a parked worker does not keep the process alive', () => {
    const script = fileURLToPath(new URL('../support/park-exit.ts', import.meta.url));
    // Well under IDLE_MS: the process has to exit while the worker is still parked.
    const out = execFileSync(process.execPath, ['--no-warnings', script], {
      encoding: 'utf8',
      timeout: IDLE_MS / 2,
    });
    expect(out.trim()).toBe('parked');
  });
});
