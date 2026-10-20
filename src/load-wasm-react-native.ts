// WebAssembly loader for Metro builds: the React Native entry when the native module
// is missing, and the WebAssembly entry under react-native-web (the "react-native"
// condition of "#load-wasm"). Metro does not bundle zstd.wasm and leaves import.meta
// as is, which a web page cannot even parse, so the module must be passed to init().
import { ZstdError } from './errors.js';
import type { WasmSource } from './types.js';
import { compileFrom } from './wasm-source.js';

// navigator.product is 'ReactNative' on iOS and Android, but not on the web.
const onDevice = typeof navigator !== 'undefined' && navigator.product === 'ReactNative';

const NOT_LINKED =
  'zstd-js: the KodespireZstd native module is not in this app. Rebuild the app after installing ' +
  '@kodespire/zstd-js (Expo Go cannot load native code: use a development build).';
const PASS_SOURCE =
  'zstd-js: Metro does not bundle zstd.wasm. Serve node_modules/@kodespire/zstd-js/dist/zstd.wasm ' +
  "with the app and pass its URL to init(), for example `await init('/zstd.wasm')`.";

export async function compileWasm(source?: WasmSource): Promise<WebAssembly.Module> {
  if (typeof WebAssembly === 'undefined') {
    throw new ZstdError('ERR_ZSTD_NOT_INITIALIZED', `${NOT_LINKED} This JavaScript engine has no WebAssembly to fall back to.`);
  }
  if (source === undefined) {
    throw new ZstdError('ERR_ZSTD_NOT_INITIALIZED', onDevice ? `${NOT_LINKED} To use WebAssembly instead, pass zstd.wasm to init().` : PASS_SOURCE);
  }
  if (source instanceof URL || typeof source === 'string') return compileFrom(fetch(source));
  return compileFrom(source);
}

export function compileWasmSync(): WebAssembly.Module {
  throw new ZstdError(
    'ERR_ZSTD_NOT_INITIALIZED',
    onDevice ? `${NOT_LINKED} To use WebAssembly instead, call \`await init(source)\` first.` : `${PASS_SOURCE} Synchronous functions need it loaded first.`,
  );
}
