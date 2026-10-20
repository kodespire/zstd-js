// Loads zstd.wasm with fetch(). Used by browsers, Deno and other non-Node runtimes.
// Bundlers (Vite, webpack, Parcel) recognise `new URL('./zstd.wasm', import.meta.url)`
// and emit the file as an asset.
import { ZstdError } from './errors.js';
import type { WasmSource } from './types.js';
import { compileFrom } from './wasm-source.js';

export async function compileWasm(source?: WasmSource): Promise<WebAssembly.Module> {
  const s = source ?? new URL('./zstd.wasm', import.meta.url);
  if (s instanceof URL || typeof s === 'string') return compileFrom(fetch(s));
  return compileFrom(s);
}

export function compileWasmSync(): WebAssembly.Module {
  throw new ZstdError(
    'ERR_ZSTD_NOT_INITIALIZED',
    'zstd-js: call `await init()` before using synchronous functions in this runtime',
  );
}
