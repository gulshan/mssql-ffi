# mssql-ffi vs msnodesqlv8

A benchmark against a real SQL Server, using synthetic data only. Each library/scenario pair runs in its own process.

```bash
pnpm install          # separate pnpm root; links ../ (run `pnpm build` in the root first)
node --run bench      # reads MSSQL_CONNECTION_STRING from ../.env
SCENARIOS=query,small ITERATIONS=3 node --run bench
```

On its first run the benchmark generates `tempdb.dbo.mssql_ffi_bench` (see [schema.ts](schema.ts)). The table has 20,000 rows × 121 columns:

- 12 types: int, smallint, bigint, bit, float, decimal, date, datetime, datetime2, varchar, nvarchar(100/400).
- About 9% of values are NULL.
- Three `nvarchar(max)` columns sit at positions 16, 72 and 117.

It lives in tempdb, so a server restart drops it, and it is recreated when its shape no longer matches. `BENCH_TABLE` and `BENCH_ROWS` override the defaults.

| scenario       | what                                                              |
| -------------- | ----------------------------------------------------------------- |
| `query`        | full table as row objects (`conn.query` / `conn.promises.query`)  |
| `query-nomax`  | same rows without the `nvarchar(max)` columns (118, all bindable) |
| `raw`          | positional rows (`queryRaw`)                                      |
| `stream`       | row-by-row (`for await` stream / `row` events)                    |
| `small`        | 200 sequential `TOP 1` queries (per-call overhead)                |
| `concurrent`   | 8 × `TOP 10000` across 4 connections                              |
| `query-sync`   | `query` with the blocking `conn.querySync`                        |
| `small-sync`   | `small` with `conn.querySync`                                     |
| `oneshot`      | 20 × open → `TOP 1` → close (`query(cs, …)` / `promises.query`)   |
| `oneshot-sync` | `oneshot` with the in-thread `querySync(cs, …)`                   |

msnodesqlv8 has no blocking API, so in the `-sync` scenarios it runs its async equivalent. Those rows are its async baseline, not a sync result. For mssql-ffi's blocking rows the event-loop columns read `blocked`: the loop does not run at all during the call.

Each run reports the median and minimum time of 5 iterations after a warm-up, the event-loop delay during the timed iterations (max/p99) and peak RSS. Raw numbers are written to `results.json`.
