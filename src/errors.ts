export type ZstdErrorCode =
  /** libzstd rejected the data: corrupt input, wrong dictionary, checksum mismatch, and so on. */
  | 'ERR_ZSTD_LIBRARY'
  /** The input ended before the end of a frame, or was empty. */
  | 'ERR_ZSTD_TRUNCATED'
  /** Decompressed output would exceed `maxOutputSize`. */
  | 'ERR_ZSTD_OUTPUT_LIMIT'
  | 'ERR_ZSTD_OUT_OF_MEMORY'
  | 'ERR_ZSTD_INVALID_ARGUMENT'
  /** A synchronous call was made before the WebAssembly module was loaded with `init()`. */
  | 'ERR_ZSTD_NOT_INITIALIZED';

export class ZstdError extends Error {
  readonly code: ZstdErrorCode;

  constructor(code: ZstdErrorCode, message: string) {
    super(message);
    this.name = 'ZstdError';
    this.code = code;
  }
}

// Indexed by the ZJS_ERR_* values in csrc/zjs.h.
const CODES: readonly (ZstdErrorCode | undefined)[] = [
  undefined,
  'ERR_ZSTD_LIBRARY',
  'ERR_ZSTD_TRUNCATED',
  'ERR_ZSTD_OUTPUT_LIMIT',
  'ERR_ZSTD_OUT_OF_MEMORY',
  'ERR_ZSTD_INVALID_ARGUMENT',
];

export function errorFromCore(rc: number, detail: string): ZstdError {
  const code = CODES[rc] ?? 'ERR_ZSTD_LIBRARY';
  return new ZstdError(code, code === 'ERR_ZSTD_LIBRARY' ? `zstd: ${detail}` : detail);
}

/** Converts an error thrown by the native addon into a ZstdError with a JavaScript stack. */
export function rethrowNative(error: unknown): never {
  if (error !== null && typeof error === 'object' && typeof (error as { zjsCode?: unknown }).zjsCode === 'number') {
    throw errorFromCore((error as { zjsCode: number }).zjsCode, (error as Error).message);
  }
  throw error;
}
