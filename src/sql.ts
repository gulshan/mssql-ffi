// sql.ts - typed parameter helpers, msnodesqlv8 style: sql.Int(5), sql.NVarChar('x', 50)
import type { SqlTypeName, TypedParam } from './types.ts';

const TYPED: unique symbol = Symbol('mssql-ffi.typed');

class Typed implements TypedParam {
  readonly [TYPED] = true;
  readonly type: SqlTypeName;
  readonly value: unknown;
  readonly length: number | undefined;
  readonly precision: number | undefined;
  readonly scale: number | undefined;

  constructor(
    type: SqlTypeName,
    value: unknown,
    length?: number,
    precision?: number,
    scale?: number,
  ) {
    this.type = type;
    this.value = value;
    this.length = length;
    this.precision = precision;
    this.scale = scale;
  }
}

export function isTypedParam(v: unknown): v is TypedParam {
  return typeof v === 'object' && v !== null && TYPED in v;
}

/** Creates a typed parameter. Prefer the `sql.*` helpers. */
export function typed(
  type: SqlTypeName,
  value: unknown,
  options: { length?: number; precision?: number; scale?: number } = {},
): TypedParam {
  return new Typed(type, value, options.length, options.precision, options.scale);
}

type Plain = (value: unknown) => TypedParam;
type Sized = (value: unknown, length?: number) => TypedParam;
type Scaled = (value: unknown, scale?: number) => TypedParam;
type Exact = (value: unknown, precision?: number, scale?: number) => TypedParam;

const plain =
  (type: SqlTypeName): Plain =>
  (value) =>
    typed(type, value);
const sized =
  (type: SqlTypeName): Sized =>
  (value, length) =>
    typed(type, value, length === undefined ? {} : { length });
const scaled =
  (type: SqlTypeName): Scaled =>
  (value, scale) =>
    typed(type, value, scale === undefined ? {} : { scale });
const exact =
  (type: SqlTypeName): Exact =>
  (value, precision = 38, scale = 0) =>
    typed(type, value, { precision, scale });

export interface SqlTypes {
  Bit: Plain;
  TinyInt: Plain;
  SmallInt: Plain;
  Int: Plain;
  BigInt: Plain;
  Float: Plain;
  Real: Plain;
  Decimal: Exact;
  Numeric: Exact;
  Money: Plain;
  SmallMoney: Plain;
  Char: Sized;
  VarChar: Sized;
  Text: Plain;
  NChar: Sized;
  NVarChar: Sized;
  NText: Plain;
  Xml: Plain;
  Binary: Sized;
  VarBinary: Sized;
  Image: Plain;
  UniqueIdentifier: Plain;
  Date: Plain;
  Time: Scaled;
  DateTime: Plain;
  DateTime2: Scaled;
  SmallDateTime: Plain;
  DateTimeOffset: Scaled;
}

/** Typed parameter helpers. Untyped values are inferred; use these to force a SQL type. */
export const sql: SqlTypes = {
  Bit: plain('bit'),
  TinyInt: plain('tinyint'),
  SmallInt: plain('smallint'),
  Int: plain('int'),
  BigInt: plain('bigint'),
  Float: plain('float'),
  Real: plain('real'),
  Decimal: exact('decimal'),
  Numeric: exact('numeric'),
  Money: plain('money'),
  SmallMoney: plain('smallmoney'),
  Char: sized('char'),
  VarChar: sized('varchar'),
  Text: plain('text'),
  NChar: sized('nchar'),
  NVarChar: sized('nvarchar'),
  NText: plain('ntext'),
  Xml: plain('xml'),
  Binary: sized('binary'),
  VarBinary: sized('varbinary'),
  Image: plain('image'),
  UniqueIdentifier: plain('uniqueidentifier'),
  Date: plain('date'),
  Time: scaled('time'),
  DateTime: plain('datetime'),
  DateTime2: scaled('datetime2'),
  SmallDateTime: plain('smalldatetime'),
  DateTimeOffset: scaled('datetimeoffset'),
};
