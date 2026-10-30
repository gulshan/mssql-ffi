# mssql-ffi

Promise-based SQL Server client for Node.js, built on [`node:ffi`](https://nodejs.org/api/ffi.html) and the system ODBC driver. No native addon to compile: it calls `odbc32.dll` directly.

Its API follows [msnodesqlv8](https://github.com/TimelordUK/node-sqlserver-v8), without callbacks or event emitters. It uses promises, async iterators, `await using`, `AbortSignal` and Temporal.

> **Status:** early. `node:ffi` itself is experimental, and Node prints an `ExperimentalWarning` when it loads.

## Requirements

- Node.js **≥ 26.1** (for `node:ffi` and Temporal)
- Windows x64/arm64. Linux (unixODBC) is planned.
- [Microsoft ODBC Driver 17 or 18 for SQL Server](https://learn.microsoft.com/sql/connect/odbc/download-odbc-driver-for-sql-server)

## Usage

```ts
import { open, Pool, sql } from 'mssql-ffi';

const cs =
  'Driver={ODBC Driver 18 for SQL Server};Server=localhost;Database=app;Trusted_Connection=yes;TrustServerCertificate=yes';

await using db = await open(cs);

const { first } = await db.query('SELECT id, name FROM users WHERE id > ?', [10]);

// Typed parameters, timeouts and cancellation
await db.query('UPDATE t SET price = ? WHERE id = ?', [sql.Decimal('9.99', 10, 2), sql.Int(1)], {
  timeoutMs: 5_000,
});

// Streaming: rows are fetched in batches as you iterate
for await (const row of db.stream('SELECT * FROM big_table')) {
  /* ... */
}

// Transactions
await db.transaction(async (tx) => {
  await tx.query('INSERT INTO log (msg) VALUES (?)', ['hello']);
});

// Stored procedures: output parameters and the return code
const r = await db.callProc('dbo.get_totals', { customerId: 7 });
r.output.total; // output parameter
r.returns; // RETURN value

// Pool
await using pool = await Pool.open({ connectionString: cs, floor: 1, ceiling: 8 });
await pool.query('SELECT 1');
```

## API

|                                             |                                                                                                                                                       |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open(cs, options?)`                        | Opens a `Connection`. Each connection owns a worker thread, so blocking ODBC calls never stall the event loop.                                        |
| `query(cs, sql, params?)`                   | Opens a connection, runs one query, then closes it.                                                                                                   |
| `conn.query(sql, params?, opts?)`           | Returns `{ first, results, meta, counts, info }`.                                                                                                     |
| `conn.queryRaw(...)`                        | Same, but rows are positional arrays.                                                                                                                 |
| `conn.stream(sql, params?, opts?)`          | Returns an async iterable of rows from every result set; also exposes `.meta`, `.resultSet`, `.counts`, `.info` and `.toArray()`.                     |
| `conn.prepare(sql)`                         | Returns a `PreparedStatement`: `ps.query(params)`, `ps.free()`, and `await using` support.                                                            |
| `conn.callProc(name, args?)`                | `args` can be positional or keyed by name. Values take the declared parameter types. Adds `output` and `returns` to the result.                       |
| `conn.beginTransaction({ isolationLevel })` | Returns a `Transaction` with `query`/`stream`/`callProc`/`prepare`/`commit`/`rollback`. With `await using`, an unfinished transaction is rolled back. |
| `conn.transaction(fn, opts?)`               | Commits when `fn` resolves and rolls back when it throws.                                                                                             |
| `new Pool(opts)` / `Pool.open(opts)`        | Same query surface, plus `acquire()`, `status` and `close()`. Options: `floor`, `ceiling`, `inactivityTimeoutSecs`.                                   |
| `sql.*`                                     | Typed parameters: `Int`, `BigInt`, `Decimal(v, p, s)`, `NVarChar(v, len)`, `VarBinary`, `DateTime2(v, scale)`, `DateTimeOffset`, …                    |

Every query accepts `{ signal, timeoutMs }`. Aborting calls `SQLCancel` on the running statement. The promise then rejects with the abort reason, and the driver's `SqlError` (SQLSTATE `HY008`) is attached as `cause`.

A connection runs one statement at a time; other calls queue. A transaction or an open stream reserves the connection until it ends.

### Blocking (sync) API

For scripts, CLIs, migrations and start-up code, most calls also have a `…Sync` form. **These block the calling thread**: no timers, I/O or other callbacks run until they return. Don't use them in servers.

```ts
import { openSync, querySync } from 'mssql-ffi';

// One-shot: runs in the calling thread, no worker (the cheapest single query).
const { first } = querySync(cs, 'SELECT name FROM sys.databases');

// A connection opened either way serves both async and blocking calls.
using db = openSync(cs);
db.querySync('UPDATE t SET n = n + 1 WHERE id = ?', [1]);
const later = await db.query('SELECT n FROM t'); // same connection
db.transactionSync((tx) => {
  tx.querySync('INSERT INTO log (msg) VALUES (?)', ['hello']);
});
```

| Async                                       | Blocking                                                          |
| ------------------------------------------- | ----------------------------------------------------------------- |
| `query(cs, …)` / —                          | `querySync(cs, …)`, `queryRawSync(cs, …)`: one-shot, no worker    |
| `open(cs)`                                  | `openSync(cs)`                                                    |
| `conn.query` / `queryRaw` / `callProc`      | `querySync` / `queryRawSync` / `callProcSync`                     |
| `conn.prepare`, `ps.query`, `ps.free`       | `prepareSync`, `ps.querySync`, `ps.freeSync`                      |
| `conn.beginTransaction`, `conn.transaction` | `beginTransactionSync`, `transactionSync(fn)` (`fn` must be sync) |
| `tx.commit` / `tx.rollback`                 | `commitSync` / `rollbackSync`                                     |
| `conn.close()`, `await using`               | `closeSync()`, `using`                                            |

`stream` and `Pool` have no blocking form. Blocking calls take `{ timeoutMs }` (no `signal`). On a connection the timeout cancels the statement with `SQLCancel`. The one-shot functions use the driver's query timeout, which counts whole seconds. Either way, a timeout throws a `TimeoutError` whose `cause` is the driver error.

A blocking call never waits for async work on the same connection, since that work needs the event loop. While an async query, a stream or a transaction holds the connection, it throws `ConnectionBusyError` right away.

### Connection options

| Option              | Default        |                                                                                                            |
| ------------------- | -------------- | ---------------------------------------------------------------------------------------------------------- |
| `useNumericNumber`  | `false`        | Return decimal/numeric/money as `number` instead of a lossless `string`.                                   |
| `useBigIntAsNative` | `false`        | Always return `bigint` columns as `bigint`. By default they are `number` when the value is a safe integer. |
| `loginTimeoutSecs`  | driver default | Login timeout.                                                                                             |

## Type mapping

| SQL Server                                            | JS (results)                            | JS (parameters)                                             |
| ----------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------- |
| `bit`                                                 | `boolean`                               | `boolean`                                                   |
| `tinyint`, `smallint`, `int`                          | `number`                                | integer `number` (int32 → `int`)                            |
| `bigint`                                              | `number` (safe) / `bigint`              | `bigint`, or a safe integer beyond int32                    |
| `real`, `float`                                       | `number`                                | non-integer `number`                                        |
| `decimal`, `numeric`, `money`                         | `string`                                | `sql.Decimal(...)` (string/number/bigint)                   |
| `char`, `varchar`, `nchar`, `nvarchar`, `text`, `xml` | `string`                                | `string` → `nvarchar`                                       |
| `uniqueidentifier`                                    | lowercase `string`                      | `sql.UniqueIdentifier(str)`                                 |
| `binary`, `varbinary`, `image`                        | `Uint8Array`                            | `Uint8Array` / `Buffer`                                     |
| `date`                                                | `Temporal.PlainDate`                    | `Temporal.PlainDate`                                        |
| `time`                                                | `Temporal.PlainTime`                    | `Temporal.PlainTime`                                        |
| `datetime`, `datetime2`, `smalldatetime`              | `Temporal.PlainDateTime`                | `Temporal.PlainDateTime`; `Date` (UTC wall clock)           |
| `datetimeoffset`                                      | `Temporal.ZonedDateTime` (fixed offset) | `Temporal.ZonedDateTime` / `Temporal.Instant`               |
| `NULL`                                                | `null`                                  | `null` / `undefined` (the driver describes the target type) |

### Errors

`SqlError` has `sqlstate`, `code` (the native error number), `severity`, `lineNumber`, `serverName`, `procName` and `diagnostics[]`. Its stack trace points at your call site, not at the worker.

### Tracing

Operations are published on the `diagnostics_channel` tracing channel `mssql-ffi:query` (`TRACE_CHANNEL`). The context is `{ operation, sql, params }`, plus `sync: true` for blocking calls, which are traced with `traceSync`.

## Development

```bash
pnpm install
cp .env.example .env      # set MSSQL_CONNECTION_STRING
node --run probe          # checks node:ffi, the driver manager, installed drivers, the server
pnpm test                 # unit + integration (integration skips with a reason if the probe fails)
pnpm check                # format, lint, typecheck, test, build (+ publint, attw)
```

| Script                                        |                                             |
| --------------------------------------------- | ------------------------------------------- |
| `build` / `dev`                               | tsdown (ESM only, `.d.mts`, publint + attw) |
| `lint` / `lint:fix`                           | oxlint                                      |
| `fmt` / `fmt:check`                           | oxfmt                                       |
| `typecheck`                                   | `tsc` (no emit)                             |
| `test:unit` / `test:integration` / `coverage` | vitest projects, v8 coverage                |
| `probe` / `demo`                              | development helpers                         |

The design notes are in [docs/PLAN.md](docs/PLAN.md).
