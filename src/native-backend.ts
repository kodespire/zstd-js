import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { rethrowNative } from './errors.js';
import type { Backend, CStreamHandle, DStreamHandle } from './types.js';

interface NativeCStream {
  push(chunk: Uint8Array, mode: number): Uint8Array;
  pushAsync(chunk: Uint8Array, mode: number): Promise<Uint8Array>;
  close(): void;
}

interface NativeDStream {
  push(chunk: Uint8Array): Uint8Array;
  pushAsync(chunk: Uint8Array): Promise<Uint8Array>;
  finish(): void;
  close(): void;
}

interface NativeAddon {
  version: string;
  compressSync(data: Uint8Array, level: number, checksum: boolean, dict: Uint8Array | null): Uint8Array;
  compress(data: Uint8Array, level: number, checksum: boolean, dict: Uint8Array | null): Promise<Uint8Array>;
  decompressSync(data: Uint8Array, dict: Uint8Array | null, windowLogMax: number, maxOutput: number): Uint8Array;
  decompress(data: Uint8Array, dict: Uint8Array | null, windowLogMax: number, maxOutput: number): Promise<Uint8Array>;
  frameContentSize(data: Uint8Array): number;
  CStream: new (level: number, checksum: boolean, dict: Uint8Array | null) => NativeCStream;
  DStream: new (dict: Uint8Array | null, windowLogMax: number, maxOutput: number) => NativeDStream;
}

// The addon returns Node Buffers; expose plain Uint8Array views (no copy) so results
// behave the same in every runtime.
const view = (b: Uint8Array): Uint8Array => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);

function wrapSync<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  return (...args) => {
    try {
      return fn(...args);
    } catch (error) {
      rethrowNative(error);
    }
  };
}

/** Loads the prebuilt (or locally built) addon. Throws if none matches this platform. */
export function loadNativeBackend(): Backend {
  const require = createRequire(import.meta.url);
  const nodeGypBuild = require('node-gyp-build') as (dir: string) => NativeAddon;
  const addon = nodeGypBuild(fileURLToPath(new URL('..', import.meta.url)));

  return {
    kind: 'native',
    version: addon.version,
    compressSync: wrapSync((data, level, checksum, dict) => view(addon.compressSync(data, level, checksum, dict))),
    compress: (data, level, checksum, dict) =>
      addon.compress(data, level, checksum, dict).then(view, rethrowNative),
    decompressSync: wrapSync((data, dict, windowLogMax, maxOutput) =>
      view(addon.decompressSync(data, dict, windowLogMax, maxOutput))),
    decompress: (data, dict, windowLogMax, maxOutput) =>
      addon.decompress(data, dict, windowLogMax, maxOutput).then(view, rethrowNative),
    frameContentSize: wrapSync((data) => addon.frameContentSize(data)),
    createCStream: wrapSync((level, checksum, dict): CStreamHandle => {
      const s = new addon.CStream(level, checksum, dict);
      return {
        push: wrapSync((chunk, mode) => view(s.push(chunk, mode))),
        pushAsync: (chunk, mode) => s.pushAsync(chunk, mode).then(view, rethrowNative),
        close: wrapSync(() => s.close()),
      };
    }),
    createDStream: wrapSync((dict, windowLogMax, maxOutput): DStreamHandle => {
      const s = new addon.DStream(dict, windowLogMax, maxOutput);
      return {
        push: wrapSync((chunk) => view(s.push(chunk))),
        pushAsync: (chunk) => s.pushAsync(chunk).then(view, rethrowNative),
        finish: wrapSync(() => s.finish()),
        close: wrapSync(() => s.close()),
      };
    }),
  };
}
