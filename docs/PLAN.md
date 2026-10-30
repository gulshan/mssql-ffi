# mssql-ffi — library plan

A promise-only SQL Server client for Node ≥ 26, shaped like msnodesqlv8. It is built on `node:ffi` and ODBC (`odbc32.dll`). Windows is supported now; Linux (unixODBC) comes later.

## Decisions

| Topic                     | Decision                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Package                   | `mssql-ffi`, ESM only, `engines.node >=26`, `os: [win32]` (for now)                                                                   |
| API style                 | msnodesqlv8 surface without callbacks or event emitters: promises, async iterators, `await using`                                     |
| v1 surface                | `open`, `query`, `queryRaw`, `stream`, `prepare`, `transaction`/`begin`/`commit`/`rollback`, `callProc`, `Pool`, `sql.*` typed params |
| decimal / numeric / money | `string` (lossless); opt-in `useNumericNumber`                                                                                        |
| date / time               | Temporal: `PlainDate`, `PlainTime`, `PlainDateTime`, `ZonedDateTime` (datetimeoffset). `Date` is still accepted as a param            |
| bit                       | `boolean`                                                                                                                             |
| bigint                    | `number` when safe, else `bigint` (opt `useBigIntAsNative` → always `bigint`)                                                         |
| uniqueidentifier          | lowercase `string`                                                                                                                    |
| binary                    | `Uint8Array` (Buffer accepted as param)                                                                                               |
| Probing                   | dev-only: `scripts/probe.ts` + vitest globalSetup gate. **Not exported**                                                              |
| Not in scope              | CI, changesets, TVP/bulk, Linux (design for it only)                                                                                  |

## Architecture

```
main thread                               worker thread (1 per connection)
-----------                               --------------------------------
Connection ── postMessage(req) ─────────▶ dispatcher
  pending: Map<id, withResolvers>          OdbcConnection (sync ffi)
  decode Temporal/decimal from raw parts ◀─ rows as raw parts, ArrayBuffers transferred
  AbortSignal ──▶ SQLCancel(stmtHandle)    (stmt handle shared via SharedArrayBuffer)
  diagnostics_channel tracing
```

- `node:ffi` calls are synchronous only, so the per-connection worker stays.
- Temporal objects cannot be structured-cloned. The worker sends `{y,m,d,h,mi,s,ns,offset}` and the main thread builds the objects.
- Cancellation: the main thread `dlopen`s `SQLCancel` lazily. The worker publishes the active stmt handle in a SharedArrayBuffer, and on abort/timeout the main thread calls `SQLCancel`. `SQL_ATTR_QUERY_TIMEOUT` is set as well.
- `stream()` is pull-based: the iterator asks for N rows at a time, and the worker keeps the stmt open between requests, which gives backpressure for free. Disposing the iterator or breaking out of the loop closes the cursor.
- A connection serializes requests (a queue). `transaction()` holds the queue lock, so outside queries don't leak into it.
- Worker `exit`/`error` rejects all pending requests and marks the connection dead.
- Starting a worker thread costs more than a login on a warm driver, so a worker whose connection closed cleanly is parked (`workers.ts`): unref'd, holding no ODBC connection, at most 4, each exiting after 10 s idle. The next `open()` or one-shot `query(cs, …)` takes it. Request ids keep counting on the reused worker, so a late cancel from the closed connection cannot hit a new request. A worker that died or whose `close` failed is terminated instead.

## Layout

```
src/
  index.ts              public exports
  connection.ts         Connection (main thread), queue, cancel, dispose
  pool.ts               Pool (floor/ceiling/idle timeout/transaction)
  prepared.ts           PreparedStatement
  transaction.ts
  stream.ts             async iterator
  types.ts              sql.Int(), sql.NVarChar(...) typed params
  decode.ts             raw parts -> Temporal / decimal / bigint
  errors.ts             SqlError {sqlstate, code, severity, lineNumber, serverName, procName}
  trace.ts              diagnostics_channel tracingChannel('mssql-ffi:query')
  protocol.ts           worker messages
  worker.ts             2nd tsdown entry
  workers.ts            parked workers, reused by the next connection
  odbc/
    platform.ts         library name / pointer size (win32 now, linux later)
    ffi.ts              lazy dlopen, signatures
    constants.ts
    params.ts           pure: Param -> binding descriptor
    columns.ts          pure: SQL type -> kind, struct decoding
    statement.ts        execute, fetch, more results, info msgs, output params
    connection.ts       sync ODBC connection
scripts/probe.ts        dev probe (node --run probe)
tests/
  setup/probe.ts        globalSetup: skip integration if no driver/server
  unit/                 pure fns, no DB
  integration/          real SQL Server via MSSQL_CONNECTION_STRING
examples/demo.ts
```

## Bugs to fix along the way

1. A `SQLMoreResults` error in a later batch statement is silently swallowed.
2. No worker `exit` handler, so a dead worker leaves promises hanging forever.
3. Integer `number` > 2^63 throws RangeError; NaN/Infinity are bound as double.
4. Errors lose SQLSTATE and native code when they cross threads.
5. Date params are bound as UTC ISO text; dates/decimals/guids are returned as text.
6. The worker URL is hard-coded to `.ts`.
7. `dlopen` runs on import, which breaks unit tests on machines without ODBC.
8. No arch check, no dispose support, double close / close with pending queries not handled.
9. `SQLGetDiagRecW` message length not clamped to buffer.

## Tooling

- **tsdown**: entries `src/index.ts`, `src/worker.ts`; `format: esm`, `platform: node`, `target: node26`, `dts` (isolatedDeclarations), `publint`, `attw` (esm-only profile).
- **TypeScript 6**: `tsc --noEmit`, `lib: esnext` (Temporal, disposable), `isolatedDeclarations`, `erasableSyntaxOnly`.
- **oxlint**: typescript, import, unicorn, vitest, node plugins.
- **oxfmt**: single quotes, width 100, trailing commas (matches the current code style).
- **vitest**: projects `unit` and `integration`; `@vitest/coverage-v8`.
- **Scripts**: `build`, `dev`, `probe`, `lint`, `lint:fix`, `fmt`, `fmt:check`, `typecheck`, `test`, `test:unit`, `test:integration`, `coverage`, `check`, `prepublishOnly`.
- `.env` (gitignored) + `.env.example` holding `MSSQL_CONNECTION_STRING`.

## Implementation order

1. Tooling skeleton (package.json, tsdown, tsconfig, oxlint, oxfmt, vitest) with the existing code moved into `src/`. Get it green.
2. Split the odbc layer; make dlopen lazy; pure param/column modules + unit tests.
3. Probe script + integration gate.
4. Bug fixes 1–9 + SqlError + info messages.
5. Type mapping (Temporal, decimal, bit, guid, binary) + `sql.*` typed params.
6. Connection queue, cancel/timeout, dispose, tracing.
7. stream, prepare, transaction, callProc.
8. Pool.
9. README, examples, `check` + `pnpm pack` dry run.

## Status (2026-10-30)

Steps 1–9 are implemented. `pnpm check` passes: format, lint, typecheck, 143 tests (unit + integration against SQL Server 2022) and the build with publint and attw. The built `dist/` was smoke-tested via ESM `import` and CommonJS `require(esm)`.

Findings during implementation:

- The environment must declare ODBC **3.8** (`SQL_OV_ODBC3_80`). Otherwise the driver manager rejects the SQL Server C types (`SQL_C_SS_TIME2`, `SQL_C_SS_TIMESTAMPOFFSET`) with HY003.
- Procedure metadata comes from `sys.all_parameters`, so system procedures work too.
- Coverage numbers exclude code running in worker threads (`worker.ts`, `odbc/*`). The integration tests exercise that code, but v8 coverage does not see it.

Open items: Linux (unixODBC), TVP/bulk copy, a LICENSE file, CI.

## Performance (2026-10-30)

How the read path works (see `src/odbc/reader.ts`):

- **Block fetch:** when every column has a bounded size, the columns are bound (`SQLBindCol`) to one off-heap buffer, and a block cursor reads up to 1024 rows (about 4 MB) per `SQLFetch`. Values are decoded from the buffer in JS without any FFI call.
- **Mixed results:** the driver reports `SQL_GD_BLOCK` but not `SQL_GD_ANY_COLUMN` or `SQL_GD_BOUND`, so `SQLGetData` only works on columns _after_ the last bound one. A result with a `(max)` column therefore binds the columns before it and reads the rest per value.
- **Per-value reads:** `SQLGetData` takes raw addresses (`getRawPointer`) into a long-lived scratch buffer instead of Buffer arguments, which makes each call about 28% cheaper.
- **Transfer to the main thread:** query results go out in chunks of about 32k values (`partial` messages), so decoding on the main thread overlaps the worker's fetch.
- **Back-pressure:** at most 4 chunks may be undecoded at once, enforced with `Atomics.wait` on a SharedArrayBuffer (`src/flow.ts`). Node delivers queued messages in one go, so this keeps the event loop responsive and memory bounded.
- **Streams prefetch:** `stream()` always keeps one `cursor.fetch` in flight, so the worker reads the next batch while the caller consumes the current one. On an early `break` the in-flight batch lands before the cursor closes.

The remaining event-loop pauses (about 50–200 ms) are V8 major GCs of large dropped results, not message handling.

Benchmark: `bench/` compares against msnodesqlv8 on a generated tempdb table (see `bench/README.md`).
