import { describe, expect, it, vi } from 'vitest';
import { queryRawSync, querySync } from '../../src/index.ts';
import { connectionString, skip } from './helpers.ts';

// Any attempt to start a connection worker fails this file.
vi.mock('../../src/channel.ts', () => ({
  // oxlint-disable-next-line consistent-function-scoping -- vi.mock factories are hoisted
  Channel: function Channel() {
    throw new Error('a worker was spawned');
  },
  ConnectionClosedError: class extends Error {},
}));

describe.skipIf(skip)('querySync without a worker', () => {
  it('runs in the calling thread', () => {
    expect(querySync(connectionString, 'SELECT 1 AS n').first).toEqual([{ n: 1 }]);
    expect(queryRawSync(connectionString, 'SELECT 2 AS n').results).toEqual([[[2]]]);
  });
});
