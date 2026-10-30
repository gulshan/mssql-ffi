// handles.ts - handle allocation, diagnostics and return-code checks.
import { SqlError } from '../errors.ts';
import type { Diagnostic } from '../errors.ts';
import {
  SQL_ATTR_ODBC_VERSION,
  SQL_DIAG_SS_LINE,
  SQL_DIAG_SS_PROCNAME,
  SQL_DIAG_SS_SEVERITY,
  SQL_DIAG_SS_SRVNAME,
  SQL_HANDLE_ENV,
  SQL_NO_DATA,
  SQL_OV_ODBC3_80,
  SQL_SUCCESS,
  SQL_SUCCESS_WITH_INFO,
} from './constants.ts';
import { odbc } from './ffi.ts';

/** An ODBC handle (SQLHANDLE): a raw pointer address. */
export type Handle = bigint;

export const ok = (rc: number): boolean => rc === SQL_SUCCESS || rc === SQL_SUCCESS_WITH_INFO;

const MAX_MSG = 4096; // characters

function diagString(type: number, h: Handle, rec: number, field: number): string | undefined {
  const buf = Buffer.alloc(512);
  const len = Buffer.alloc(2);
  if (!ok(odbc().SQLGetDiagFieldW(type, h, rec, field, buf, buf.length, len))) return undefined;
  const s = buf.toString('utf16le', 0, Math.min(len.readInt16LE(0), buf.length - 2));
  return s || undefined;
}

function diagInt(
  type: number,
  h: Handle,
  rec: number,
  field: number,
  bytes: 2 | 4,
): number | undefined {
  const buf = Buffer.alloc(8);
  if (!ok(odbc().SQLGetDiagFieldW(type, h, rec, field, buf, bytes, null))) return undefined;
  return bytes === 2 ? buf.readUInt16LE(0) : buf.readInt32LE(0);
}

/** Reads every diagnostic record attached to a handle. */
export function diagnostics(type: number, h: Handle): Diagnostic[] {
  const api = odbc();
  const out: Diagnostic[] = [];
  const state = Buffer.alloc(12);
  const native = Buffer.alloc(4);
  const msg = Buffer.alloc((MAX_MSG + 1) * 2);
  const len = Buffer.alloc(2);
  for (let rec = 1; ; rec++) {
    if (!ok(api.SQLGetDiagRecW(type, h, rec, state, native, msg, MAX_MSG + 1, len))) break;
    const chars = Math.min(len.readInt16LE(0), MAX_MSG);
    out.push({
      sqlstate: state.toString('utf16le', 0, 10),
      code: native.readInt32LE(0),
      message: msg.toString('utf16le', 0, chars * 2),
      severity: diagInt(type, h, rec, SQL_DIAG_SS_SEVERITY, 4),
      lineNumber: diagInt(type, h, rec, SQL_DIAG_SS_LINE, 2),
      serverName: diagString(type, h, rec, SQL_DIAG_SS_SRVNAME),
      procName: diagString(type, h, rec, SQL_DIAG_SS_PROCNAME),
    });
  }
  return out;
}

/** Throws a SqlError unless rc is success, success-with-info or no-data. */
export function check(rc: number, type: number, h: Handle, what: string): number {
  if (ok(rc) || rc === SQL_NO_DATA) return rc;
  throw SqlError.from(what, diagnostics(type, h));
}

export function alloc(type: number, parent: Handle | null): Handle {
  const b = Buffer.alloc(8);
  const rc = odbc().SQLAllocHandle(type, parent, b);
  if (!ok(rc)) {
    if (parent !== null)
      throw SqlError.from(`SQLAllocHandle(${type})`, diagnostics(type - 1, parent));
    throw new Error(`SQLAllocHandle(${type}) failed (rc=${rc})`);
  }
  return b.readBigUInt64LE(0);
}

export function free(type: number, h: Handle): void {
  odbc().SQLFreeHandle(type, h);
}

let env: Handle | undefined;

/** The process-wide (per worker) ODBC 3 environment handle. */
export function environment(): Handle {
  if (env !== undefined) return env;
  const h = alloc(SQL_HANDLE_ENV, null);
  check(
    odbc().SQLSetEnvAttr(h, SQL_ATTR_ODBC_VERSION, SQL_OV_ODBC3_80, 0),
    SQL_HANDLE_ENV,
    h,
    'SQLSetEnvAttr',
  );
  env = h;
  return h;
}

/** NUL-terminated UTF-16LE copy of a string. */
export function wide(s: string): Buffer {
  const b = Buffer.alloc(s.length * 2 + 2);
  b.write(s, 'utf16le');
  return b;
}
