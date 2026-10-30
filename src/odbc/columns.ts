// columns.ts - result set description and per-value reads (SQLGetData).
import type { ColumnMeta, Kind } from '../types.ts';
import * as C from './constants.ts';
import { odbc } from './ffi.ts';
import { check, ok } from './handles.ts';
import type { Handle } from './handles.ts';

/** Maps an ODBC SQL type to how its values are read and decoded. */
export function kindOf(sqlType: number): Kind {
  switch (sqlType) {
    case C.SQL_BIT:
      return 'bool';
    case C.SQL_TINYINT:
    case C.SQL_SMALLINT:
    case C.SQL_INTEGER:
      return 'int';
    case C.SQL_BIGINT:
      return 'bigint';
    case C.SQL_REAL:
    case C.SQL_FLOAT:
    case C.SQL_DOUBLE:
      return 'float';
    case C.SQL_DECIMAL:
    case C.SQL_NUMERIC:
      return 'decimal';
    case C.SQL_GUID:
      return 'guid';
    case C.SQL_BINARY:
    case C.SQL_VARBINARY:
    case C.SQL_LONGVARBINARY:
    case C.SQL_SS_UDT:
      return 'binary';
    case C.SQL_TYPE_DATE:
      return 'date';
    case C.SQL_TYPE_TIME:
    case C.SQL_SS_TIME2:
      return 'time';
    case C.SQL_TYPE_TIMESTAMP:
      return 'datetime';
    case C.SQL_SS_TIMESTAMPOFFSET:
      return 'datetimeoffset';
    default:
      return 'text'; // char, wchar, xml, sql_variant ...
  }
}

export interface Columns {
  meta: ColumnMeta[];
  kinds: Kind[];
}

/** Describes the columns of the current result set (empty if it has none). */
export function describeColumns(stmt: Handle): Columns {
  const api = odbc();
  const nc = Buffer.alloc(2);
  check(api.SQLNumResultCols(stmt, nc), C.SQL_HANDLE_STMT, stmt, 'SQLNumResultCols');
  const count = nc.readInt16LE(0);
  const meta: ColumnMeta[] = [];
  const kinds: Kind[] = [];
  const name = Buffer.alloc(514);
  const nameLen = Buffer.alloc(2);
  const type = Buffer.alloc(2);
  const size = Buffer.alloc(8);
  const digits = Buffer.alloc(2);
  const nullable = Buffer.alloc(2);
  const typeName = Buffer.alloc(258);
  const typeNameLen = Buffer.alloc(2);
  const numAttr = Buffer.alloc(8);
  for (let c = 1; c <= count; c++) {
    check(
      api.SQLDescribeColW(stmt, c, name, 257, nameLen, type, size, digits, nullable),
      C.SQL_HANDLE_STMT,
      stmt,
      'SQLDescribeColW',
    );
    const typeRc = api.SQLColAttributeW(
      stmt,
      c,
      C.SQL_DESC_TYPE_NAME,
      typeName,
      typeName.length,
      typeNameLen,
      numAttr,
    );
    const sqlType = type.readInt16LE(0);
    meta.push({
      name: name.toString('utf16le', 0, Math.min(nameLen.readInt16LE(0), 256) * 2),
      type: ok(typeRc)
        ? typeName.toString('utf16le', 0, Math.min(typeNameLen.readInt16LE(0), 256))
        : '',
      sqlType,
      size: Number(size.readBigUInt64LE(0)),
      scale: digits.readInt16LE(0),
      nullable: nullable.readInt16LE(0) === 1,
    });
    kinds.push(kindOf(sqlType));
  }
  return { meta, kinds };
}

/** SQL Server renders 0.5 as ".5" and -0.5 as "-.5"; add the leading zero back. */
export function normalizeDecimal(s: string): string {
  if (s.startsWith('.')) return `0${s}`;
  if (s.startsWith('-.')) return `-0${s.slice(1)}`;
  return s;
}
