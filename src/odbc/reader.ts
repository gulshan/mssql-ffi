// reader.ts - reads the rows of a result set with as few FFI calls as possible.
//
// Columns with a bounded size are bound (SQLBindCol) to one long-lived buffer. When every
// column can be bound, a block cursor fetches up to MAX_ROWS rows per SQLFetch and values
// are decoded straight from the buffer. Otherwise the driver only allows SQLGetData on
// columns after the last bound one, so the leading bindable columns are bound and the
// rest are read one call per value.
import type { Kind, WireValue } from '../types.ts';
import { normalizeDecimal } from './columns.ts';
import type { Columns } from './columns.ts';
import * as C from './constants.ts';
import { odbc, rawPointer } from './ffi.ts';
import type { Handle } from './handles.ts';

interface Layout {
  cType: number;
  /** Bytes per value in a bound buffer. */
  width: number;
}

const BLOCK_BYTES = 4 * 1024 * 1024;
const MAX_ROWS = 1024;
const MAX_BOUND_CHARS = 4000;
const MAX_BOUND_BYTES = 8000;

/** How a value is fetched; `undefined` when it has no bounded size (must use SQLGetData). */
export function layoutOf(kind: Kind, size: number, sqlType: number): Layout | undefined {
  switch (kind) {
    case 'bool':
      return { cType: C.SQL_C_BIT, width: 1 };
    case 'int':
      return { cType: C.SQL_C_SLONG, width: 4 };
    case 'bigint':
      return { cType: C.SQL_C_SBIGINT, width: 8 };
    case 'float':
      return { cType: C.SQL_C_DOUBLE, width: 8 };
    case 'decimal':
      return { cType: C.SQL_C_CHAR, width: Math.max(size, 1) + 3 }; // sign, point, NUL
    case 'guid':
      return { cType: C.SQL_C_CHAR, width: 37 };
    case 'date':
      return { cType: C.SQL_C_TYPE_DATE, width: 6 };
    case 'time':
      return { cType: C.SQL_C_SS_TIME2, width: 12 };
    case 'datetime':
      return { cType: C.SQL_C_TYPE_TIMESTAMP, width: 16 };
    case 'datetimeoffset':
      return { cType: C.SQL_C_SS_TIMESTAMPOFFSET, width: 20 };
    case 'text':
      if (size <= 0 || size > MAX_BOUND_CHARS || sqlType === C.SQL_SS_VARIANT) return undefined;
      return { cType: C.SQL_C_WCHAR, width: (size + 1) * 2 };
    case 'binary':
      if (size <= 0 || size > MAX_BOUND_BYTES) return undefined;
      return { cType: C.SQL_C_BINARY, width: size };
  }
}

/** Decodes one non-NULL value of `len` bytes at `at`. */
export function decodeAt(buf: Buffer, at: number, kind: Kind, len: number): WireValue {
  switch (kind) {
    case 'bool':
      return buf[at] !== 0;
    case 'int':
      return buf.readInt32LE(at);
    case 'bigint':
      return buf.readBigInt64LE(at);
    case 'float':
      return buf.readDoubleLE(at);
    case 'decimal':
      return normalizeDecimal(buf.toString('latin1', at, at + len));
    case 'guid':
      return buf.toString('latin1', at, at + len).toLowerCase();
    case 'date':
      return [buf.readInt16LE(at), buf.readUInt16LE(at + 2), buf.readUInt16LE(at + 4)];
    case 'time':
      return [
        buf.readUInt16LE(at),
        buf.readUInt16LE(at + 2),
        buf.readUInt16LE(at + 4),
        buf.readUInt32LE(at + 8),
      ];
    case 'datetime':
    case 'datetimeoffset': {
      const parts = [
        buf.readInt16LE(at),
        buf.readUInt16LE(at + 2),
        buf.readUInt16LE(at + 4),
        buf.readUInt16LE(at + 6),
        buf.readUInt16LE(at + 8),
        buf.readUInt16LE(at + 10),
        buf.readUInt32LE(at + 12),
      ];
      if (kind === 'datetimeoffset') {
        parts.push(buf.readInt16LE(at + 16) * 60 + buf.readInt16LE(at + 18));
      }
      return parts;
    }
    case 'text':
      return buf.toString('utf16le', at, at + len);
    case 'binary':
      // A fresh, exactly sized ArrayBuffer so it can be transferred to the main thread.
      return new Uint8Array(buf.subarray(at, at + len));
  }
}

// --- SQLGetData path: one long-lived scratch area, passed as raw addresses.

const CHUNK = 64 * 1024;
const scratch = Buffer.alloc(CHUNK + 8); // value area, then the 8-byte indicator
let scratchPtr: bigint | undefined;
const CHUNK_LEN = BigInt(CHUNK);

type Check = (rc: number, what: string) => number;

const CTYPES: Record<Kind, number> = {
  bool: C.SQL_C_BIT,
  int: C.SQL_C_SLONG,
  bigint: C.SQL_C_SBIGINT,
  float: C.SQL_C_DOUBLE,
  decimal: C.SQL_C_CHAR,
  guid: C.SQL_C_CHAR,
  date: C.SQL_C_TYPE_DATE,
  time: C.SQL_C_SS_TIME2,
  datetime: C.SQL_C_TYPE_TIMESTAMP,
  datetimeoffset: C.SQL_C_SS_TIMESTAMPOFFSET,
  text: C.SQL_C_WCHAR,
  binary: C.SQL_C_BINARY,
};

function readLong(
  stmt: Handle,
  col: number,
  text: boolean,
  check: Check,
): string | Uint8Array | null {
  const api = odbc();
  const ptr = (scratchPtr ??= rawPointer(scratch));
  const cType = text ? C.SQL_C_WCHAR : C.SQL_C_BINARY;
  const room = text ? CHUNK - 2 : CHUNK; // WCHAR chunks are NUL-terminated
  const parts: Buffer[] = [];
  for (;;) {
    const rc = api.SQLGetData(stmt, col, cType, ptr, CHUNK_LEN, ptr + CHUNK_LEN);
    if (rc === C.SQL_NO_DATA) break;
    check(rc, 'SQLGetData');
    const n = scratch.readBigInt64LE(CHUNK);
    if (n === C.SQL_NULL_DATA) return null;
    const more = rc === C.SQL_SUCCESS_WITH_INFO && (n === C.SQL_NO_TOTAL || n > BigInt(room));
    const len = more ? room : Number(n);
    if (!more && parts.length === 0) {
      return text ? scratch.toString('utf16le', 0, len) : new Uint8Array(scratch.subarray(0, len));
    }
    parts.push(Buffer.from(scratch.subarray(0, len)));
    if (!more) break;
  }
  const all = Buffer.concat(parts);
  return text ? all.toString('utf16le') : new Uint8Array(all);
}

function getData(stmt: Handle, col: number, kind: Kind, check: Check): WireValue {
  if (kind === 'text' || kind === 'binary') return readLong(stmt, col, kind === 'text', check);
  const cType = CTYPES[kind];
  const ptr = (scratchPtr ??= rawPointer(scratch));
  check(odbc().SQLGetData(stmt, col, cType, ptr, CHUNK_LEN, ptr + CHUNK_LEN), 'SQLGetData');
  const len = scratch.readInt32LE(CHUNK); // low word of the SQLLEN indicator
  return len === -1 ? null : decodeAt(scratch, 0, kind, len);
}

// --- bound columns

interface Slot {
  data: number;
  ind: number;
  width: number;
  kind: Kind;
  text: boolean;
  binary: boolean;
}

const align8 = (n: number): number => (n + 7) & ~7;

export class RowReader {
  readonly #stmt: Handle;
  readonly #kinds: readonly Kind[];
  readonly #check: Check;
  readonly #slots: Slot[] = [];
  readonly #rowset: number;
  readonly #buf: Buffer | undefined;
  #fetchedAt = 0;
  #fetched = 0;
  #pos = 0;
  #done = false;
  #released = false;

  constructor(stmt: Handle, cols: Columns, check: Check) {
    this.#stmt = stmt;
    this.#kinds = cols.kinds;
    this.#check = check;
    const layouts: Layout[] = [];
    for (let i = 0; i < cols.kinds.length; i++) {
      const l = layoutOf(cols.kinds[i]!, cols.meta[i]!.size, cols.meta[i]!.sqlType);
      if (!l) break;
      layouts.push(l);
    }
    const all = layouts.length === cols.kinds.length;
    const rowBytes = layouts.reduce((sum, l) => sum + l.width + 8, 0);
    this.#rowset = all ? Math.max(1, Math.min(MAX_ROWS, Math.floor(BLOCK_BYTES / rowBytes))) : 1;
    if (!layouts.length) return;

    let at = 0;
    for (let i = 0; i < layouts.length; i++) {
      const { width } = layouts[i]!;
      const kind = cols.kinds[i]!;
      const data = at;
      at = align8(at + width * this.#rowset);
      this.#slots.push({
        data,
        ind: at,
        width,
        kind,
        text: kind === 'text',
        binary: kind === 'binary',
      });
      at += 8 * this.#rowset;
    }
    this.#fetchedAt = at;
    // Over 64 bytes, so the backing store is off-heap and its address is stable.
    this.#buf = Buffer.alloc(Math.max(at + 8, 128));
    const base = rawPointer(this.#buf);
    const api = odbc();
    if (this.#rowset > 1) {
      check(
        api.SQLSetStmtAttrW(
          stmt,
          C.SQL_ATTR_ROW_ARRAY_SIZE,
          BigInt(this.#rowset),
          C.SQL_IS_UINTEGER,
        ),
        'SQLSetStmtAttr(ROW_ARRAY_SIZE)',
      );
      check(
        api.SQLSetStmtAttrW(stmt, C.SQL_ATTR_ROWS_FETCHED_PTR, base + BigInt(at), C.SQL_IS_POINTER),
        'SQLSetStmtAttr(ROWS_FETCHED_PTR)',
      );
    }
    this.#slots.forEach((s, i) => {
      check(
        api.SQLBindCol(
          stmt,
          i + 1,
          layouts[i]!.cType,
          base + BigInt(s.data),
          BigInt(s.width),
          base + BigInt(s.ind),
        ),
        'SQLBindCol',
      );
    });
  }

  /** Rows fetched per SQLFetch (1 unless every column is bound). */
  get rowset(): number {
    return this.#rowset;
  }

  /** The next row, or undefined at the end of the result set. */
  next(): WireValue[] | undefined {
    if (this.#pos >= this.#fetched) {
      if (this.#done) return undefined;
      const rc = odbc().SQLFetch(this.#stmt);
      if (rc === C.SQL_NO_DATA) {
        this.#done = true;
        return undefined;
      }
      this.#check(rc, 'SQLFetch');
      this.#fetched = this.#rowset > 1 ? Number(this.#buf!.readBigUInt64LE(this.#fetchedAt)) : 1;
      this.#pos = 0;
    }
    const r = this.#pos++;
    const n = this.#kinds.length;
    const row: WireValue[] = Array.from({ length: n });
    const buf = this.#buf;
    let i = 0;
    for (; i < this.#slots.length; i++) {
      const s = this.#slots[i]!;
      const len = buf!.readInt32LE(s.ind + r * 8);
      if (len === -1) {
        row[i] = null;
        continue;
      }
      if ((s.text && (len < 0 || len > s.width - 2)) || (s.binary && (len < 0 || len > s.width))) {
        throw new Error(`mssql-ffi: bound column ${i + 1} was truncated`);
      }
      row[i] = decodeAt(buf!, s.data + r * s.width, s.kind, len);
    }
    for (; i < n; i++) row[i] = getData(this.#stmt, i + 1, this.#kinds[i]!, this.#check);
    return row;
  }

  /** Unbinds the buffers. Must run before the statement moves on or the buffer is dropped. */
  release(): void {
    if (this.#released || !this.#slots.length) return;
    this.#released = true;
    const api = odbc();
    api.SQLFreeStmt(this.#stmt, C.SQL_UNBIND);
    if (this.#rowset > 1) {
      api.SQLSetStmtAttrW(this.#stmt, C.SQL_ATTR_ROW_ARRAY_SIZE, 1n, C.SQL_IS_UINTEGER);
      api.SQLSetStmtAttrW(this.#stmt, C.SQL_ATTR_ROWS_FETCHED_PTR, null, C.SQL_IS_POINTER);
    }
  }
}
