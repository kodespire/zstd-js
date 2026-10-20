// Cloudflare Workers entry. Workers cannot compile WebAssembly from bytes at
// runtime, so the module is imported statically and bundled by wrangler.
// Copied to dist/ as-is; types come from entry-wasm.d.ts.
// Keep the export list in sync with entry-wasm.ts and entry-node.ts.
import wasmModule from './zstd.wasm';

import { createApi } from './api.js';
import { compileFrom } from './wasm-source.js';
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
} = createApi(
  createWasmProvider(
    (source) => compileFrom(source ?? wasmModule),
    () => wasmModule,
  ),
);

export { isZstdFrame } from './api.js';
export { ZstdError } from './errors.js';
export { DEFAULT_LEVEL, MAX_LEVEL, MIN_LEVEL, ZSTD_VERSION } from './version.js';
