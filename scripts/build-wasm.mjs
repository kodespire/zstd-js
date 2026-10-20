// Builds out/wasm/zstd.wasm from the same C sources as the native addon.
// Requires Emscripten (emcc) on PATH: https://emscripten.org/docs/getting_started/
import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { sources } = require('./zstd-sources.cjs');

const exported = [
  'malloc',
  'free',
  'zjs_buf_free',
  'zjs_compress',
  'zjs_decompress',
  'zjs_cstream_create',
  'zjs_cstream_push',
  'zjs_cstream_free',
  'zjs_dstream_create',
  'zjs_dstream_push',
  'zjs_dstream_finish',
  'zjs_dstream_free',
  'zjs_frame_content_size',
  'zjs_version',
  'zjs_min_level',
  'zjs_max_level',
  'zjs_default_level',
].map((name) => `_${name}`);

const out = join(root, 'out', 'wasm', 'zstd.wasm');
mkdirSync(dirname(out), { recursive: true });

const args = [
  '-O3',
  '-flto',
  '-DNDEBUG',
  '-DZSTD_LEGACY_SUPPORT=0',
  '-DZSTD_DISABLE_ASM',
  '-DZSTD_NO_TRACE',
  '-DXXH_NAMESPACE=ZSTD_',
  '-Ideps/zstd/lib',
  '-Ideps/zstd/lib/common',
  'csrc/zjs.c',
  ...sources(),
  '--no-entry',
  // A plain .wasm with no Emscripten JS glue; src/wasm-backend.ts is the loader.
  '-sSTANDALONE_WASM=1',
  '-sFILESYSTEM=0',
  '-sALLOW_MEMORY_GROWTH=1',
  '-sINITIAL_MEMORY=2MB',
  '-sMAXIMUM_MEMORY=4GB',
  '-sSTACK_SIZE=256KB',
  '-sERROR_ON_UNDEFINED_SYMBOLS=1',
  `-sEXPORTED_FUNCTIONS=${exported.join(',')}`,
  '-o',
  out,
];

try {
  execFileSync('emcc', args, { cwd: root, stdio: 'inherit' });
} catch (error) {
  if (error.code === 'ENOENT') {
    console.error('emcc not found. Install Emscripten and run `source <emsdk>/emsdk_env.sh` first.');
    process.exit(1);
  }
  throw error;
}
console.log(`built ${out} (${statSync(out).size} bytes)`);
