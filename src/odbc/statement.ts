// statement.ts - statement execution, result set iteration and info messages.
import type { WireParam, WireQueryResult, WireResultSet, WireValue } from '../types.ts';
import { describeColumns } from './columns.ts';
import type { Columns } from './columns.ts';
import * as C from './constants.ts';
import { odbc } from './ffi.ts';
import { alloc, check, diagnostics, free, wide } from './handles.ts';
import type { Handle } from './handles.ts';
import { bindParams } from './params.ts';
import type { Binding } from './params.ts';
import { RowReader } from './reader.ts';

/** SQLSTATE of "string data, right truncated" (a partial SQLGetData read). */
const TRUNCATED = '01004';

/** Values per partial result message sent while collecting. */
const PARTIAL_VALUES = 32_768;

/** Receives rows of result set `set` as they are read; `columns` comes with its first rows. */
export type OnRows = (set: number, columns: Columns | undefined, rows: WireValue[][]) => void;

export class Statement {
  readonly handle: Handle;
  readonly info: string[] = [];
  // Keeps the bound parameter buffers alive while the driver may read them.
  // oxlint-disable-next-line no-unused-private-class-members
  #bindings: Binding[] = [];
  #reader: RowReader | undefined;
  #prepared = false;
  #freed = false;

  constructor(dbc: Handle) {
    this.handle = alloc(C.SQL_HANDLE_STMT, dbc);
  }

  readonly #check = (rc: number, what: string): number => {
    check(rc, C.SQL_HANDLE_STMT, this.handle, what);
    if (rc === C.SQL_SUCCESS_WITH_INFO) this.#collectInfo();
    return rc;
  };

  #collectInfo(): void {
    for (const d of diagnostics(C.SQL_HANDLE_STMT, this.handle)) {
      if (d.sqlstate !== TRUNCATED) this.info.push(d.message);
    }
  }

  #release(): void {
    this.#reader?.release();
    this.#reader = undefined;
  }

  prepare(sql: string): void {
    this.#check(odbc().SQLPrepareW(this.handle, wide(sql), C.SQL_NTS), 'SQLPrepare');
    this.#prepared = true;
  }

  /** Executes a prepared statement, or `sql` directly. Untyped NULLs are described when prepared. */
  execute(params: readonly WireParam[], sql?: string): void {
    const api = odbc();
    if (this.#prepared) {
      this.close();
      api.SQLFreeStmt(this.handle, C.SQL_RESET_PARAMS);
    }
    this.#bindings = bindParams(this.handle, params, this.#prepared);
    if (sql === undefined) this.#check(api.SQLExecute(this.handle), 'SQLExecute');
    else this.#check(api.SQLExecDirectW(this.handle, wide(sql), C.SQL_NTS), 'SQLExecDirect');
  }

  columns(): Columns {
    return describeColumns(this.handle);
  }

  /** Fetches up to `max` rows of the current result set; `end` is true once it is exhausted. */
  fetch(cols: Columns, max: number): { rows: WireValue[][]; end: boolean } {
    const reader = (this.#reader ??= new RowReader(this.handle, cols, this.#check));
    const rows: WireValue[][] = [];
    while (rows.length < max) {
      const row = reader.next();
      if (!row) return { rows, end: true };
      rows.push(row);
    }
    return { rows, end: false };
  }

  rowCount(): number {
    const b = Buffer.alloc(8);
    this.#check(odbc().SQLRowCount(this.handle, b), 'SQLRowCount');
    return Number(b.readBigInt64LE(0));
  }

  /** Moves to the next result; false when there is none. Errors in later statements throw. */
  more(): boolean {
    this.#release();
    return this.#check(odbc().SQLMoreResults(this.handle), 'SQLMoreResults') !== C.SQL_NO_DATA;
  }

  /**
   * Reads every remaining result of the batch. With `onRows`, rows are handed over in
   * chunks as they are read and the returned result sets carry no rows.
   */
  collect(onRows?: OnRows): WireQueryResult {
    const results: WireResultSet[] = [];
    const counts: number[] = [];
    do {
      const cols = this.columns();
      if (cols.kinds.length) {
        const set = results.length;
        let rows: WireValue[][] = [];
        if (onRows) {
          const chunk = Math.max(1, Math.floor(PARTIAL_VALUES / cols.kinds.length));
          let first = true;
          for (;;) {
            const batch = this.fetch(cols, chunk);
            if (batch.rows.length) onRows(set, first ? cols : undefined, batch.rows);
            first &&= batch.rows.length === 0;
            if (batch.end) break;
          }
        } else {
          rows = this.fetch(cols, Number.POSITIVE_INFINITY).rows;
        }
        results.push({ ...cols, rows });
      } else {
        const n = this.rowCount();
        if (n >= 0) counts.push(n);
      }
    } while (this.more());
    return { results, counts, info: this.info.splice(0) };
  }

  /** Closes the cursor so the (prepared) statement can run again. */
  close(): void {
    this.#release();
    odbc().SQLFreeStmt(this.handle, C.SQL_CLOSE);
    this.#bindings = [];
  }

  free(): void {
    if (this.#freed) return;
    this.#freed = true;
    free(C.SQL_HANDLE_STMT, this.handle);
    // Dropped only after the handle is gone: the driver may hold their addresses until then.
    this.#reader = undefined;
    this.#bindings = [];
  }
}
