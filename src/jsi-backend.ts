// React Native backend: the C++ TurboModule in cpp/ (the zjs C layer, as in the
// Node-API addon), reached through JSI. It returns ArrayBuffers that own the
// native output, and throws or rejects with errors carrying `zjsCode`.
import { rethrowNative } from './errors.js';
import type { Backend, CStreamHandle, DStreamHandle } from './types.js';

interface NativeCStream {
  push(chunk: Uint8Array, mode: number): ArrayBuffer;
  pushAsync(chunk: Uint8Array, mode: number): Promise<ArrayBuffer>;
  close(): void;
}

interface NativeDStream {
  push(chunk: Uint8Array): ArrayBuffer;
  pushAsync(chunk: Uint8Array): Promise<ArrayBuffer>;
  finish(): void;
  close(): void;
}

/** @internal What cpp/KodespireZstdModule.cpp exposes. */
export interface NativeModule {
  version(): string;
  compressSync(data: Uint8Array, level: number, checksum: boolean, dict: Uint8Array | null): ArrayBuffer;
  compress(data: Uint8Array, level: number, checksum: boolean, dict: Uint8Array | null): Promise<ArrayBuffer>;
  decompressSync(data: Uint8Array, dict: Uint8Array | null, windowLogMax: number, maxOutput: number): ArrayBuffer;
  decompress(data: Uint8Array, dict: Uint8Array | null, windowLogMax: number, maxOutput: number): Promise<ArrayBuffer>;
  frameContentSize(data: Uint8Array): number;
  createCStream(level: number, checksum: boolean, dict: Uint8Array | null): NativeCStream;
  createDStream(dict: Uint8Array | null, windowLogMax: number, maxOutput: number): NativeDStream;
}

const bytes = (buffer: ArrayBuffer): Uint8Array => new Uint8Array(buffer);

function wrapSync<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  return (...args) => {
    try {
      return fn(...args);
    } catch (error) {
      rethrowNative(error);
    }
  };
}

export function createJsiBackend(m: NativeModule): Backend {
  return {
    kind: 'native',
    version: m.version(),
    compressSync: wrapSync((data, level, checksum, dict) => bytes(m.compressSync(data, level, checksum, dict))),
    compress: (data, level, checksum, dict) => m.compress(data, level, checksum, dict).then(bytes, rethrowNative),
    decompressSync: wrapSync((data, dict, windowLogMax, maxOutput) =>
      bytes(m.decompressSync(data, dict, windowLogMax, maxOutput))),
    decompress: (data, dict, windowLogMax, maxOutput) =>
      m.decompress(data, dict, windowLogMax, maxOutput).then(bytes, rethrowNative),
    frameContentSize: wrapSync((data) => m.frameContentSize(data)),
    // The stream methods are plain functions bound to their native context.
    createCStream: wrapSync((level, checksum, dict): CStreamHandle => {
      const { push, pushAsync, close } = m.createCStream(level, checksum, dict);
      return {
        push: wrapSync((chunk, mode) => bytes(push(chunk, mode))),
        pushAsync: (chunk, mode) => pushAsync(chunk, mode).then(bytes, rethrowNative),
        close: wrapSync(() => close()),
      };
    }),
    createDStream: wrapSync((dict, windowLogMax, maxOutput): DStreamHandle => {
      const { push, pushAsync, finish, close } = m.createDStream(dict, windowLogMax, maxOutput);
      return {
        push: wrapSync((chunk) => bytes(push(chunk))),
        pushAsync: (chunk) => pushAsync(chunk).then(bytes, rethrowNative),
        finish: wrapSync(() => finish()),
        close: wrapSync(() => close()),
      };
    }),
  };
}
