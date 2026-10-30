# Sync API — plan

Blocking variants of selected methods on the **same** `Connection`, `Transaction` and `PreparedStatement` objects. They are meant for scripts, CLIs, migrations and start-up code, where blocking the event loop is acceptable. One connection can be opened either way and used both ways:

```ts
using db = openSync(cs); // or: await using db = await open(cs)
const { first } = db.querySync('SELECT 1 AS n'); // blocks the calling thread
const later = await db.query('SELECT 2 AS n'); // same worker, same ODBC connection
```

There are two sync paths:

- **Connection methods** (`conn.querySync` and the rest) send a blocking call to the connection's worker.
- **Standalone one-shot functions** (`querySync`, `queryRawSync`) run ODBC in the calling thread, with no worker. See [One-shot functions](#one-shot-functions-in-thread-no-worker).

## Mechanism: sync RPC to the existing worker

The worker stays the only owner of the ODBC handles. A sync call posts its request on a dedicated `MessageChannel` port and blocks in `Atomics.wait` on a SharedArrayBuffer counter. It then reads replies with `receiveMessageOnPort`, so it never needs the event loop.

```
async:  query()      ─ worker.postMessage ─▶ worker ─▶ odbc/Connection ─▶ partials ─▶ 'message' events ─▶ decode
sync:   querySync()  ─ syncPort.postMessage ─▶ worker ─▶ odbc/Connection ─▶ partials ─▶ Atomics.wait + receiveMessageOnPort ─▶ decode
```

A prototype on Node 26 (scratchpad, not in the repo) gave these results:

- The first sync call worked while the worker was still booting, so `openSync` is possible. That first call took ~14 ms including worker startup.
- Partial chunks drained correctly.
- 1000 round trips took 27 ms, about 27 µs each.
- The async path on the same worker kept working afterwards.

**Rejected alternative:** running FFI in the main thread on the worker's `dbc` pointer. The prepared-statement map, the cursor and the transaction flags live in the worker's JS heap, so that state would split in two. Two threads would touch one ODBC connection. And timeouts would lose `SQLCancel`, because a blocked thread cannot cancel itself.

## One-shot functions: in-thread, no worker

Standalone `querySync(cs, sql, params?, opts?)` and `queryRawSync(…)` call `odbc/Connection` directly in the calling thread:

1. open the connection (`Connection.open`, with the login timeout);
2. run `query(args)` without `onRows`, so the whole `WireQueryResult` comes back at once;
3. decode it with the shared `Collector`;
4. close the connection in `finally`.

Nothing outlives the call. One ODBC connection is opened, used and freed on one thread, so the objection above (state split between threads) does not apply. No worker, port, shared buffer, mutex or busy rule is involved.

Measured with `SELECT 1` against a local server: 20 calls after a warm-up, built `dist`.

| One-shot path                                    | ms/call |
| ------------------------------------------------ | ------- |
| in-thread `odbc/Connection` open → query → close | 12.9    |
| in-thread, login and disconnect only             | 11.4    |
| worker `query()` (spawn → open → query → close)  | 40.6    |

The worker costs about 28 ms per one-shot call: thread start, module load, port and shared memory. In-thread, the only real cost left is the login. The first in-thread call in a process took 105 ms, because it loads the ODBC library and sets up the environment handle.

The bench's `oneshot` scenarios on the synthetic setup later gave, per call:

| Path                                        | ms/call |
| ------------------------------------------- | ------- |
| in-thread `querySync(cs, …)`                | ~0.7    |
| msnodesqlv8 `promises.query(cs, …)`         | ~1–2    |
| worker `query(cs, …)`, new worker per call  | ~19     |
| worker `query(cs, …)`, reused parked worker | ~1.1    |

The login there was much cheaper than in the first measurement. The worker's start-up cost is the same either way: about 10–15 ms for the thread, plus a few ms of first-use warm-up in a fresh isolate, plus about 2 ms to terminate it. A worker whose connection closed cleanly is therefore parked and reused by the next `open()` or `query(cs, …)` (see `workers.ts` and PLAN.md). Only the first connection, and any connection opened while every parked worker is in use, pay for a new thread.

**Sync gives no per-call gain on an open connection.** In the `small` scenarios, `conn.querySync` matched async `conn.query` within noise. The server round trip dominates, and a postMessage hop costs about the same as an `Atomics.wait` wake-up.

Differences from `conn.querySync`:

| Topic         | `conn.querySync` (worker)                 | standalone `querySync` (in-thread)                                                                     |
| ------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Timeout       | `timeoutMs` → `SQLCancel`, ms precision   | `timeoutMs` → `SQL_ATTR_QUERY_TIMEOUT`, rounded up to whole seconds (min 1); the driver raises `HYT00` |
| Timeout error | `TimeoutError` with `SqlError` cause      | the same shape: `HYT00` is wrapped into `TimeoutError` so callers handle both paths alike              |
| Decode        | partials decoded while the worker fetches | decoded after the fetch; no structured clone                                                           |
| `node:ffi`    | main thread binds only `SQLCancel`        | main thread binds the full ODBC subset, lazily on the first call                                       |

`callProcSync(cs, …)` as a one-shot function is possible the same way (proc lookup and call on one connection). It is left out until there is a need for it.

**Later, opt-in:** ODBC driver-manager connection pooling (`SQL_ATTR_CONNECTION_POOLING`) would let repeated one-shot calls reuse physical connections and skip most of the ~11 ms login. It is a process-level setting that also affects every worker connection, and the server resets the session on reuse. So it would be an explicit option, measured before adoption, and is not part of this plan.

## API

Pairs follow the `node:fs` convention (`x` / `xSync`) on the same objects.

| Async                                  | Sync                                          | Notes                                                                                                 |
| -------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `open(cs, opts)`                       | `openSync(cs, opts)`                          | `Connection.openSync` too                                                                             |
| `query(cs, sql, params, opts)`         | `querySync(cs, sql, params, opts)`            | one-shot, **in-thread** (no worker); `queryRawSync(cs, …)` likewise                                   |
| `conn.query` / `queryRaw` / `callProc` | `querySync` / `queryRawSync` / `callProcSync` | same result shapes                                                                                    |
| `conn.prepare(sql)`                    | `conn.prepareSync(sql)`                       | returns the same `PreparedStatement` class                                                            |
| `ps.query` / `ps.free`                 | `ps.querySync` / `ps.freeSync`                | `[Symbol.dispose]` next to `[Symbol.asyncDispose]`                                                    |
| `conn.beginTransaction(opts)`          | `conn.beginTransactionSync(opts)`             | the same `Transaction` class                                                                          |
| `conn.transaction(fn)`                 | `conn.transactionSync(fn)`                    | commit on return, rollback on throw; **rolls back and throws `TypeError` if `fn` returns a thenable** |
| `tx.query`… `commit` / `rollback`      | `tx.querySync`… `commitSync` / `rollbackSync` | `[Symbol.dispose]` rolls back if active                                                               |
| `conn.close()`                         | `conn.closeSync()`                            | `[Symbol.dispose]` next to `[Symbol.asyncDispose]`                                                    |

A connection or transaction opened one way can be used and ended the other way.

**Not sync:** `stream` (an `iterateSync` cursor may come later), `Pool` (its `acquire` waits for a free connection), `AbortSignal`.

Class layering keeps `Pool` free of sync methods:

```
Queryable (async: query, queryRaw, stream, callProc)  ◀── Pool
  └─ SyncQueryable (+ querySync, queryRawSync, callProcSync)  ◀── Connection, Transaction
```

## Rules

**Busy rule.** A sync call needs the connection's mutex _right now_. It calls `Mutex.tryAcquire()`, which is new and succeeds only when the lock is free with no waiters. Otherwise it throws `ConnectionBusyError`. The call cannot wait, because whoever holds the lock needs the event loop to make progress. The lock is held while:

- an async query, prepare or free is in flight;
- a `stream` is being iterated;
- a transaction is active (on the connection; the `Transaction` object has its own mutex, so `tx.querySync` works).

This rule also prevents a deadlock. Without it, the worker could block in `flow.acquire()` on async chunks that the blocked main thread never releases.

`Channel.callSync` adds a second, lower-level guard: it refuses to block while any async request is actually in flight on the worker. `closeSync` uses only that one. Closing while statements are merely queued behind the lock is allowed and rejects them, exactly as `close()` does. Closing during an idle transaction rolls it back on disconnect.

**Timeouts.** Sync options are `{ timeoutMs }` only. The main thread waits in slices until the deadline, then calls `SQLCancel` through the existing `CancelSlot`, exactly as an aborted async call does. It keeps waiting for the worker's reply, then throws a `TimeoutError` (`DOMException`, as `AbortSignal.timeout` gives) with the driver error as `cause`. This matches the async behaviour.

**Errors.** `SqlError` is thrown with the stack of the `xSync` call site (`Error.captureStackTrace` in `callSync`).

**Worker death.** A blocked `Atomics.wait` gets no `'exit'` event. To cover this:

- The worker sets a `dead` flag in the sync SharedArrayBuffer from `process.on('exit')` and notifies.
- The main thread waits in bounded slices and checks the flag, then throws `ConnectionClosedError`.
- A native crash takes down the whole process anyway.

**Tracing.** Sync calls use `traceSync` on the same `mssql-ffi:query` channel. `QueryTraceContext` gains `sync: boolean`.

## Changes

| File                | Change                                                                                                                                                                                                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `protocol.ts`       | `WorkerData` gains `port: MessagePort` (transferred) and `sync: SharedArrayBuffer` (`Int32[0]` reply counter, `Int32[1]` dead flag)                                                                                                                                                |
| `worker.ts`         | Also listens on `port`. `handle()` takes a `reply(res, transfer)` sink: for the sync port it posts, then `Atomics.add` + `notify`. Partials still go through `flow.acquire()`                                                                                                      |
| `channel.ts`        | `callSync(op, args, timeoutMs?)`: post → wait → drain loop, releasing `flow` per partial. `closeSync()`: sync `close`, mark dead, then park the worker for reuse (`workers.ts`), or terminate it without awaiting if the close failed                                              |
| `mutex.ts`          | `tryAcquire(): (() => void) \| undefined`                                                                                                                                                                                                                                          |
| `lease.ts`          | No change. A sync lease is the same object, built from `tryAcquire`                                                                                                                                                                                                                |
| `queryable.ts`      | Turn `collect()` into a `Collector` (`onPartial(p)`, `finish(wire)`) shared by all paths. `finish` also decodes rows carried in `wire` itself, which is what the one-shot path returns, since it has no partials. Add `SyncQueryable` with `protected abstract leaseSync(): Lease` |
| `proc.ts` / cache   | The cache becomes `Map<string, ProcParamInfo \| Promise<ProcParamInfo>>`. A settled lookup stores the value. A sync call that finds a pending promise does its own lookup                                                                                                          |
| `connection.ts`     | `openSync`, `leaseSync`, `prepareSync`, `beginTransactionSync`, `transactionSync`, `closeSync`, `[Symbol.dispose]`; top-level `openSync`/`querySync`                                                                                                                               |
| `transaction.ts`    | `beginSync`, `leaseSync`, `prepareSync`, `commitSync`/`rollbackSync`, `[Symbol.dispose]`                                                                                                                                                                                           |
| `prepared.ts`       | Takes both lease functions; adds `querySync`, `freeSync`, `[Symbol.dispose]`                                                                                                                                                                                                       |
| `errors.ts`         | `ConnectionBusyError`                                                                                                                                                                                                                                                              |
| `trace.ts`          | `tracedSync`, `sync` flag in the context                                                                                                                                                                                                                                           |
| `oneshot.ts` (new)  | In-thread `querySync`/`queryRawSync`: `odbc/Connection.open` → `query` → `Collector.finish` → `close` in `finally`; maps `HYT00` to `TimeoutError`                                                                                                                                 |
| `odbc/statement.ts` | `execute()` takes `timeoutSecs` and sets `SQL_ATTR_QUERY_TIMEOUT` (statement attribute 0) before running; add the constant to `constants.ts`                                                                                                                                       |
| `index.ts`          | Export `openSync`, `querySync`, `queryRawSync`, `ConnectionBusyError`                                                                                                                                                                                                              |

Only the one-shot functions bind the full ODBC subset in the main thread. Connection methods keep the main thread on `SQLCancel` alone.

`SQL_ATTR_QUERY_TIMEOUT` is needed now (for one-shot timeouts). [PLAN.md](PLAN.md) already claims the async path sets it, but nothing does. With the attribute in place, the worker paths may set it as a backstop beside `SQLCancel`. Either do that or correct the PLAN.md wording.

## Risks

| Risk                                          | Mitigation                                                                                                                  |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Blocks the event loop                         | Every `xSync` JSDoc and the README say so; intended for scripts and start-up                                                |
| Mixing deadlock (sync waits on async holder)  | Busy rule: fail fast with `ConnectionBusyError`                                                                             |
| Hang if the worker dies                       | Dead flag plus bounded wait slices                                                                                          |
| Async callback passed to `transactionSync`    | Thenable check: roll back, throw `TypeError`                                                                                |
| Forgotten `closeSync`                         | `[Symbol.dispose]`; the worker is already `unref`'d, so it never keeps the process alive                                    |
| Large results                                 | Same as async `query`. Chunks are still decoded while the worker fetches the next ones                                      |
| Mutex hand-off in a microtask                 | `tryAcquire` treats "released, waiter not yet resumed" as busy (it checks the queue, not just the flag)                     |
| One-shot timeout is coarse (whole seconds)    | Documented on `querySync`; for ms precision use `openSync` + `conn.querySync`                                               |
| One-shot leaks a handle when the query throws | `close()` in `finally`; a test asserts that after a failing call, sys.dm_exec_sessions shows no extra session for the login |

## Tests

- **Agreement:** the same SQL (types round trip, multi-result batch with counts and info) through `conn.query`, `conn.querySync` and standalone `querySync` must give `deepEqual` results.
- **One-shot:**
  - no worker is spawned (`vi.mock` of `channel.ts` asserts that `Channel` is never constructed);
  - `WAITFOR DELAY '00:00:03'` with `timeoutMs: 1000` throws `TimeoutError` with an `HYT00` cause;
  - a failing statement still closes the connection.
- **Mixing:**
  - `openSync`, then `await query`; `open`, then `querySync`;
  - a statement prepared async and run sync, and the reverse;
  - a transaction begun sync and committed async;
  - a proc cache filled async and used by `callProcSync`.
- **Busy:** `querySync` throws `ConnectionBusyError` during an in-flight `query`, during an open `stream`, and on the connection during a transaction, while `tx.querySync` works. After each case the connection is still usable.
- **Timeout:** `WAITFOR DELAY '00:00:03'` with `timeoutMs: 500` throws `TimeoutError` with a `SqlError` cause after about 500 ms. The next query on the same connection works.
- **Lifecycle:**
  - `using db = openSync(...)` closes the connection;
  - after `closeSync`, sync calls throw and async calls reject with `ConnectionClosedError`;
  - `transactionSync` with an async fn rolls back and throws.
- **Unit:**
  - `Mutex.tryAcquire`, including mid-hand-off;
  - the `callSync` drain loop with a fake worker (partials, error, dead flag).
- **Bench:** in `bench/case.ts`, on the synthetic table only:
  - `sync` variants of `query` and `small`;
  - a `oneshot` scenario comparing standalone `querySync` with async `query(cs, …)`.

## Order

1. **Done.** `Mutex.tryAcquire`, the `Collector` refactor and the proc-cache change. Existing tests stay green (`node --run check`).
2. **Done.** `SQL_ATTR_QUERY_TIMEOUT` in `odbc/statement.ts`, then `oneshot.ts` (`querySync`, `queryRawSync`), with agreement, one-shot and timeout tests. This step is small and stands on its own.
3. **Done.** Sync port in `protocol.ts`, `worker.ts` and `channel.ts` (`callSync`, `closeSync`, dead flag); unit tests.
4. **Done.** `SyncQueryable`, plus `Connection.openSync`, `querySync`, `queryRawSync`, `closeSync`, `dispose`. Agreement and busy tests.
5. **Done.** `prepareSync`, `callProcSync`, sync transactions; mixing and lifecycle tests.
6. **Done** (landed with step 3). Worker-path timeouts (`SQLCancel`); timeout test.
7. **Done.** README section, JSDoc warnings, bench scenarios.
