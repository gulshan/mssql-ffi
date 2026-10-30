// ffi.ts - lazily bound subset of the ODBC driver manager.
// Loaded on first use so importing the library never touches node:ffi.
import type * as Ffi from 'node:ffi';
import { currentPlatform } from './platform.ts';

const definitions = {
  SQLAllocHandle: { arguments: ['int16', 'pointer', 'buffer'], return: 'int16' },
  SQLFreeHandle: { arguments: ['int16', 'pointer'], return: 'int16' },
  SQLSetEnvAttr: { arguments: ['pointer', 'int32', 'pointer', 'int32'], return: 'int16' },
  SQLSetConnectAttrW: { arguments: ['pointer', 'int32', 'pointer', 'int32'], return: 'int16' },
  SQLDriverConnectW: {
    arguments: ['pointer', 'pointer', 'buffer', 'int16', 'pointer', 'int16', 'pointer', 'uint16'],
    return: 'int16',
  },
  SQLDisconnect: { arguments: ['pointer'], return: 'int16' },
  SQLEndTran: { arguments: ['int16', 'pointer', 'int16'], return: 'int16' },
  SQLExecDirectW: { arguments: ['pointer', 'buffer', 'int32'], return: 'int16' },
  SQLPrepareW: { arguments: ['pointer', 'buffer', 'int32'], return: 'int16' },
  SQLExecute: { arguments: ['pointer'], return: 'int16' },
  SQLCancel: { arguments: ['pointer'], return: 'int16' },
  SQLFreeStmt: { arguments: ['pointer', 'uint16'], return: 'int16' },
  SQLNumResultCols: { arguments: ['pointer', 'buffer'], return: 'int16' },
  SQLRowCount: { arguments: ['pointer', 'buffer'], return: 'int16' },
  SQLDescribeColW: {
    arguments: [
      'pointer',
      'uint16',
      'buffer',
      'int16',
      'buffer',
      'buffer',
      'buffer',
      'buffer',
      'buffer',
    ],
    return: 'int16',
  },
  SQLColAttributeW: {
    arguments: ['pointer', 'uint16', 'uint16', 'buffer', 'int16', 'buffer', 'buffer'],
    return: 'int16',
  },
  SQLDescribeParam: {
    arguments: ['pointer', 'uint16', 'buffer', 'buffer', 'buffer', 'buffer'],
    return: 'int16',
  },
  SQLFetch: { arguments: ['pointer'], return: 'int16' },
  // Target and indicator are raw addresses into long-lived buffers (cheaper than Buffer args).
  SQLGetData: {
    arguments: ['pointer', 'uint16', 'int16', 'pointer', 'int64', 'pointer'],
    return: 'int16',
  },
  SQLBindCol: {
    arguments: ['pointer', 'uint16', 'int16', 'pointer', 'int64', 'pointer'],
    return: 'int16',
  },
  SQLSetStmtAttrW: { arguments: ['pointer', 'int32', 'pointer', 'int32'], return: 'int16' },
  SQLMoreResults: { arguments: ['pointer'], return: 'int16' },
  SQLBindParameter: {
    arguments: [
      'pointer',
      'uint16',
      'int16',
      'int16',
      'int16',
      'uint64',
      'int16',
      'buffer',
      'int64',
      'buffer',
    ],
    return: 'int16',
  },
  SQLGetDiagRecW: {
    arguments: ['int16', 'pointer', 'int16', 'buffer', 'buffer', 'buffer', 'int16', 'buffer'],
    return: 'int16',
  },
  SQLGetDiagFieldW: {
    arguments: ['int16', 'pointer', 'int16', 'int16', 'buffer', 'int16', 'buffer'],
    return: 'int16',
  },
  SQLDriversW: {
    arguments: ['pointer', 'uint16', 'buffer', 'int16', 'buffer', 'buffer', 'int16', 'buffer'],
    return: 'int16',
  },
} as const satisfies Ffi.FunctionDefinitions;

export type OdbcApi = Ffi.DynamicLibraryResult<typeof definitions>['functions'];

let api: OdbcApi | undefined;
let raw: ((source: ArrayBuffer | NodeJS.ArrayBufferView) => bigint) | undefined;

/** The ODBC function table, loaded on first call. */
export function odbc(): OdbcApi {
  if (api) return api;
  const { library } = currentPlatform();
  const ffi = process.getBuiltinModule('node:ffi');
  if (!ffi) throw new Error('mssql-ffi: node:ffi is not available in this Node.js build');
  api = ffi.dlopen(library, definitions).functions;
  raw = ffi.getRawPointer;
  return api;
}

/**
 * Address of a buffer's memory. Only for buffers larger than V8's on-heap typed array
 * limit (64 bytes): their backing store is off-heap and never moves.
 */
export function rawPointer(buf: Buffer): bigint {
  odbc();
  return raw!(buf);
}
