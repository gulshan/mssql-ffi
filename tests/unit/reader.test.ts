import { describe, expect, it } from 'vitest';
import * as C from '../../src/odbc/constants.ts';
import { decodeAt, layoutOf } from '../../src/odbc/reader.ts';

describe('layoutOf', () => {
  it('binds fixed-size kinds', () => {
    expect(layoutOf('int', 10, C.SQL_INTEGER)).toEqual({ cType: C.SQL_C_SLONG, width: 4 });
    expect(layoutOf('decimal', 18, C.SQL_DECIMAL)).toEqual({ cType: C.SQL_C_CHAR, width: 21 });
    expect(layoutOf('datetimeoffset', 34, C.SQL_SS_TIMESTAMPOFFSET)?.width).toBe(20);
  });

  it('binds bounded text/binary, not (max) or sql_variant', () => {
    expect(layoutOf('text', 50, C.SQL_WVARCHAR)).toEqual({ cType: C.SQL_C_WCHAR, width: 102 });
    expect(layoutOf('text', 4000, C.SQL_WVARCHAR)?.width).toBe(8002);
    expect(layoutOf('text', 0, C.SQL_WVARCHAR)).toBeUndefined();
    expect(layoutOf('text', 8000, C.SQL_VARCHAR)).toBeUndefined();
    expect(layoutOf('text', 8000, C.SQL_SS_VARIANT)).toBeUndefined();
    expect(layoutOf('binary', 16, C.SQL_VARBINARY)).toEqual({ cType: C.SQL_C_BINARY, width: 16 });
    expect(layoutOf('binary', 0, C.SQL_VARBINARY)).toBeUndefined();
  });
});

describe('decodeAt', () => {
  it('decodes values at an offset', () => {
    const b = Buffer.alloc(64);
    b.writeInt32LE(-42, 8);
    expect(decodeAt(b, 8, 'int', 4)).toBe(-42);
    b.write('.50', 16, 'latin1');
    expect(decodeAt(b, 16, 'decimal', 3)).toBe('0.50');
    b.write('hé', 24, 'utf16le');
    expect(decodeAt(b, 24, 'text', 4)).toBe('hé');
    b.writeInt16LE(2024, 32);
    b.writeUInt16LE(2, 34);
    b.writeUInt16LE(29, 36);
    expect(decodeAt(b, 32, 'date', 6)).toEqual([2024, 2, 29]);
  });

  it('copies binary values into their own ArrayBuffer', () => {
    const b = Buffer.from([1, 2, 3, 4]);
    const v = decodeAt(b, 1, 'binary', 2) as Uint8Array;
    expect([...v]).toEqual([2, 3]);
    expect(v.buffer).not.toBe(b.buffer);
    expect(v.byteLength).toBe(v.buffer.byteLength);
  });
});
