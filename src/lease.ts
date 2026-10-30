// lease.ts - exclusive use of a connection's channel for the duration of an operation.
import type { Channel } from './channel.ts';
import type { DecodeOptions } from './decode.ts';
import type { ProcParamInfo } from './proc.ts';

export interface Lease extends Disposable {
  readonly channel: Channel;
  readonly decode: DecodeOptions;
  /** Stored procedure metadata cache of the lease's owner. */
  readonly procs: Map<string, Promise<ProcParamInfo>>;
  release(): void;
}

export function lease(
  channel: Channel,
  decode: DecodeOptions,
  procs: Map<string, Promise<ProcParamInfo>>,
  release: () => void,
): Lease {
  let done = false;
  const once = (): void => {
    if (done) return;
    done = true;
    release();
  };
  return { channel, decode, procs, release: once, [Symbol.dispose]: once };
}
