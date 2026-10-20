/** Binary input accepted everywhere: any ArrayBuffer, typed array, DataView or Node Buffer. */
export type Bytes = ArrayBuffer | ArrayBufferView;

export interface CompressOptions {
  /**
   * Compression level, from MIN_LEVEL (-131072, fastest) to MAX_LEVEL (22, smallest).
   * Negative levels trade ratio for speed. Defaults to 3, the zstd default.
   */
  level?: number;
  /** Append a 4-byte XXH64 checksum so corruption is detected on decompression. Defaults to true. */
  checksum?: boolean;
  /** Compress with a dictionary. The same dictionary is required to decompress. */
  dictionary?: Bytes;
}

export interface DecompressOptions {
  /**
   * Throw ERR_ZSTD_OUTPUT_LIMIT instead of producing more than this many bytes.
   * Set it whenever the input is untrusted. Defaults to Infinity.
   */
  maxOutputSize?: number;
  /** Dictionary the data was compressed with. */
  dictionary?: Bytes;
  /**
   * Largest window (as a power of two) the decoder accepts, 10 to 31. Frames written with
   * `--long` or large windows need this raised above the default of 27 (128 MiB).
   */
  windowLogMax?: number;
}

/** Where the WebAssembly module comes from, for `init()`. */
export type WasmSource =
  | WebAssembly.Module
  | Bytes
  | URL
  | string
  | Response
  | PromiseLike<Response>;

export type BackendKind = 'native' | 'wasm';

/** @internal Mode values match ZJS_MODE_* in csrc/zjs.h. */
export const MODE_CONTINUE = 0;
/** @internal */
export const MODE_END = 2;

/** @internal */
export interface CStreamHandle {
  push(chunk: Uint8Array, mode: number): Uint8Array;
  pushAsync(chunk: Uint8Array, mode: number): Promise<Uint8Array>;
  close(): void;
}

/** @internal */
export interface DStreamHandle {
  push(chunk: Uint8Array): Uint8Array;
  pushAsync(chunk: Uint8Array): Promise<Uint8Array>;
  finish(): void;
  close(): void;
}

/** @internal What each backend (native addon, WebAssembly) implements. Errors are ZstdError. */
export interface Backend {
  readonly kind: BackendKind;
  readonly version: string;
  compressSync(data: Uint8Array, level: number, checksum: boolean, dict: Uint8Array | null): Uint8Array;
  compress(data: Uint8Array, level: number, checksum: boolean, dict: Uint8Array | null): Promise<Uint8Array>;
  decompressSync(data: Uint8Array, dict: Uint8Array | null, windowLogMax: number, maxOutput: number): Uint8Array;
  decompress(data: Uint8Array, dict: Uint8Array | null, windowLogMax: number, maxOutput: number): Promise<Uint8Array>;
  /** -1 when the frame header does not record the size. */
  frameContentSize(data: Uint8Array): number;
  createCStream(level: number, checksum: boolean, dict: Uint8Array | null): CStreamHandle;
  createDStream(dict: Uint8Array | null, windowLogMax: number, maxOutput: number): DStreamHandle;
}

/** @internal How an entry point supplies its backend to the public API. */
export interface BackendProvider {
  get(): Promise<Backend>;
  getSync(): Backend;
  init(source?: WasmSource): Promise<void>;
  kind(): BackendKind;
}
