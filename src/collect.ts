// collect.ts - decodes a statement's result sets, chunk by chunk or all at once.
import { decoders, decodeRow, toObject } from './decode.ts';
import type { DecodeOptions } from './decode.ts';
import type { CursorColumns, Partial } from './protocol.ts';
import type { ColumnMeta, QueryResult, Row, Value, WireQueryResult, WireValue } from './types.ts';

export interface Collected<R> {
  results: R[][];
  meta: ColumnMeta[][];
  counts: number[];
  info: string[];
}

interface Reader {
  decs: ReturnType<typeof decoders>;
  names: string[];
}

/**
 * Builds row objects (or positional arrays) per result set. Rows either arrive in chunks
 * ahead of the final result (`onPartial`) or are carried by the final result (`finish`).
 */
export class Collector<R extends Row | Value[]> {
  readonly #decode: DecodeOptions;
  readonly #raw: boolean;
  readonly #sets: R[][] = [];
  readonly #readers: Reader[] = [];

  private constructor(decode: DecodeOptions, raw: boolean) {
    this.#decode = decode;
    this.#raw = raw;
  }

  static rows(decode: DecodeOptions): Collector<Row> {
    return new Collector<Row>(decode, false);
  }

  static raw(decode: DecodeOptions): Collector<Value[]> {
    return new Collector<Value[]>(decode, true);
  }

  /** Decodes one chunk; `columns` comes with the first chunk of each result set. */
  readonly onPartial = (p: Partial): void => this.#add(p.set, p.columns, p.rows);

  #add(set: number, columns: CursorColumns | undefined, rows: readonly WireValue[][]): void {
    let reader = this.#readers[set];
    if (!reader) {
      const cols = columns!;
      reader = { decs: decoders(cols.kinds, this.#decode), names: cols.meta.map((m) => m.name) };
      this.#readers[set] = reader;
    }
    const out = (this.#sets[set] ??= []);
    for (const row of rows) {
      const values = decodeRow(row, reader.decs);
      out.push((this.#raw ? values : toObject(reader.names, values)) as R);
    }
  }

  /** Completes the result, decoding any rows the final result itself carries. */
  finish(wire: WireQueryResult): Collected<R> {
    wire.results.forEach((set, i) => {
      if (set.rows.length) this.#add(i, set, set.rows);
    });
    return {
      results: wire.results.map((_, i) => this.#sets[i] ?? []),
      meta: wire.results.map((set) => set.meta),
      counts: wire.counts,
      info: wire.info,
    };
  }
}

export function toQueryResult<T>(c: Collected<Row>): QueryResult<T> {
  const results = c.results as T[][];
  return { first: results[0] ?? [], results, meta: c.meta, counts: c.counts, info: c.info };
}
