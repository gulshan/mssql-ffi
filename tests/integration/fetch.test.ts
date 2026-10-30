import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { open } from '../../src/index.ts';
import type { Connection, Row } from '../../src/index.ts';
import { connectionString, skip } from './helpers.ts';

// 3000 rows: crosses rowset (block cursor) and partial-message boundaries; every 7th row NULL.
const ROWS = `
SELECT i,
  CASE WHEN i % 7 = 0 THEN NULL ELSE CAST(i % 2 AS bit) END AS b,
  CASE WHEN i % 7 = 0 THEN NULL ELSE CAST(i % 200 AS tinyint) END AS ti,
  CASE WHEN i % 7 = 0 THEN NULL ELSE CAST(i * 1000000007 AS bigint) END AS bi,
  CASE WHEN i % 7 = 0 THEN NULL ELSE i / 3.0E0 END AS f,
  CASE WHEN i % 7 = 0 THEN NULL ELSE CAST(i / 7.0 AS decimal(18,6)) END AS d,
  CASE WHEN i % 7 = 0 THEN NULL ELSE NEWID() END AS g_dummy,
  CASE WHEN i % 7 = 0 THEN NULL ELSE DATEADD(day, i, CAST('2000-01-01' AS date)) END AS dt,
  CASE WHEN i % 7 = 0 THEN NULL ELSE CAST(DATEADD(second, i, '12:00') AS time(7)) END AS tm,
  CASE WHEN i % 7 = 0 THEN NULL ELSE DATEADD(minute, i, CAST('2020-01-01' AS datetime2(7))) END AS dt2,
  CASE WHEN i % 7 = 0 THEN NULL ELSE TODATETIMEOFFSET(DATEADD(minute, i, CAST('2020-01-01' AS datetime2)), '+05:30') END AS dto,
  CASE WHEN i % 7 = 0 THEN NULL ELSE REPLICATE(N'é', i % 50) END AS s,
  CASE WHEN i % 7 = 0 THEN NULL ELSE CAST(REPLICATE('x', i % 30) AS varchar(40)) END AS v,
  CASE WHEN i % 7 = 0 THEN NULL ELSE CAST(i AS varbinary(8)) END AS vb
FROM (SELECT TOP 3000 ROW_NUMBER() OVER (ORDER BY (SELECT 1)) AS i
      FROM sys.all_objects a CROSS JOIN sys.all_objects b) n`;

/** Same columns, with GUIDs made deterministic so runs can be compared. */
const SELECT = ROWS.replace(
  'NEWID()',
  "CAST(CONCAT('00000000-0000-0000-0000-', FORMAT(i, '000000000000')) AS uniqueidentifier)",
);

const withoutM = (r: Row): Row => {
  const copy = { ...r };
  delete copy['m'];
  return copy;
};

const comparable = (rows: Row[]) =>
  rows.map((r) =>
    Object.fromEntries(
      Object.entries(r).map(([k, v]) => [
        k,
        v instanceof Uint8Array
          ? Buffer.from(v).toString('hex')
          : typeof v === 'object' && v
            ? String(v)
            : v,
      ]),
    ),
  );

describe.skipIf(skip)('fetch paths agree', () => {
  let db: Connection;
  let reference: Row[];
  beforeAll(async () => {
    db = await open(connectionString);
    // A leading nvarchar(max) column forces pure SQLGetData for every column.
    const r = await db.query(
      `SELECT CAST(N'' AS nvarchar(max)) AS m, * FROM (${SELECT}) q ORDER BY i`,
    );
    reference = r.first.map(withoutM);
  });
  afterAll(() => db?.close());

  it('reference data looks right', () => {
    expect(reference).toHaveLength(3000);
    expect(reference[6]).toMatchObject({ i: 7, b: null, s: null, vb: null });
    expect(reference[0]).toMatchObject({ i: 1, b: true, ti: 1, bi: 1000000007, s: 'é', v: 'x' });
    expect(reference[0]!['g_dummy']).toBe('00000000-0000-0000-0000-000000000001');
  });

  it('block fetch (all columns bound) matches', async () => {
    const r = await db.query(`SELECT * FROM (${SELECT}) q ORDER BY i`);
    expect(comparable(r.first)).toEqual(comparable(reference));
  });

  it('bound prefix + SQLGetData suffix matches', async () => {
    const r = await db.query(
      `SELECT q.i, q.b, q.ti, CAST(N'' AS nvarchar(max)) AS m, q.bi, q.f, q.d, q.g_dummy, q.dt, q.tm, q.dt2, q.dto, q.s, q.v, q.vb
       FROM (${SELECT}) q ORDER BY i`,
    );
    expect(comparable(r.first.map(withoutM))).toEqual(comparable(reference));
  });

  it('queryRaw, stream and prepared statements read the same rows', async () => {
    const sql = `SELECT * FROM (${SELECT}) q ORDER BY i`;
    const raw = await db.queryRaw(sql);
    expect(raw.results[0]).toHaveLength(3000);
    expect(raw.results[0]![2999]![0]).toBe(3000);

    const streamed = await db.stream(sql, [], { batchSize: 999 }).toArray();
    expect(comparable(streamed)).toEqual(comparable(reference));

    await using ps = await db.prepare(`${sql.replace('ORDER BY i', 'WHERE i <= ? ORDER BY i')}`);
    expect((await ps.query([1500])).first).toHaveLength(1500);
    expect(comparable((await ps.query([3000])).first)).toEqual(comparable(reference));
  });

  it('keeps result sets apart, including empty ones between large ones', async () => {
    const r = await db.query(
      `SELECT * FROM (${SELECT}) q ORDER BY i; SELECT 1 AS x WHERE 1 = 0; SELECT TOP 5 i FROM (${SELECT}) q ORDER BY i DESC`,
    );
    expect(r.results.map((s) => s.length)).toEqual([3000, 0, 5]);
    expect(r.meta[1]!.map((m) => m.name)).toEqual(['x']);
    expect(r.results[2]![0]).toEqual({ i: 3000 });
  });

  it('back-pressure: many chunks arrive complete and in order', async () => {
    // 25000 rows x 20 columns = 500k values, ~15 partial chunks (more than the in-flight window).
    const cols = Array.from({ length: 19 }, (_, k) => `i + ${k} AS c${k}`).join(', ');
    const r = await db.queryRaw(
      `SELECT TOP 25000 ROW_NUMBER() OVER (ORDER BY (SELECT 1)) AS i, ${cols}
       FROM (SELECT ROW_NUMBER() OVER (ORDER BY (SELECT 1)) AS i FROM sys.all_objects a CROSS JOIN sys.all_objects b) q ORDER BY 1`,
    );
    const rows = r.results[0]!;
    expect(rows).toHaveLength(25000);
    expect(rows.every((row, n) => row[0] === n + 1)).toBe(true);
  });

  it('a wide nvarchar(4000) value is bound without truncation', async () => {
    const r = await db.query("SELECT CAST(REPLICATE(N'ü', 4000) AS nvarchar(4000)) AS w, 1 AS n");
    expect(r.first[0]!['w']).toBe('ü'.repeat(4000));
  });

  it('an error part way through a large result still rejects', async () => {
    await expect(
      db.query(`SELECT i, 1 / (3000 - i) AS boom FROM (${SELECT}) q ORDER BY i`),
    ).rejects.toThrow(/Divide by zero/);
    expect((await db.query('SELECT 1 AS ok')).first).toEqual([{ ok: 1 }]);
  });
});
