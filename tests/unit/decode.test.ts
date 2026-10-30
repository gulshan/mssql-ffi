import { describe, expect, it } from 'vitest';
import { kindOf, normalizeDecimal } from '../../src/odbc/columns.ts';
import * as C from '../../src/odbc/constants.ts';
import { decodeRawRows, decodeRows } from '../../src/decode.ts';
import type { DecodeOptions } from '../../src/decode.ts';
import type { ColumnMeta, Kind, WireResultSet, WireValue } from '../../src/types.ts';

const defaults: DecodeOptions = { useNumericNumber: false, useBigIntAsNative: false };

function set(
  kinds: Kind[],
  rows: WireValue[][],
  names = kinds.map((_, i) => `c${i}`),
): WireResultSet {
  const meta = names.map((name): ColumnMeta => ({
    name,
    type: '',
    sqlType: 0,
    size: 0,
    scale: 0,
    nullable: true,
  }));
  return { meta, kinds, rows };
}

describe('decodeRows', () => {
  it('passes simple values through and keeps NULL', () => {
    const rows = decodeRows(
      set(
        ['int', 'text', 'bool'],
        [
          [1, 'a', true],
          [null, null, null],
        ],
      ),
      defaults,
    );
    expect(rows).toEqual([
      { c0: 1, c1: 'a', c2: true },
      { c0: null, c1: null, c2: null },
    ]);
  });

  it('bigint: number when safe unless useBigIntAsNative', () => {
    const s = set(['bigint'], [[5n], [2n ** 60n]]);
    expect(decodeRawRows(s, defaults)).toEqual([[5], [2n ** 60n]]);
    expect(decodeRawRows(s, { ...defaults, useBigIntAsNative: true })).toEqual([[5n], [2n ** 60n]]);
  });

  it('decimal: string unless useNumericNumber', () => {
    const s = set(['decimal'], [['1.50']]);
    expect(decodeRawRows(s, defaults)).toEqual([['1.50']]);
    expect(decodeRawRows(s, { ...defaults, useNumericNumber: true })).toEqual([[1.5]]);
  });

  it('date/time kinds become Temporal values', () => {
    const [row] = decodeRawRows(
      set(
        ['date', 'time', 'datetime', 'datetimeoffset'],
        [
          [
            [2024, 2, 29],
            [1, 2, 3, 123456700],
            [2024, 2, 29, 1, 2, 3, 500_000_000],
            [2024, 2, 29, 1, 2, 3, 0, -330],
          ],
        ],
      ),
      defaults,
    );
    const [d, t, dt, dto] = row!;
    expect(d).toBeInstanceOf(Temporal.PlainDate);
    expect(String(d)).toBe('2024-02-29');
    expect(String(t)).toBe('01:02:03.1234567');
    expect(String(dt)).toBe('2024-02-29T01:02:03.5');
    expect(dto).toBeInstanceOf(Temporal.ZonedDateTime);
    expect((dto as Temporal.ZonedDateTime).offset).toBe('-05:30');
    expect((dto as Temporal.ZonedDateTime).toInstant().toString()).toBe('2024-02-29T06:32:03Z');
  });

  it('duplicate column names keep the last value', () => {
    expect(decodeRows(set(['int', 'int'], [[1, 2]], ['a', 'a']), defaults)).toEqual([{ a: 2 }]);
  });
});

describe('kindOf', () => {
  it.each([
    [C.SQL_BIT, 'bool'],
    [C.SQL_TINYINT, 'int'],
    [C.SQL_INTEGER, 'int'],
    [C.SQL_BIGINT, 'bigint'],
    [C.SQL_REAL, 'float'],
    [C.SQL_DECIMAL, 'decimal'],
    [C.SQL_NUMERIC, 'decimal'],
    [C.SQL_GUID, 'guid'],
    [C.SQL_VARBINARY, 'binary'],
    [C.SQL_SS_UDT, 'binary'],
    [C.SQL_TYPE_DATE, 'date'],
    [C.SQL_SS_TIME2, 'time'],
    [C.SQL_TYPE_TIMESTAMP, 'datetime'],
    [C.SQL_SS_TIMESTAMPOFFSET, 'datetimeoffset'],
    [C.SQL_WVARCHAR, 'text'],
    [C.SQL_SS_XML, 'text'],
  ])('%i -> %s', (sqlType, kind) => {
    expect(kindOf(sqlType)).toBe(kind);
  });
});

describe('normalizeDecimal', () => {
  it.each([
    ['.5', '0.5'],
    ['-.5', '-0.5'],
    ['12.5', '12.5'],
    ['-1', '-1'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeDecimal(input)).toBe(expected);
  });
});
