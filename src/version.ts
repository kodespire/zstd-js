// Must match deps/zstd (checked by test/version.test.ts).
/** Version of the bundled zstd library, the same for the native and WebAssembly builds. */
export const ZSTD_VERSION = '1.5.7';
/** Fastest (lowest-ratio) compression level. */
export const MIN_LEVEL = -131072;
/** Highest-ratio compression level. */
export const MAX_LEVEL = 22;
/** Level used when none is given. */
export const DEFAULT_LEVEL = 3;
