// params.ts - JS parameter values -> structured-clone safe wire parameters.
import { isTypedParam } from './sql.ts';
import type { Param, SqlTypeName, TypedParam, WireParam, WireValue } from './types.ts';

const INT32_MIN = -(2 ** 31);
const INT32_MAX = 2 ** 31 - 1;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

const subsecond = (t: { millisecond: number; microsecond: number; nanosecond: number }): number =>
  t.millisecond * 1_000_000 + t.microsecond * 1000 + t.nanosecond;

function dateParts(
  d: Temporal.PlainDate | Temporal.PlainDateTime | Temporal.ZonedDateTime,
): number[] {
  return [d.year, d.month, d.day];
}

function timeParts(
  t: Temporal.PlainTime | Temporal.PlainDateTime | Temporal.ZonedDateTime,
): number[] {
  return [t.hour, t.minute, t.second, subsecond(t)];
}

const utc = (d: Date): Temporal.ZonedDateTime => {
  if (Number.isNaN(d.getTime())) throw new RangeError('Invalid Date parameter');
  return Temporal.Instant.fromEpochMilliseconds(d.getTime()).toZonedDateTimeISO('UTC');
};

function toPlainDateTime(v: unknown, type: string): Temporal.PlainDateTime {
  if (v instanceof Temporal.PlainDateTime) return v;
  if (v instanceof Temporal.ZonedDateTime) return v.toPlainDateTime();
  if (v instanceof Temporal.PlainDate) return v.toPlainDateTime();
  if (v instanceof Temporal.Instant) return v.toZonedDateTimeISO('UTC').toPlainDateTime();
  if (v instanceof Date) return utc(v).toPlainDateTime();
  if (typeof v === 'string') return Temporal.PlainDateTime.from(v);
  throw new TypeError(`Cannot convert ${typeof v} to ${type}`);
}

function toZoned(v: unknown): Temporal.ZonedDateTime {
  if (v instanceof Temporal.ZonedDateTime) return v;
  if (v instanceof Temporal.Instant) return v.toZonedDateTimeISO('UTC');
  if (v instanceof Date) return utc(v);
  if (v instanceof Temporal.PlainDateTime || v instanceof Temporal.PlainDate) {
    return v.toZonedDateTime('UTC');
  }
  if (typeof v === 'string') {
    // An ISO string with an offset (and optional zone annotation) is an instant.
    return /\[.+\]$/.test(v)
      ? Temporal.ZonedDateTime.from(v)
      : Temporal.Instant.from(v).toZonedDateTimeISO('UTC');
  }
  throw new TypeError(`Cannot convert ${typeof v} to datetimeoffset`);
}

function offsetParts(z: Temporal.ZonedDateTime): number[] {
  return [...dateParts(z), ...timeParts(z), Math.round(z.offsetNanoseconds / 60e9)];
}

/** Decimal values travel as strings without exponent notation. */
export function decimalString(v: unknown): string {
  if (typeof v === 'string') {
    if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(v.trim())) throw new TypeError(`Invalid decimal '${v}'`);
    return v.trim();
  }
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new RangeError(`Invalid decimal ${v}`);
    const s = String(v);
    if (!s.includes('e')) return s;
    // Expand exponent notation: toFixed handles small numbers, BigInt large integers.
    return Math.abs(v) < 1 ? v.toFixed(20).replace(/\.?0+$/, '') : BigInt(v).toString();
  }
  throw new TypeError(`Cannot convert ${typeof v} to decimal`);
}

function int(v: unknown, type: string, min: number, max: number): number {
  const n = typeof v === 'bigint' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) {
    throw new RangeError(`Invalid ${type} value ${String(v)}`);
  }
  return n;
}

function bigint(v: unknown): bigint {
  let b: bigint;
  if (typeof v === 'bigint') b = v;
  else if (typeof v === 'number' && Number.isSafeInteger(v)) b = BigInt(v);
  else if (typeof v === 'string' && /^[+-]?\d+$/.test(v)) b = BigInt(v);
  else throw new RangeError(`Invalid bigint value ${String(v)}`);
  if (b < INT64_MIN || b > INT64_MAX) throw new RangeError(`bigint value ${b} out of range`);
  return b;
}

function bytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  throw new TypeError('Binary parameters must be a Uint8Array/Buffer');
}

/** Converts a value to the wire form of an explicit SQL type. */
function typedValue(type: SqlTypeName, v: unknown): WireValue {
  switch (type) {
    case 'bit':
      return Boolean(v);
    case 'tinyint':
      return int(v, type, 0, 255);
    case 'smallint':
      return int(v, type, -32768, 32767);
    case 'int':
      return int(v, type, INT32_MIN, INT32_MAX);
    case 'bigint':
      return bigint(v);
    case 'float':
    case 'real': {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new RangeError(`Invalid ${type} value ${String(v)}`);
      return n;
    }
    case 'decimal':
    case 'numeric':
    case 'money':
    case 'smallmoney':
      return decimalString(v);
    case 'binary':
    case 'varbinary':
    case 'image':
      return bytes(v);
    case 'date':
      if (v instanceof Temporal.PlainDate) return dateParts(v);
      if (typeof v === 'string') return dateParts(Temporal.PlainDate.from(v));
      return dateParts(toPlainDateTime(v, type));
    case 'time':
      if (v instanceof Temporal.PlainTime) return timeParts(v);
      if (typeof v === 'string') return timeParts(Temporal.PlainTime.from(v));
      return timeParts(toPlainDateTime(v, type));
    case 'datetime':
    case 'datetime2':
    case 'smalldatetime': {
      const dt = toPlainDateTime(v, type);
      return [...dateParts(dt), ...timeParts(dt)];
    }
    case 'datetimeoffset':
      return offsetParts(toZoned(v));
    default:
      // character types and uniqueidentifier
      return typeof v === 'string' ? v : String(v);
  }
}

function fromTyped(p: TypedParam): WireParam {
  const value = p.value === null || p.value === undefined ? null : typedValue(p.type, p.value);
  return {
    type: p.type,
    value,
    length: p.length,
    precision: p.precision,
    scale: p.scale,
  };
}

const wire = (type: SqlTypeName, value: WireValue): WireParam => ({ type, value });

/** Infers the SQL type of an untyped value. */
export function encodeParam(p: Param): WireParam {
  if (p === null || p === undefined) return { type: undefined, value: null };
  switch (typeof p) {
    case 'boolean':
      return wire('bit', p);
    case 'number':
      if (!Number.isFinite(p)) throw new RangeError(`Cannot bind ${p}`);
      if (Number.isInteger(p) && p >= INT32_MIN && p <= INT32_MAX) return wire('int', p);
      if (Number.isSafeInteger(p)) return wire('bigint', BigInt(p));
      return wire('float', p);
    case 'bigint':
      return wire('bigint', bigint(p));
    case 'string':
      return wire('nvarchar', p);
    default:
  }
  if (isTypedParam(p)) return fromTyped(p);
  if (p instanceof Uint8Array) return wire('varbinary', p);
  // A Date is an instant: bound as its UTC wall-clock time.
  if (p instanceof Date) return wire('datetime2', typedValue('datetime2', p));
  if (p instanceof Temporal.PlainDate) return wire('date', dateParts(p));
  if (p instanceof Temporal.PlainTime) return wire('time', timeParts(p));
  if (p instanceof Temporal.PlainDateTime) return wire('datetime2', typedValue('datetime2', p));
  if (p instanceof Temporal.ZonedDateTime || p instanceof Temporal.Instant) {
    return wire('datetimeoffset', offsetParts(toZoned(p)));
  }
  throw new TypeError(`Unsupported parameter type: ${Object.prototype.toString.call(p)}`);
}

export function encodeParams(params: readonly Param[] | undefined): WireParam[] {
  return params ? params.map(encodeParam) : [];
}
