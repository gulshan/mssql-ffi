// params.ts - wire parameters -> ODBC bindings (SQLBindParameter).
import type { SqlTypeName, WireParam } from '../types.ts';
import * as C from './constants.ts';
import { odbc } from './ffi.ts';
import { check, ok } from './handles.ts';
import type { Handle } from './handles.ts';

export interface Binding {
  cType: number;
  sqlType: number;
  /** ColumnSize argument. 0 means (max) for variable length types. */
  size: number;
  digits: number;
  /** Must stay alive until the statement has executed. */
  data: Buffer;
  ind: Buffer;
}

/** The SQL type a NULL is bound as when nothing better is known. */
export interface DescribedParam {
  sqlType: number;
  size: number;
  digits: number;
}

interface TypeSpec {
  cType: number;
  sqlType: number;
}

const SPECS: Record<SqlTypeName, TypeSpec> = {
  bit: { cType: C.SQL_C_BIT, sqlType: C.SQL_BIT },
  tinyint: { cType: C.SQL_C_SLONG, sqlType: C.SQL_TINYINT },
  smallint: { cType: C.SQL_C_SLONG, sqlType: C.SQL_SMALLINT },
  int: { cType: C.SQL_C_SLONG, sqlType: C.SQL_INTEGER },
  bigint: { cType: C.SQL_C_SBIGINT, sqlType: C.SQL_BIGINT },
  float: { cType: C.SQL_C_DOUBLE, sqlType: C.SQL_FLOAT },
  real: { cType: C.SQL_C_DOUBLE, sqlType: C.SQL_REAL },
  decimal: { cType: C.SQL_C_CHAR, sqlType: C.SQL_DECIMAL },
  numeric: { cType: C.SQL_C_CHAR, sqlType: C.SQL_NUMERIC },
  money: { cType: C.SQL_C_CHAR, sqlType: C.SQL_DECIMAL },
  smallmoney: { cType: C.SQL_C_CHAR, sqlType: C.SQL_DECIMAL },
  char: { cType: C.SQL_C_WCHAR, sqlType: C.SQL_CHAR },
  varchar: { cType: C.SQL_C_WCHAR, sqlType: C.SQL_VARCHAR },
  text: { cType: C.SQL_C_WCHAR, sqlType: C.SQL_LONGVARCHAR },
  nchar: { cType: C.SQL_C_WCHAR, sqlType: C.SQL_WCHAR },
  nvarchar: { cType: C.SQL_C_WCHAR, sqlType: C.SQL_WVARCHAR },
  ntext: { cType: C.SQL_C_WCHAR, sqlType: C.SQL_WLONGVARCHAR },
  xml: { cType: C.SQL_C_WCHAR, sqlType: C.SQL_SS_XML },
  binary: { cType: C.SQL_C_BINARY, sqlType: C.SQL_BINARY },
  varbinary: { cType: C.SQL_C_BINARY, sqlType: C.SQL_VARBINARY },
  image: { cType: C.SQL_C_BINARY, sqlType: C.SQL_LONGVARBINARY },
  uniqueidentifier: { cType: C.SQL_C_WCHAR, sqlType: C.SQL_GUID },
  date: { cType: C.SQL_C_TYPE_DATE, sqlType: C.SQL_TYPE_DATE },
  time: { cType: C.SQL_C_SS_TIME2, sqlType: C.SQL_SS_TIME2 },
  datetime: { cType: C.SQL_C_TYPE_TIMESTAMP, sqlType: C.SQL_TYPE_TIMESTAMP },
  datetime2: { cType: C.SQL_C_TYPE_TIMESTAMP, sqlType: C.SQL_TYPE_TIMESTAMP },
  smalldatetime: { cType: C.SQL_C_TYPE_TIMESTAMP, sqlType: C.SQL_TYPE_TIMESTAMP },
  datetimeoffset: { cType: C.SQL_C_SS_TIMESTAMPOFFSET, sqlType: C.SQL_SS_TIMESTAMPOFFSET },
};

const BINARY_TYPES: ReadonlySet<number> = new Set([
  C.SQL_BINARY,
  C.SQL_VARBINARY,
  C.SQL_LONGVARBINARY,
  C.SQL_SS_UDT,
]);

function indicator(n: number | bigint): Buffer {
  const ind = Buffer.alloc(8);
  ind.writeBigInt64LE(BigInt(n));
  return ind;
}

/** Truncates nanoseconds to `scale` fractional digits (the driver rejects extra precision). */
export function truncateFraction(ns: number, scale: number): number {
  const unit = 10 ** (9 - Math.min(Math.max(scale, 0), 9));
  return ns - (ns % unit);
}

function nullBinding(described: DescribedParam | undefined): Binding {
  const sqlType = described?.sqlType ?? C.SQL_VARCHAR;
  return {
    cType: BINARY_TYPES.has(sqlType) ? C.SQL_C_BINARY : C.SQL_C_WCHAR,
    sqlType,
    size: described ? described.size : 1,
    digits: described?.digits ?? 0,
    data: Buffer.alloc(2),
    ind: indicator(C.SQL_NULL_DATA),
  };
}

function numbers(value: unknown, n: number, type: string): number[] {
  if (!Array.isArray(value) || value.length < n) throw new TypeError(`invalid ${type} parameter`);
  return value as number[];
}

/** Pure: builds the SQLBindParameter arguments for one parameter. */
export function binding(p: WireParam, described?: DescribedParam): Binding {
  if (p.type === undefined || p.value === null) {
    if (p.type === undefined) return nullBinding(described);
    const { sqlType } = SPECS[p.type];
    return nullBinding({ sqlType, size: p.length ?? (p.precision || 1), digits: p.scale ?? 0 });
  }
  const { cType, sqlType } = SPECS[p.type];
  const v = p.value;
  switch (p.type) {
    case 'bit':
      return {
        cType,
        sqlType,
        size: 1,
        digits: 0,
        data: Buffer.from([v ? 1 : 0]),
        ind: indicator(1),
      };
    case 'tinyint':
    case 'smallint':
    case 'int': {
      const data = Buffer.alloc(4);
      data.writeInt32LE(Number(v));
      return { cType, sqlType, size: 10, digits: 0, data, ind: indicator(4) };
    }
    case 'bigint': {
      const data = Buffer.alloc(8);
      data.writeBigInt64LE(BigInt(v as bigint | number));
      return { cType, sqlType, size: 19, digits: 0, data, ind: indicator(8) };
    }
    case 'float':
    case 'real': {
      const data = Buffer.alloc(8);
      data.writeDoubleLE(Number(v));
      return {
        cType,
        sqlType,
        size: p.type === 'real' ? 24 : 53,
        digits: 0,
        data,
        ind: indicator(8),
      };
    }
    case 'decimal':
    case 'numeric':
    case 'money':
    case 'smallmoney': {
      const s = String(v);
      const data = Buffer.from(`${s}\0`, 'latin1');
      const size = p.type === 'money' ? 19 : p.type === 'smallmoney' ? 10 : (p.precision ?? 38);
      const digits = p.type.endsWith('money') ? 4 : (p.scale ?? decimalScale(s));
      return { cType, sqlType, size, digits, data, ind: indicator(s.length) };
    }
    case 'binary':
    case 'varbinary':
    case 'image': {
      const bytes = v as Uint8Array;
      const data = Buffer.alloc(Math.max(bytes.length, 1));
      data.set(bytes);
      const max = p.type === 'image' || bytes.length > 8000;
      const size = p.length ?? (max ? 0 : Math.max(bytes.length, 1));
      return { cType, sqlType, size, digits: 0, data, ind: indicator(bytes.length) };
    }
    case 'date': {
      const [y, m, d] = numbers(v, 3, 'date');
      const data = Buffer.alloc(6);
      data.writeInt16LE(y!, 0);
      data.writeUInt16LE(m!, 2);
      data.writeUInt16LE(d!, 4);
      return { cType, sqlType, size: 10, digits: 0, data, ind: indicator(6) };
    }
    case 'time': {
      const [h, mi, s, ns] = numbers(v, 4, 'time');
      const scale = p.scale ?? 7;
      const data = Buffer.alloc(12);
      data.writeUInt16LE(h!, 0);
      data.writeUInt16LE(mi!, 2);
      data.writeUInt16LE(s!, 4);
      data.writeUInt32LE(truncateFraction(ns!, scale), 8);
      return {
        cType,
        sqlType,
        size: scale ? 9 + scale : 8,
        digits: scale,
        data,
        ind: indicator(12),
      };
    }
    case 'datetime':
    case 'datetime2':
    case 'smalldatetime':
    case 'datetimeoffset': {
      const parts = numbers(v, p.type === 'datetimeoffset' ? 8 : 7, p.type);
      const [y, mo, d, h, mi, s, ns] = parts as [
        number,
        number,
        number,
        number,
        number,
        number,
        number,
      ];
      const offset = p.type === 'datetimeoffset';
      const scale = p.type === 'datetime' ? 3 : p.type === 'smalldatetime' ? 0 : (p.scale ?? 7);
      const small = p.type === 'smalldatetime';
      const data = Buffer.alloc(offset ? 20 : 16);
      data.writeInt16LE(y, 0);
      data.writeUInt16LE(mo, 2);
      data.writeUInt16LE(d, 4);
      data.writeUInt16LE(h, 6);
      data.writeUInt16LE(mi, 8);
      data.writeUInt16LE(small ? 0 : s, 10);
      data.writeUInt32LE(small ? 0 : truncateFraction(ns, scale), 12);
      let size = scale ? 20 + scale : 19; // yyyy-mm-dd hh:mm:ss[.fffffff]
      if (small) size = 16;
      if (offset) {
        const tz = parts[7]!;
        data.writeInt16LE(Math.trunc(tz / 60), 16);
        data.writeInt16LE(tz % 60, 18);
        size += 7; // " +hh:mm"
      }
      return { cType, sqlType, size, digits: scale, data, ind: indicator(data.length) };
    }
    default: {
      // char/varchar/text/nchar/nvarchar/ntext/xml/uniqueidentifier: bound as UTF-16
      const s = String(v);
      const data = Buffer.alloc(Math.max(s.length * 2, 2));
      data.write(s, 'utf16le');
      const wide = sqlType === C.SQL_WCHAR || sqlType === C.SQL_WVARCHAR;
      const limit = wide ? 4000 : 8000;
      let size = p.length ?? (s.length > limit ? 0 : Math.max(s.length, 1));
      if (p.type === 'uniqueidentifier') size = 36;
      if (
        sqlType === C.SQL_LONGVARCHAR ||
        sqlType === C.SQL_WLONGVARCHAR ||
        sqlType === C.SQL_SS_XML
      ) {
        size = 0;
      }
      return { cType, sqlType, size, digits: 0, data, ind: indicator(s.length * 2) };
    }
  }
}

function decimalScale(s: string): number {
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
}

/** Asks the driver for a parameter's type (needs a prepared statement). */
export function describeParam(stmt: Handle, num: number): DescribedParam | undefined {
  const type = Buffer.alloc(2);
  const size = Buffer.alloc(8);
  const digits = Buffer.alloc(2);
  const nullable = Buffer.alloc(2);
  if (!ok(odbc().SQLDescribeParam(stmt, num, type, size, digits, nullable))) return undefined;
  return {
    sqlType: type.readInt16LE(0),
    size: Number(size.readBigUInt64LE(0)),
    digits: digits.readInt16LE(0),
  };
}

/**
 * Binds every parameter. The returned bindings own the buffers the driver reads
 * from, so they must stay referenced until the statement has executed.
 */
export function bindParams(
  stmt: Handle,
  params: readonly WireParam[],
  describe: boolean,
): Binding[] {
  const api = odbc();
  return params.map((p, i) => {
    const described = describe && p.type === undefined ? describeParam(stmt, i + 1) : undefined;
    const b = binding(p, described);
    check(
      api.SQLBindParameter(
        stmt,
        i + 1,
        C.SQL_PARAM_INPUT,
        b.cType,
        b.sqlType,
        BigInt(b.size),
        b.digits,
        b.data,
        BigInt(b.data.length),
        b.ind,
      ),
      C.SQL_HANDLE_STMT,
      stmt,
      `SQLBindParameter(${i + 1})`,
    );
    return b;
  });
}
