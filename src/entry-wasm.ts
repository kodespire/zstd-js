// WebAssembly entry: browsers, Deno, and anything without the native addon.
// Keep the export list in sync with entry-node.ts, entry-workerd.js and entry-react-native.ts.
import { compileWasm, compileWasmSync } from '#load-wasm';

import { createApi } from './api.js';
import { createWasmProvider } from './wasm-provider.js';

export const {
  compress,
  compressSync,
  decompress,
  decompressSync,
  getFrameContentSize,
  createCompressStream,
  createDecompressStream,
  init,
  activeBackend,
} = createApi(createWasmProvider(compileWasm, compileWasmSync));

export { isZstdFrame } from './api.js';
export { ZstdError, type ZstdErrorCode } from './errors.js';
export type { BackendKind, Bytes, CompressOptions, DecompressOptions, WasmSource } from './types.js';
export { DEFAULT_LEVEL, MAX_LEVEL, MIN_LEVEL, ZSTD_VERSION } from './version.js';
