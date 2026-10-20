// Node.js and Bun entry: the native addon, falling back to WebAssembly when no
// prebuilt binary matches this platform. Set ZSTD_JS_BACKEND=wasm to force WebAssembly.
// Keep the export list in sync with entry-wasm.ts, entry-workerd.js and entry-react-native.ts.
import { createApi } from './api.js';
import { compileWasm, compileWasmSync } from './load-wasm-node.js';
import { loadNativeBackend } from './native-backend.js';
import type { Backend, BackendProvider } from './types.js';
import { createWasmProvider } from './wasm-provider.js';

const wasm = createWasmProvider(compileWasm, compileWasmSync);
let native: Backend | undefined;
let nativeUnavailable = process.env['ZSTD_JS_BACKEND'] === 'wasm';

function tryNative(): Backend | undefined {
  if (native || nativeUnavailable) return native;
  try {
    native = loadNativeBackend();
  } catch {
    nativeUnavailable = true;
  }
  return native;
}

const provider: BackendProvider = {
  get: async () => tryNative() ?? wasm.get(),
  getSync: () => tryNative() ?? wasm.getSync(),
  ready: () => tryNative() ?? wasm.ready(),
  init: async (source) => {
    if (!tryNative()) await wasm.init(source);
  },
  kind: () => (tryNative() ? 'native' : 'wasm'),
};

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
} = createApi(provider);

export { isZstdFrame } from './api.js';
export { ZstdError, type ZstdErrorCode } from './errors.js';
export type { BackendKind, Bytes, CompressOptions, DecompressOptions, WasmSource } from './types.js';
export { DEFAULT_LEVEL, MAX_LEVEL, MIN_LEVEL, ZSTD_VERSION } from './version.js';
