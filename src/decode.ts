// decode.ts - wire values -> JS values (Temporal, number/bigint, string decimals).
import type { ConnectionOptions, Kind, Row, Value, WireResultSet, WireValue } from './types.ts';

export interface DecodeOptions {
  useNumericNumber: boolean;
  useBigIntAsNative: boolean;
}

export function decodeOptions(o: ConnectionOptions): DecodeOptions {
  return {
    useNumericNumber: o.useNumericNumber ?? false,
    useBigIntAsNative: o.useBigIntAsNative ?? false,
  };
}

type Decoder = (v: WireValue) => Value;

const n = (v: WireValue): number[] => v as number[];

function plainDateTime(p: number[]): Temporal.PlainDateTime {
  const ns = p[6]!;
  return new Temporal.PlainDateTime(
    p[0]!,
    p[1]!,
    p[2]!,
    p[3]!,
    p[4]!,
    p[5]!,
    Math.trunc(ns / 1_000_000),
    Math.trunc(ns / 1000) % 1000,
    ns % 1000,
  );
}

function offsetZone(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const hh = String(Math.trunc(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${sign}${hh}:${mm}`;
}

const DECODERS: Record<Kind, (o: DecodeOptions) => Decoder | undefined> = {
  bool: () => undefined,
  int: () => undefined,
  float: () => undefined,
  text: () => undefined,
  guid: () => undefined,
  binary: () => undefined,
  bigint: (o) =>
    o.useBigIntAsNative
      ? undefined
      : (v) => {
          const b = v as bigint;
          return b >= Number.MIN_SAFE_INTEGER && b <= Number.MAX_SAFE_INTEGER ? Number(b) : b;
        },
  decimal: (o) => (o.useNumericNumber ? (v) => Number(v) : undefined),
  date: () => (v) => new Temporal.PlainDate(n(v)[0]!, n(v)[1]!, n(v)[2]!),
  time: () => (v) => {
    const [h, mi, s, ns] = n(v) as [number, number, number, number];
    return new Temporal.PlainTime(
      h,
      mi,
      s,
      Math.trunc(ns / 1_000_000),
      Math.trunc(ns / 1000) % 1000,
      ns % 1000,
    );
  },
  datetime: () => (v) => plainDateTime(n(v)),
  // The wall-clock time is local to the stored offset.
  datetimeoffset: () => (v) => plainDateTime(n(v)).toZonedDateTime(offsetZone(n(v)[7]!)),
};

/** One decoder per column; `undefined` entries pass the wire value through. */
export function decoders(kinds: readonly Kind[], options: DecodeOptions): (Decoder | undefined)[] {
  return kinds.map((k) => DECODERS[k](options));
}

export function decodeRow(row: WireValue[], decs: readonly (Decoder | undefined)[]): Value[] {
  const out: Value[] = Array.from({ length: row.length });
  for (let i = 0; i < row.length; i++) {
    const v = row[i]!;
    const dec = decs[i];
    out[i] = v === null || !dec ? (v as Value) : dec(v);
  }
  return out;
}

/** Column names to row object keys. Duplicate names keep the last value, like msnodesqlv8. */
export function toObject(names: readonly string[], values: readonly Value[]): Row {
  const row: Row = {};
  for (let i = 0; i < names.length; i++) row[names[i]!] = values[i]!;
  return row;
}

export function decodeRows(set: WireResultSet, options: DecodeOptions): Row[] {
  const decs = decoders(set.kinds, options);
  const names = set.meta.map((m) => m.name);
  return set.rows.map((r) => toObject(names, decodeRow(r, decs)));
}

export function decodeRawRows(set: WireResultSet, options: DecodeOptions): Value[][] {
  const decs = decoders(set.kinds, options);
  return set.rows.map((r) => decodeRow(r, decs));
}
