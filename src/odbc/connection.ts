// connection.ts - a synchronous ODBC connection. Blocking by design: it lives in worker.ts.
import type { CursorBatch, CursorColumns, CursorOpened, StatementArgs } from '../protocol.ts';
import type { IsolationLevel, WireParam, WireQueryResult } from '../types.ts';
import type { Columns } from './columns.ts';
import * as C from './constants.ts';
import { odbc } from './ffi.ts';
import { alloc, check, diagnostics, environment, free, ok, wide } from './handles.ts';
import type { Handle } from './handles.ts';
import { Statement } from './statement.ts';
import type { OnRows } from './statement.ts';
import { SqlError } from '../errors.ts';

const ISOLATION: Record<IsolationLevel, bigint> = {
  'READ UNCOMMITTED': C.SQL_TXN_READ_UNCOMMITTED,
  'READ COMMITTED': C.SQL_TXN_READ_COMMITTED,
  'REPEATABLE READ': C.SQL_TXN_REPEATABLE_READ,
  SERIALIZABLE: C.SQL_TXN_SERIALIZABLE,
  SNAPSHOT: C.SQL_TXN_SS_SNAPSHOT,
};

/** Called around every blocking statement call so it can be cancelled from another thread. */
export type Track = <T>(stmt: Statement, fn: () => T) => T;

const untracked: Track = (_stmt, fn) => fn();

interface Cursor {
  stmt: Statement;
  columns: Columns | undefined;
  counts: number[];
}

export class Connection {
  readonly #dbc: Handle;
  readonly #prepared = new Map<number, Statement>();
  #cursor: Cursor | undefined;
  #nextId = 0;
  #isolationChanged = false;

  private constructor(dbc: Handle) {
    this.#dbc = dbc;
  }

  static open(connectionString: string, loginTimeoutSecs?: number): Connection {
    const api = odbc();
    const dbc = alloc(C.SQL_HANDLE_DBC, environment());
    if (loginTimeoutSecs !== undefined) {
      api.SQLSetConnectAttrW(
        dbc,
        C.SQL_ATTR_LOGIN_TIMEOUT,
        BigInt(loginTimeoutSecs),
        C.SQL_IS_UINTEGER,
      );
    }
    const rc = api.SQLDriverConnectW(
      dbc,
      null,
      wide(connectionString),
      C.SQL_NTS,
      null,
      0,
      null,
      C.SQL_DRIVER_NOPROMPT,
    );
    if (!ok(rc)) {
      const diags = diagnostics(C.SQL_HANDLE_DBC, dbc);
      free(C.SQL_HANDLE_DBC, dbc);
      throw SqlError.from('SQLDriverConnect', diags);
    }
    return new Connection(dbc);
  }

  #execute(stmt: Statement, args: StatementArgs, track: Track): void {
    if (args.timeoutSecs) stmt.queryTimeout(args.timeoutSecs);
    // Untyped NULLs need a prepared statement so the driver can describe their type.
    if (args.params.some((p: WireParam) => p.type === undefined)) {
      track(stmt, () => {
        stmt.prepare(args.sql);
        stmt.execute(args.params);
      });
    } else {
      track(stmt, () => stmt.execute(args.params, args.sql));
    }
  }

  query(args: StatementArgs, track: Track = untracked, onRows?: OnRows): WireQueryResult {
    const stmt = new Statement(this.#dbc);
    try {
      this.#execute(stmt, args, track);
      return track(stmt, () => stmt.collect(onRows));
    } finally {
      stmt.free();
    }
  }

  // --- cursors (one at a time; the main thread holds the connection lock meanwhile)

  /** Skips results without columns until one with columns (or the end) is reached. */
  #seekColumns(cursor: Cursor): CursorColumns | undefined {
    for (;;) {
      const cols = cursor.stmt.columns();
      if (cols.kinds.length) return cols;
      const n = cursor.stmt.rowCount();
      if (n >= 0) cursor.counts.push(n);
      if (!cursor.stmt.more()) return undefined;
    }
  }

  cursorOpen(args: StatementArgs, track: Track = untracked): CursorOpened {
    this.cursorClose();
    const stmt = new Statement(this.#dbc);
    const cursor: Cursor = { stmt, columns: undefined, counts: [] };
    try {
      this.#execute(stmt, args, track);
      cursor.columns = track(stmt, () => this.#seekColumns(cursor));
    } catch (e) {
      stmt.free();
      throw e;
    }
    const opened: CursorOpened = {
      columns: cursor.columns,
      done: cursor.columns === undefined,
      counts: cursor.counts.splice(0),
      info: stmt.info.splice(0),
    };
    if (opened.done) stmt.free();
    else this.#cursor = cursor;
    return opened;
  }

  cursorFetch(max: number, track: Track = untracked): CursorBatch {
    const cursor = this.#cursor;
    if (!cursor?.columns) return { rows: [], done: true, counts: [], info: [] };
    const { stmt } = cursor;
    try {
      return track(stmt, () => {
        const { rows, end } = stmt.fetch(cursor.columns!, max);
        let next: CursorColumns | undefined;
        let done = false;
        if (end) {
          next = stmt.more() ? this.#seekColumns(cursor) : undefined;
          cursor.columns = next;
          done = next === undefined;
        }
        return { rows, next, done, counts: cursor.counts.splice(0), info: stmt.info.splice(0) };
      });
    } catch (e) {
      this.cursorClose();
      throw e;
    } finally {
      if (cursor.columns === undefined) this.cursorClose();
    }
  }

  cursorClose(): void {
    this.#cursor?.stmt.free();
    this.#cursor = undefined;
  }

  // --- prepared statements

  prepare(sql: string): number {
    const stmt = new Statement(this.#dbc);
    try {
      stmt.prepare(sql);
    } catch (e) {
      stmt.free();
      throw e;
    }
    const id = ++this.#nextId;
    this.#prepared.set(id, stmt);
    return id;
  }

  preparedQuery(
    id: number,
    params: WireParam[],
    track: Track = untracked,
    onRows?: OnRows,
  ): WireQueryResult {
    const stmt = this.#prepared.get(id);
    if (!stmt) throw new Error(`Prepared statement ${id} was freed`);
    try {
      return track(stmt, () => {
        stmt.execute(params);
        return stmt.collect(onRows);
      });
    } finally {
      stmt.close();
    }
  }

  preparedFree(id: number): void {
    this.#prepared.get(id)?.free();
    this.#prepared.delete(id);
  }

  // --- transactions

  #setAttr(attr: number, value: bigint, what: string): void {
    check(
      odbc().SQLSetConnectAttrW(this.#dbc, attr, value, C.SQL_IS_UINTEGER),
      C.SQL_HANDLE_DBC,
      this.#dbc,
      what,
    );
  }

  begin(isolationLevel?: IsolationLevel): void {
    if (isolationLevel) {
      this.#setAttr(
        C.SQL_ATTR_TXN_ISOLATION,
        ISOLATION[isolationLevel],
        'SQLSetConnectAttr(isolation)',
      );
      this.#isolationChanged = true;
    }
    this.#setAttr(C.SQL_ATTR_AUTOCOMMIT, C.SQL_AUTOCOMMIT_OFF, 'SQLSetConnectAttr(autocommit)');
  }

  end(commit: boolean): void {
    try {
      check(
        odbc().SQLEndTran(C.SQL_HANDLE_DBC, this.#dbc, commit ? C.SQL_COMMIT : C.SQL_ROLLBACK),
        C.SQL_HANDLE_DBC,
        this.#dbc,
        commit ? 'Commit' : 'Rollback',
      );
    } finally {
      this.#setAttr(C.SQL_ATTR_AUTOCOMMIT, C.SQL_AUTOCOMMIT_ON, 'SQLSetConnectAttr(autocommit)');
      if (this.#isolationChanged) {
        this.#isolationChanged = false;
        this.#setAttr(
          C.SQL_ATTR_TXN_ISOLATION,
          C.SQL_TXN_READ_COMMITTED,
          'SQLSetConnectAttr(isolation)',
        );
      }
    }
  }

  close(): void {
    this.cursorClose();
    for (const stmt of this.#prepared.values()) stmt.free();
    this.#prepared.clear();
    const api = odbc();
    api.SQLDisconnect(this.#dbc);
    free(C.SQL_HANDLE_DBC, this.#dbc);
  }
}
