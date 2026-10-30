import { describe, expect, it } from 'vitest';
import { decimalString, encodeParam, encodeParams } from '../../src/params.ts';
import { sql } from '../../src/sql.ts';

describe('encodeParam inference', () => {
  it.each([
    [null, { type: undefined, value: null }],
    [undefined, { type: undefined, value: null }],
    [true, { type: 'bit', value: true }],
    [42, { type: 'int', value: 42 }],
    [-(2 ** 31), { type: 'int', value: -(2 ** 31) }],
    [2 ** 31, { type: 'bigint', value: 2n ** 31n }],
    [1.5, { type: 'float', value: 1.5 }],
    [2 ** 60, { type: 'float', value: 2 ** 60 }],
    [9007199254740993n, { type: 'bigint', value: 9007199254740993n }],
    ['héllo', { type: 'nvarchar', value: 'héllo' }],
  ])('%s', (input, expected) => {
    expect(encodeParam(input)).toEqual(expected);
  });

  it('binary', () => {
    const b = Buffer.from([1, 2, 3]);
    expect(encodeParam(b)).toEqual({ type: 'varbinary', value: b });
  });

  it('Date is bound as its UTC wall clock in datetime2', () => {
    expect(encodeParam(new Date('2024-02-29T23:59:58.123Z'))).toEqual({
      type: 'datetime2',
      value: [2024, 2, 29, 23, 59, 58, 123_000_000],
    });
  });

  it('Temporal values', () => {
    expect(encodeParam(Temporal.PlainDate.from('2024-01-02')).value).toEqual([2024, 1, 2]);
    expect(encodeParam(Temporal.PlainTime.from('13:14:15.123456789'))).toEqual({
      type: 'time',
      value: [13, 14, 15, 123456789],
    });
    expect(encodeParam(Temporal.PlainDateTime.from('2024-01-02T03:04:05.5')).value).toEqual([
      2024, 1, 2, 3, 4, 5, 500_000_000,
    ]);
    expect(encodeParam(Temporal.ZonedDateTime.from('2024-01-02T03:04:05-05:30[-05:30]'))).toEqual({
      type: 'datetimeoffset',
      value: [2024, 1, 2, 3, 4, 5, 0, -330],
    });
    expect(encodeParam(Temporal.Instant.from('2024-01-02T03:04:05Z')).value).toEqual([
      2024, 1, 2, 3, 4, 5, 0, 0,
    ]);
  });

  it.each([[Number.NaN], [Number.POSITIVE_INFINITY], [2n ** 63n], [new Date('nope')]])(
    'rejects %s',
    (v) => {
      expect(() => encodeParam(v)).toThrow(RangeError);
    },
  );

  it('rejects unsupported objects', () => {
    expect(() => encodeParam({} as never)).toThrow(TypeError);
  });

  it('encodeParams handles undefined', () => {
    expect(encodeParams(undefined)).toEqual([]);
  });
});

describe('typed params', () => {
  it('carries length/precision/scale', () => {
    expect(encodeParam(sql.NVarChar('x', 50))).toEqual({
      type: 'nvarchar',
      value: 'x',
      length: 50,
      precision: undefined,
      scale: undefined,
    });
    expect(encodeParam(sql.Decimal(1.25, 10, 2))).toMatchObject({
      type: 'decimal',
      value: '1.25',
      precision: 10,
      scale: 2,
    });
  });

  it('typed NULL keeps its type', () => {
    expect(encodeParam(sql.VarBinary(null))).toMatchObject({ type: 'varbinary', value: null });
  });

  it('validates integer ranges', () => {
    expect(() => encodeParam(sql.TinyInt(256))).toThrow(RangeError);
    expect(() => encodeParam(sql.Int(1.5))).toThrow(RangeError);
    expect(encodeParam(sql.SmallInt(-32768)).value).toBe(-32768);
    expect(encodeParam(sql.BigInt('9223372036854775807')).value).toBe(9223372036854775807n);
  });

  it('converts date/time inputs', () => {
    expect(encodeParam(sql.Date('2024-05-06')).value).toEqual([2024, 5, 6]);
    expect(encodeParam(sql.Time('01:02:03')).value).toEqual([1, 2, 3, 0]);
    expect(encodeParam(sql.DateTime('2024-05-06T07:08:09')).value).toEqual([
      2024, 5, 6, 7, 8, 9, 0,
    ]);
    expect(encodeParam(sql.DateTimeOffset('2024-05-06T07:08:09+02:00')).value).toEqual([
      2024, 5, 6, 5, 8, 9, 0, 0,
    ]);
    expect(encodeParam(sql.DateTimeOffset('2024-05-06T07:08:09+02:00[+02:00]')).value).toEqual([
      2024, 5, 6, 7, 8, 9, 0, 120,
    ]);
  });

  it('rejects non-binary values for binary types', () => {
    expect(() => encodeParam(sql.VarBinary('abc'))).toThrow(TypeError);
  });
});

describe('decimalString', () => {
  it.each([
    ['12.50', '12.50'],
    [' -0.5 ', '-0.5'],
    [12.5, '12.5'],
    [1e-7, '0.0000001'],
    [1e21, '1000000000000000000000'],
    [123n, '123'],
  ])('%s -> %s', (input, expected) => {
    expect(decimalString(input)).toBe(expected);
  });

  it('rejects garbage', () => {
    expect(() => decimalString('1e5')).toThrow(TypeError);
    expect(() => decimalString(Number.NaN)).toThrow(RangeError);
  });
});
