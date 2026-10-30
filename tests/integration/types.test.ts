import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { open, sql } from '../../src/index.ts';
import type { Connection } from '../../src/index.ts';
import { connectionString, skip } from './helpers.ts';

describe.skipIf(skip)('type mapping', () => {
  let db: Connection;
  beforeAll(async () => {
    db = await open(connectionString);
  });
  afterAll(() => db?.close());

  const one = async (expr: string, params: unknown[] = []) =>
    (await db.query(`SELECT ${expr} AS v`, params as never)).first[0]!['v'];

  it('integers, bit, floats', async () => {
    expect(await one('CAST(255 AS tinyint)')).toBe(255);
    expect(await one('CAST(-32768 AS smallint)')).toBe(-32768);
    expect(await one('CAST(2147483647 AS int)')).toBe(2147483647);
    expect(await one('CAST(9007199254740991 AS bigint)')).toBe(9007199254740991);
    expect(await one('CAST(9223372036854775807 AS bigint)')).toBe(9223372036854775807n);
    expect(await one('CAST(1 AS bit)')).toBe(true);
    expect(await one('CAST(0.5 AS real)')).toBe(0.5);
    expect(await one('CAST(1.25 AS float)')).toBe(1.25);
  });

  it('decimal, numeric and money are lossless strings', async () => {
    expect(await one('CAST(12345678901234567890.123456789 AS decimal(38,9))')).toBe(
      '12345678901234567890.123456789',
    );
    expect(await one('CAST(0.5 AS decimal(5,2))')).toBe('0.50');
    expect(await one('CAST(-0.5 AS numeric(5,2))')).toBe('-0.50');
    expect(await one('CAST(12.3456 AS money)')).toBe('12.3456');
  });

  it('useNumericNumber returns numbers', async () => {
    await using c = await open(connectionString, { useNumericNumber: true });
    const r = await c.query('SELECT CAST(1.5 AS decimal(5,2)) AS v');
    expect(r.first[0]!['v']).toBe(1.5);
  });

  it('strings: varchar, nvarchar, unicode, xml', async () => {
    expect(await one("CAST('abc' AS varchar(10))")).toBe('abc');
    expect(await one("CAST('abc' AS char(5))")).toBe('abc  ');
    expect(await one("N'héllo 🌍'")).toBe('héllo 🌍');
    expect(await one("CAST('<a>1</a>' AS xml)")).toBe('<a>1</a>');
    expect(await one("CAST('' AS nvarchar(10))")).toBe('');
  });

  it('uniqueidentifier is a lowercase string', async () => {
    expect(await one("CAST('6F9619FF-8B86-D011-B42D-00C04FC964FF' AS uniqueidentifier)")).toBe(
      '6f9619ff-8b86-d011-b42d-00c04fc964ff',
    );
  });

  it('binary values are Uint8Array', async () => {
    const v = await one('CAST(0x0102FF AS varbinary(10))');
    expect(v).toBeInstanceOf(Uint8Array);
    expect([...(v as Uint8Array)]).toEqual([1, 2, 255]);
  });

  it('date and time types are Temporal values', async () => {
    const date = await one("CAST('2024-02-29' AS date)");
    expect(date).toBeInstanceOf(Temporal.PlainDate);
    expect(String(date)).toBe('2024-02-29');

    expect(String(await one("CAST('13:14:15.1234567' AS time(7))"))).toBe('13:14:15.1234567');
    expect(String(await one("CAST('2024-02-29T13:14:15.1234567' AS datetime2(7))"))).toBe(
      '2024-02-29T13:14:15.1234567',
    );
    expect(String(await one("CAST('2024-02-29T13:14:15.123' AS datetime)"))).toBe(
      '2024-02-29T13:14:15.123',
    );
    expect(String(await one("CAST('2024-02-29T13:14:00' AS smalldatetime)"))).toBe(
      '2024-02-29T13:14:00',
    );
    const dto = (await one(
      "CAST('2024-02-29T13:14:15.5-05:30' AS datetimeoffset(7))",
    )) as Temporal.ZonedDateTime;
    expect(dto).toBeInstanceOf(Temporal.ZonedDateTime);
    expect(dto.offset).toBe('-05:30');
    expect(dto.toInstant().toString()).toBe('2024-02-29T18:44:15.5Z');
  });

  it('large values are read in chunks', async () => {
    const big = await one("REPLICATE(CAST(N'ab' AS nvarchar(max)), 100000)");
    expect(big).toHaveLength(200_000);
    const bin = (await one(
      'CAST(REPLICATE(CAST(0x0A AS varbinary(max)), 300000) AS varbinary(max))',
    )) as Uint8Array;
    expect(bin.length).toBe(300_000);
    expect(bin.every((b) => b === 10)).toBe(true);
  });

  it('round-trips parameters through typed columns', async () => {
    const z = Temporal.ZonedDateTime.from('2024-01-02T03:04:05.1234567+02:00[+02:00]');
    const bytes = new Uint8Array(20_000).fill(7);
    const text = 'é'.repeat(5000);
    const r = await db.query(
      `DECLARE @t TABLE (
         d date, t time(7), dt datetime2(7), o datetimeoffset(7), dec decimal(18,4),
         g uniqueidentifier, b varbinary(max), s nvarchar(max), bi bigint, f float);
       INSERT INTO @t VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
       SELECT * FROM @t;`,
      [
        Temporal.PlainDate.from('2024-12-31'),
        Temporal.PlainTime.from('23:59:59.9999999'),
        Temporal.PlainDateTime.from('2024-01-02T03:04:05.1234567'),
        z,
        sql.Decimal('12345678901234.5678', 18, 4),
        sql.UniqueIdentifier('6F9619FF-8B86-D011-B42D-00C04FC964FF'),
        bytes,
        text,
        2n ** 62n,
        Math.PI,
      ],
    );
    const row = r.first[0]!;
    expect(String(row['d'])).toBe('2024-12-31');
    expect(String(row['t'])).toBe('23:59:59.9999999');
    expect(String(row['dt'])).toBe('2024-01-02T03:04:05.1234567');
    expect((row['o'] as Temporal.ZonedDateTime).equals(z)).toBe(true);
    expect(row['dec']).toBe('12345678901234.5678');
    expect(row['g']).toBe('6f9619ff-8b86-d011-b42d-00c04fc964ff');
    expect(row['b']).toEqual(bytes);
    expect(row['s']).toBe(text);
    expect(row['bi']).toBe(2n ** 62n);
    expect(row['f']).toBe(Math.PI);
  });

  it('binds a Date as its UTC wall clock', async () => {
    const v = await one('CAST(? AS datetime2(3))', [new Date('2024-06-01T12:34:56.789Z')]);
    expect(String(v)).toBe('2024-06-01T12:34:56.789');
  });

  it('binds smalldatetime/datetime/time/date typed params', async () => {
    const r = await db.query('SELECT ? AS a, ? AS b, ? AS c, ? AS d', [
      sql.SmallDateTime('2024-01-02T03:04:59'),
      sql.DateTime('2024-01-02T03:04:05.123'),
      sql.Time('01:02:03.5', 1),
      sql.Date(new Date('2024-03-04T00:00:00Z')),
    ]);
    const row = r.first[0]!;
    expect(String(row['a'])).toBe('2024-01-02T03:04:00');
    expect(String(row['b'])).toBe('2024-01-02T03:04:05.123');
    expect(String(row['c'])).toBe('01:02:03.5');
    expect(String(row['d'])).toBe('2024-03-04');
  });
});
