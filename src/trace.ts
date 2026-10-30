// trace.ts - diagnostics_channel tracing. Free when nobody subscribes.
import { tracingChannel } from 'node:diagnostics_channel';
import type { TracingChannel } from 'node:diagnostics_channel';
import type { Param } from './types.ts';

/** Name of the tracing channel: `diagnostics_channel.tracingChannel('mssql-ffi:query')`. */
export const TRACE_CHANNEL = 'mssql-ffi:query';

export interface QueryTraceContext {
  operation: 'query' | 'queryRaw' | 'stream' | 'prepared' | 'callProc';
  sql: string;
  params: readonly Param[] | undefined;
}

const channel: TracingChannel<QueryTraceContext, QueryTraceContext> = tracingChannel(TRACE_CHANNEL);

export function traced<T>(context: QueryTraceContext, fn: () => Promise<T>): Promise<T> {
  return channel.hasSubscribers ? channel.tracePromise(fn, context) : fn();
}
