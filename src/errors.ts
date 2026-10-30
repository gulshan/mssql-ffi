// errors.ts - SqlError and its structured-clone safe form for crossing the worker boundary.

/** One ODBC diagnostic record. */
export interface Diagnostic {
  sqlstate: string;
  /** Native (SQL Server) error number. */
  code: number;
  message: string;
  severity?: number | undefined;
  lineNumber?: number | undefined;
  serverName?: string | undefined;
  procName?: string | undefined;
}

/** An error reported by the ODBC driver or SQL Server. Fields mirror the first diagnostic. */
export class SqlError extends Error {
  override name = 'SqlError';
  readonly sqlstate: string;
  readonly code: number;
  readonly severity: number | undefined;
  readonly lineNumber: number | undefined;
  readonly serverName: string | undefined;
  readonly procName: string | undefined;
  /** Every diagnostic record, primary first. */
  readonly diagnostics: readonly Diagnostic[];

  constructor(message: string, diagnostics: readonly Diagnostic[], options?: ErrorOptions) {
    super(message, options);
    const d = diagnostics[0];
    this.sqlstate = d?.sqlstate ?? '';
    this.code = d?.code ?? 0;
    this.severity = d?.severity;
    this.lineNumber = d?.lineNumber;
    this.serverName = d?.serverName;
    this.procName = d?.procName;
    this.diagnostics = diagnostics;
  }

  /** Builds an error whose message is the diagnostics' messages, prefixed by `what`. */
  static from(what: string, diagnostics: readonly Diagnostic[]): SqlError {
    const detail = diagnostics.map((d) => `[${d.sqlstate}] ${d.message}`).join('\n');
    return new SqlError(detail ? `${what}: ${detail}` : `${what} failed`, diagnostics);
  }
}

export interface SerializedError {
  name: string;
  message: string;
  stack?: string | undefined;
  diagnostics?: readonly Diagnostic[] | undefined;
}

export function serializeError(e: unknown): SerializedError {
  if (e instanceof SqlError) {
    return { name: e.name, message: e.message, stack: e.stack, diagnostics: e.diagnostics };
  }
  if (Error.isError(e)) return { name: e.name, message: e.message, stack: e.stack };
  return { name: 'Error', message: String(e) };
}

export function deserializeError(s: SerializedError): Error {
  const err = s.diagnostics ? new SqlError(s.message, s.diagnostics) : new Error(s.message);
  if (!s.diagnostics) err.name = s.name;
  return err;
}
