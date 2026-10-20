// The documented public API. This file only declares; each entry point
// (entry-node.ts, entry-wasm.ts, entry-workerd.js, entry-react-native.ts) implements it, and
// test/types.test-d.ts checks that they match. package.json points "types" here.
import type { BackendKind, Bytes, CompressOptions, DecompressOptions, WasmSource } from './types.js';

/**
 * Compresses `data` into a single zstd frame.
 *
 * @param data Bytes to compress. Strings are encoded as UTF-8.
 * @param options Options, or just a compression level (`compress(data, 19)`).
 * @example
 * const packed = await compress(data, { level: 19 });
 */
export declare function compress(data: Bytes | string, options?: CompressOptions | number): Promise<Uint8Array>;

/**
 * Synchronous {@link compress}. In browsers, Deno and Workers, `await init()` must have run first.
 */
export declare function compressSync(data: Bytes | string, options?: CompressOptions | number): Uint8Array;

/**
 * Decompresses every frame in `data` (concatenated frames are joined, skippable frames skipped).
 *
 * Throws a {@link ZstdError} with code `ERR_ZSTD_TRUNCATED` if the input is empty or ends
 * partway through a frame, `ERR_ZSTD_OUTPUT_LIMIT` if the output would exceed `maxOutputSize`,
 * and `ERR_ZSTD_LIBRARY` if the data is corrupt or not zstd. It never returns partial output.
 *
 * @example
 * const data = await decompress(packed, { maxOutputSize: 64 * 1024 * 1024 });
 */
export declare function decompress(data: Bytes, options?: DecompressOptions): Promise<Uint8Array>;

/**
 * Synchronous {@link decompress}. In browsers, Deno and Workers, `await init()` must have run first.
 */
export declare function decompressSync(data: Bytes, options?: DecompressOptions): Uint8Array;

/**
 * The decompressed size recorded in the first frame's header, or `null` when the header does not
 * record it (typical for streamed output). Headers are untrusted input: still set `maxOutputSize`.
 */
export declare function getFrameContentSize(data: Bytes): number | null;

/**
 * A TransformStream that compresses everything written to it into one zstd frame.
 *
 * @example
 * const compressed = file.stream().pipeThrough(createCompressStream({ level: 9 }));
 */
export declare function createCompressStream(options?: CompressOptions | number): TransformStream<Bytes, Uint8Array>;

/**
 * A TransformStream that decompresses zstd data. The stream errors if the input is corrupt,
 * ends partway through a frame, or exceeds `maxOutputSize` in total.
 *
 * @example
 * const body = response.body.pipeThrough(createDecompressStream());
 */
export declare function createDecompressStream(options?: DecompressOptions): TransformStream<Bytes, Uint8Array>;

/**
 * Loads the backend ahead of time. Needed before the synchronous functions in browsers, Deno and
 * Workers; optional elsewhere.
 *
 * @param source Where to load `zstd.wasm` from (URL, path, `Response`, bytes or a compiled
 *   `WebAssembly.Module`). Ignored when the native addon is in use.
 */
export declare function init(source?: WasmSource): Promise<void>;

/** Which implementation is running: `'native'` (Node-API addon) or `'wasm'`. */
export declare function activeBackend(): BackendKind;

export { isZstdFrame } from './api.js';
export { ZstdError, type ZstdErrorCode } from './errors.js';
export type { BackendKind, Bytes, CompressOptions, DecompressOptions, WasmSource } from './types.js';
export { DEFAULT_LEVEL, MAX_LEVEL, MIN_LEVEL, ZSTD_VERSION } from './version.js';
