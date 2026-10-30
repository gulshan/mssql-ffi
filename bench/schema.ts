// schema.ts - a synthetic wide table for the benchmark, generated in tempdb.
// Mixed types, ~9% NULLs, and nvarchar(max) columns early and late in the row so both
// read paths (block fetch and bound prefix + SQLGetData) are exercised.

export const TABLE = process.env['BENCH_TABLE'] ?? 'tempdb.dbo.mssql_ffi_bench';
export const ROWS = Number(process.env['BENCH_ROWS'] ?? 20_000);

interface Column {
  name: string;
  type: string;
  /** T-SQL expression over the row number `n` and column index `k`. */
  value: string;
  max?: boolean;
}

const nullable = (k: number, expr: string): string =>
  `CASE WHEN (n + ${k}) % 11 = 0 THEN NULL ELSE ${expr} END`;

const PATTERN: ((k: number) => Omit<Column, 'name'>)[] = [
  (k) => ({ type: 'int', value: nullable(k, `(n * ${k + 7}) % 100000`) }),
  (k) => ({ type: 'float', value: nullable(k, `n / ${k + 1}.5E0`) }),
  (k) => ({ type: 'bit', value: nullable(k, `CAST((n + ${k}) % 2 AS bit)`) }),
  (k) => ({ type: 'nvarchar(100)', value: nullable(k, `CONCAT(N'item-', n, N'-', ${k})`) }),
  (k) => ({
    type: 'datetime2(3)',
    value: nullable(k, `DATEADD(second, n * ${k + 1}, '2020-01-01')`),
  }),
  (k) => ({
    type: 'decimal(18,4)',
    value: nullable(k, `CAST(n * 1.2345 + ${k} AS decimal(18,4))`),
  }),
  (k) => ({ type: 'bigint', value: nullable(k, `CAST(n AS bigint) * 1000003 + ${k}`) }),
  (k) => ({ type: 'nvarchar(400)', value: nullable(k, `REPLICATE(N'é', (n + ${k}) % 60)`) }),
  (k) => ({ type: 'date', value: nullable(k, `DATEADD(day, (n + ${k}) % 3650, '2015-01-01')`) }),
  (k) => ({ type: 'varchar(50)', value: nullable(k, `CONCAT('v', (n + ${k}) % 1000)`) }),
  (k) => ({ type: 'datetime', value: nullable(k, `DATEADD(minute, n + ${k}, '2010-06-01')`) }),
  (k) => ({ type: 'smallint', value: nullable(k, `CAST((n + ${k}) % 30000 AS smallint)`) }),
];

/** Positions (0-based, among the generated columns) of the nvarchar(max) columns. */
const MAX_AT = new Set([14, 70, 115]);

function columns(): Column[] {
  const out: Column[] = [{ name: 'id', type: 'int NOT NULL PRIMARY KEY', value: 'n' }];
  for (let k = 0; k < 120; k++) {
    if (MAX_AT.has(k)) {
      out.push({
        name: `c${k}`,
        type: 'nvarchar(max)',
        value: `CASE WHEN n % 5 = 0 THEN NULL ELSE REPLICATE(N'lorem ', n % 40) END`,
        max: true,
      });
    } else {
      out.push({ name: `c${k}`, ...PATTERN[k % PATTERN.length]!(k) });
    }
  }
  return out;
}

export const COLUMNS: Column[] = columns();

/** Full scan of the table. */
export const SELECT_ALL = `SELECT * FROM ${TABLE}`;
/** Same rows without the nvarchar(max) columns: every column has a bounded size. */
export const SELECT_NO_MAX = `SELECT ${COLUMNS.filter((c) => !c.max)
  .map((c) => c.name)
  .join(', ')} FROM ${TABLE}`;

/** Drops and recreates the table with `rows` generated rows. */
export function createSql(rows: number): string {
  const defs = COLUMNS.map((c) => `${c.name} ${c.type}`).join(',\n  ');
  const values = COLUMNS.map((c) => `${c.value} AS ${c.name}`).join(',\n    ');
  return `
DROP TABLE IF EXISTS ${TABLE};
CREATE TABLE ${TABLE} (
  ${defs}
);
INSERT INTO ${TABLE} WITH (TABLOCK)
SELECT ${values}
FROM (SELECT TOP (${rows}) ROW_NUMBER() OVER (ORDER BY (SELECT 1)) AS n
      FROM sys.all_objects a CROSS JOIN sys.all_objects b CROSS JOIN sys.all_objects c) g;`;
}
