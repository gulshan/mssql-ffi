// types.ts - public types and the wire format shared by the main thread and the worker.

/** SQL Server type names understood by typed parameters (see `sql.*`). */
export type SqlTypeName =
  | 'bit'
  | 'tinyint'
  | 'smallint'
  | 'int'
  | 'bigint'
  | 'float'
  | 'real'
  | 'decimal'
  | 'numeric'
  | 'money'
  | 'smallmoney'
  | 'char'
  | 'varchar'
  | 'text'
  | 'nchar'
  | 'nvarchar'
  | 'ntext'
  | 'xml'
  | 'binary'
  | 'varbinary'
  | 'image'
  | 'uniqueidentifier'
  | 'date'
  | 'time'
  | 'datetime'
  | 'datetime2'
  | 'smalldatetime'
  | 'datetimeoffset';

/** A parameter with an explicit SQL type, created by the `sql.*` helpers. */
export interface TypedParam {
  readonly type: SqlTypeName;
  readonly value: unknown;
  /** Character/byte length for string and binary types. */
  readonly length?: number | undefined;
  /** Precision for decimal/numeric. */
  readonly precision?: number | undefined;
  /** Scale for decimal/numeric, fractional second digits for time/datetime2/datetimeoffset. */
  readonly scale?: number | undefined;
}

/** Values accepted as query parameters. */
export type Param =
  | string
  | number
  | bigint
  | boolean
  | Date
  | Uint8Array
  | Temporal.PlainDate
  | Temporal.PlainTime
  | Temporal.PlainDateTime
  | Temporal.ZonedDateTime
  | Temporal.Instant
  | TypedParam
  | null
  | undefined;

/** Values returned in result rows. */
export type Value =
  | string
  | number
  | bigint
  | boolean
  | Uint8Array
  | Temporal.PlainDate
  | Temporal.PlainTime
  | Temporal.PlainDateTime
  | Temporal.ZonedDateTime
  | null;

export type Row = Record<string, Value>;

/** Column metadata of a result set. */
export interface ColumnMeta {
  name: string;
  /** SQL Server type name, e.g. `nvarchar`, `datetime2`. */
  type: string;
  /** ODBC SQL type code. */
  sqlType: number;
  /** Column size (characters, bytes or precision depending on the type). */
  size: number;
  /** Decimal digits (scale or fractional seconds precision). */
  scale: number;
  nullable: boolean;
}

interface ResultBase {
  /** Column metadata, one entry per result set. */
  meta: ColumnMeta[][];
  /** Row counts of statements that returned no columns (INSERT/UPDATE/DELETE...). */
  counts: number[];
  /** Informational messages (PRINT, RAISERROR with severity <= 10). */
  info: string[];
}

export interface QueryResult<T = Row> extends ResultBase {
  /** Rows of the first result set (empty if there was none). */
  first: T[];
  /** Rows of every result set. */
  results: T[][];
}

export interface RawResult extends ResultBase {
  /** Rows as positional arrays, one array per result set. */
  results: Value[][][];
}

export interface ProcResult<T = Row> extends QueryResult<T> {
  /** Output parameters by name (without the `@`). */
  output: Record<string, Value>;
  /** The procedure's return code. */
  returns: number;
}

export interface QueryOptions {
  /** Cancels the statement (via SQLCancel) when the signal aborts. */
  signal?: AbortSignal | undefined;
  /** Cancels the statement after this many milliseconds. */
  timeoutMs?: number | undefined;
}

export interface ConnectionOptions {
  /** Return decimal/numeric/money columns as `number` instead of a lossless `string`. */
  useNumericNumber?: boolean | undefined;
  /** Return bigint columns always as `bigint` (default: `number` when it is a safe integer). */
  useBigIntAsNative?: boolean | undefined;
  /** Seconds to wait for the login to complete. */
  loginTimeoutSecs?: number | undefined;
}

export type IsolationLevel =
  | 'READ UNCOMMITTED'
  | 'READ COMMITTED'
  | 'REPEATABLE READ'
  | 'SERIALIZABLE'
  | 'SNAPSHOT';

export interface TransactionOptions {
  isolationLevel?: IsolationLevel | undefined;
}

// ---------------------------------------------------------------------------
// Wire format (structured-clone safe; Temporal values travel as number tuples)

/** How a column value is read in the worker and decoded on the main thread. */
export type Kind =
  | 'bool'
  | 'int'
  | 'bigint'
  | 'float'
  | 'decimal'
  | 'guid'
  | 'text'
  | 'binary'
  | 'date'
  | 'time'
  | 'datetime'
  | 'datetimeoffset';

/**
 * Date/time tuples:
 * - date: [year, month, day]
 * - time: [hour, minute, second, nanosecond]
 * - datetime: [year, month, day, hour, minute, second, nanosecond]
 * - datetimeoffset: datetime + [offsetMinutes]
 */
export type WireValue = null | boolean | number | bigint | string | Uint8Array | number[];

export interface WireParam {
  /** Undefined only for an untyped NULL; the worker asks the driver for the type. */
  type: SqlTypeName | undefined;
  value: WireValue;
  length?: number | undefined;
  precision?: number | undefined;
  scale?: number | undefined;
}

export interface WireResultSet {
  meta: ColumnMeta[];
  kinds: Kind[];
  rows: WireValue[][];
}

export interface WireQueryResult {
  results: WireResultSet[];
  counts: number[];
  info: string[];
}
