import { describe, expect, it } from 'vitest';
import * as C from '../../src/odbc/constants.ts';
import { binding, truncateFraction } from '../../src/odbc/params.ts';
import { encodeParam } from '../../src/params.ts';
import { sql } from '../../src/sql.ts';
import type { Param } from '../../src/types.ts';

const bind = (p: Param) => binding(encodeParam(p));
const ind = (b: { ind: Buffer }) => b.ind.readBigInt64LE(0);

describe('binding', () => {
  it('untyped NULL defaults to varchar, or the described type', () => {
    const b = bind(null);
    expect(b.sqlType).toBe(C.SQL_VARCHAR);
    expect(ind(b)).toBe(C.SQL_NULL_DATA);
    const described = binding(encodeParam(null), { sqlType: C.SQL_VARBINARY, size: 0, digits: 0 });
    expect(described.cType).toBe(C.SQL_C_BINARY);
    expect(described.sqlType).toBe(C.SQL_VARBINARY);
  });

  it('typed NULL binds as its own type', () => {
    const b = bind(sql.VarBinary(null));
    expect(b.sqlType).toBe(C.SQL_VARBINARY);
    expect(b.cType).toBe(C.SQL_C_BINARY);
    expect(ind(b)).toBe(C.SQL_NULL_DATA);
  });

  it('int and bigint', () => {
    const i = bind(-5);
    expect([i.cType, i.sqlType, i.data.readInt32LE(0)]).toEqual([C.SQL_C_SLONG, C.SQL_INTEGER, -5]);
    const b = bind(2n ** 40n);
    expect([b.cType, b.sqlType, b.data.readBigInt64LE(0)]).toEqual([
      C.SQL_C_SBIGINT,
      C.SQL_BIGINT,
      2n ** 40n,
    ]);
  });

  it('strings: UTF-16, nvarchar(max) above 4000 chars', () => {
    const b = bind('hé');
    expect(b.sqlType).toBe(C.SQL_WVARCHAR);
    expect(b.data.toString('utf16le')).toBe('hé');
    expect(ind(b)).toBe(4n);
    expect(b.size).toBe(2);
    expect(bind('x'.repeat(4001)).size).toBe(0);
    expect(bind('').size).toBe(1);
    expect(bind(sql.VarChar('x'.repeat(8001))).size).toBe(0);
    expect(bind(sql.NVarChar('abc', 100)).size).toBe(100);
    expect(bind(sql.Xml('<a/>')).size).toBe(0);
  });

  it('binary: varbinary(max) above 8000 bytes', () => {
    expect(bind(new Uint8Array(8000)).size).toBe(8000);
    expect(bind(new Uint8Array(8001)).size).toBe(0);
    const empty = bind(new Uint8Array(0));
    expect([empty.size, ind(empty)]).toEqual([1, 0n]);
  });

  it('decimal: precision and scale', () => {
    const b = bind(sql.Decimal('123.456', 10, 3));
    expect([b.cType, b.sqlType, b.size, b.digits]).toEqual([C.SQL_C_CHAR, C.SQL_DECIMAL, 10, 3]);
    expect(b.data.toString('latin1')).toBe('123.456\0');
    const m = bind(sql.Money('1.5'));
    expect([m.size, m.digits]).toEqual([19, 4]);
  });

  it('date struct', () => {
    const b = bind(Temporal.PlainDate.from('2024-12-31'));
    expect([b.data.readInt16LE(0), b.data.readUInt16LE(2), b.data.readUInt16LE(4)]).toEqual([
      2024, 12, 31,
    ]);
  });

  it('timestamp struct truncates the fraction to the type precision', () => {
    const dt = Temporal.PlainDateTime.from('2024-01-02T03:04:05.123456789');
    const d2 = bind(dt);
    expect([d2.size, d2.digits, d2.data.readUInt32LE(12)]).toEqual([27, 7, 123456700]);
    const d = bind(sql.DateTime(dt));
    expect([d.size, d.digits, d.data.readUInt32LE(12)]).toEqual([23, 3, 123000000]);
    const s = bind(sql.SmallDateTime(dt));
    expect([s.size, s.digits, s.data.readUInt16LE(10), s.data.readUInt32LE(12)]).toEqual([
      16, 0, 0, 0,
    ]);
  });

  it('datetimeoffset struct carries the offset', () => {
    const b = bind(Temporal.ZonedDateTime.from('2024-01-02T03:04:05-05:30[-05:30]'));
    expect([b.cType, b.sqlType, b.size]).toEqual([
      C.SQL_C_SS_TIMESTAMPOFFSET,
      C.SQL_SS_TIMESTAMPOFFSET,
      34,
    ]);
    expect([b.data.readInt16LE(16), b.data.readInt16LE(18)]).toEqual([-5, -30]);
  });

  it('time struct', () => {
    const b = bind(Temporal.PlainTime.from('23:59:59.9999999'));
    expect([b.data.readUInt16LE(0), b.data.readUInt16LE(4), b.data.readUInt32LE(8)]).toEqual([
      23, 59, 999999900,
    ]);
    expect([b.size, b.digits]).toEqual([16, 7]);
  });
});

describe('truncateFraction', () => {
  it.each([
    [123456789, 7, 123456700],
    [123456789, 3, 123000000],
    [123456789, 0, 0],
    [123456789, 9, 123456789],
  ])('%i at scale %i', (ns, scale, expected) => {
    expect(truncateFraction(ns, scale)).toBe(expected);
  });
});
