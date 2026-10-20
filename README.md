# zstd-js

[![CI](https://github.com/kodespire/zstd-js/actions/workflows/ci.yml/badge.svg)](https://github.com/kodespire/zstd-js/actions/workflows/ci.yml)
[![React Native](https://github.com/kodespire/zstd-js/actions/workflows/react-native.yml/badge.svg)](https://github.com/kodespire/zstd-js/actions/workflows/react-native.yml)

Zstandard compression for Node.js, Bun, Deno, browsers, edge runtimes and React Native, with one API everywhere.

- **The official library.** Compiled from [facebook/zstd](https://github.com/facebook/zstd) v1.5.7, pinned as a git submodule. A weekly job opens a PR when upstream releases.
- **Native where possible, WebAssembly everywhere else.** Node.js and Bun use a Node-API addon, and React Native uses a JSI module. Browsers, Deno and Workers use WebAssembly built from the same C code. If no prebuilt binary matches your platform, the package switches to WebAssembly on its own.
- **No install scripts.** Prebuilt binaries ship inside the package. `npm install` never downloads or compiles anything.
- **Never returns partial data.** Cut-off input, corrupt input and output over your size limit all throw. They never return what was decoded so far.

Part of the [compression-js](https://github.com/kodespire/compression-js) family.

```sh
npm install @kodespire/zstd-js
```

## Usage

```js
import { compress, decompress } from '@kodespire/zstd-js';

const packed = await compress(data, { level: 19 }); // or compress(data, 19)
const unpacked = await decompress(packed, { maxOutputSize: 64 * 1024 * 1024 });
```

`data` can be a `Uint8Array`, a Node `Buffer`, an `ArrayBuffer`, any typed array or `DataView`, or a string (encoded as UTF-8). Results are always `Uint8Array`.

### Streams

`createCompressStream()` and `createDecompressStream()` return standard [`TransformStream`](https://developer.mozilla.org/docs/Web/API/TransformStream)s, which work in every runtime:

```js
const response = await fetch(url);
const body = response.body.pipeThrough(createDecompressStream());
```

In Node.js, wrap them with `Duplex.fromWeb` to use them in a pipeline:

```js
import { createReadStream, createWriteStream } from 'node:fs';
import { Duplex } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createCompressStream } from '@kodespire/zstd-js';

await pipeline(
  createReadStream('data.json'),
  Duplex.fromWeb(createCompressStream({ level: 19 })),
  createWriteStream('data.json.zst'),
);
```

### Synchronous calls

`compressSync` and `decompressSync` behave like their async versions.

- **Node.js and Bun:** they work right away.
- **Browsers, Deno and Workers:** the WebAssembly module loads asynchronously, so call `await init()` once first.

The async functions load the module on demand.

```js
import { init, compressSync } from '@kodespire/zstd-js';

await init();
const packed = compressSync('hello');
```

### React Native

```sh
npm install @kodespire/zstd-js
cd ios && pod install
```

Then rebuild the app (`npx react-native run-ios`, `run-android`, or `npx expo run:ios` and `run:android`). The package contains a C++ TurboModule compiled from the same C code as the other builds. Autolinking adds it to the iOS build (CocoaPods) and the Android build (CMake). It needs React Native 0.84 or later with the New Architecture, which is the default. The API, options and error codes are the same as everywhere else.

- **Expo:** works in development builds and EAS builds. **Expo Go can't load it**, because Expo Go only contains Expo's own native code. In Expo Go, calls reject with `ERR_ZSTD_NOT_INITIALIZED` and a message saying so. There's no fallback: Hermes has no WebAssembly.
- **Async calls run on background threads**, so `await compress(bigFile)` doesn't block the JS thread. The sync versions run on the JS thread.
- **Streams need a `TransformStream`**, and Hermes doesn't have one. Expo installs one. In bare React Native, install [web-streams-polyfill](https://github.com/MattiasBuelens/web-streams-polyfill) and `import 'web-streams-polyfill/polyfill'` once at startup. Without it, `createCompressStream()` throws a `TypeError` that says this. The package doesn't bundle a polyfill: React Native's `fetch` doesn't stream bodies, so there's little to pipe, Expo already ships one, and a second copy would add about 65 KB to every app.
- **Web (Expo web, react-native-web):** the web build gets the WebAssembly version, like any browser build. Metro doesn't copy `zstd.wasm`, so put `node_modules/@kodespire/zstd-js/dist/zstd.wasm` in your `public/` folder and call `await init('/zstd.wasm')` before the first call.

### Untrusted input

A few KB of zstd can expand to gigabytes. Always pass `maxOutputSize` when decompressing data you don't control. Decoding stops as soon as the limit is crossed:

```js
try {
  await decompress(upload, { maxOutputSize: 10 * 1024 * 1024 });
} catch (error) {
  if (error.code === 'ERR_ZSTD_OUTPUT_LIMIT') rejectUpload();
}
```

### Dictionaries

Small, similar payloads (JSON records, log lines) compress much better with a dictionary trained on samples, for example with `zstd --train samples/* -o dict`:

```js
const packed = await compress(record, { dictionary });
const unpacked = await decompress(packed, { dictionary });
```

## API

| Function | Description |
| --- | --- |
| `compress(data, options?)` | Compresses into one zstd frame. Returns `Promise<Uint8Array>`. |
| `decompress(data, options?)` | Decompresses every frame in `data`. Returns `Promise<Uint8Array>`. |
| `compressSync` / `decompressSync` | Synchronous versions (see above). |
| `createCompressStream(options?)` | `TransformStream` that compresses its input into one frame. |
| `createDecompressStream(options?)` | `TransformStream` that decompresses. Errors on cut-off, corrupt or oversized input. |
| `getFrameContentSize(data)` | Size recorded in the first frame's header, or `null` if the header doesn't record it. |
| `isZstdFrame(data)` | `true` if `data` starts with a zstd or skippable frame. |
| `init(source?)` | Loads the backend. `source` can be a URL, `Response`, bytes or `WebAssembly.Module` for `zstd.wasm`. |
| `activeBackend()` | `'native'` or `'wasm'`. |
| `ZSTD_VERSION`, `MIN_LEVEL`, `MAX_LEVEL`, `DEFAULT_LEVEL` | `'1.5.7'`, `-131072`, `22`, `3`. |

**Compress options**

| Option | Default | |
| --- | --- | --- |
| `level` | `3` | `-131072` (fastest) to `22` (smallest). A number in place of the options object sets just the level. |
| `checksum` | `true` | Adds a 4-byte checksum so corruption is detected when decompressing. |
| `dictionary` | none | Compress with a dictionary. |

**Decompress options**

| Option | Default | |
| --- | --- | --- |
| `maxOutputSize` | `Infinity` | Throw `ERR_ZSTD_OUTPUT_LIMIT` rather than produce more bytes than this. |
| `dictionary` | none | Dictionary the data was compressed with. |
| `windowLogMax` | `27` | Largest window the decoder accepts, from 10 to 31. Raise it for data compressed with `--long` or a large window. |

An unknown option name throws a `TypeError`. A typo like `{ compressionLevel: 19 }` fails loudly instead of quietly compressing at level 3.

**Errors** are `ZstdError` instances, each with a `code`:

| Code | Meaning |
| --- | --- |
| `ERR_ZSTD_TRUNCATED` | The input ended partway through a frame, or was empty. |
| `ERR_ZSTD_OUTPUT_LIMIT` | The output would exceed `maxOutputSize`. |
| `ERR_ZSTD_LIBRARY` | zstd rejected the data: corrupt input, checksum mismatch, wrong dictionary, window too large. |
| `ERR_ZSTD_NOT_INITIALIZED` | A sync function was called in a browser or Worker before `await init()`, or the React Native module isn't in the app (Expo Go). |
| `ERR_ZSTD_OUT_OF_MEMORY`, `ERR_ZSTD_INVALID_ARGUMENT` | As named. |

## Behaviour details

- **Empty input is an error** (`ERR_ZSTD_TRUNCATED`), the same as the `zstd` command-line tool. Compressing an empty input gives a valid 13-byte frame, and that frame decompresses back to empty.
- **Concatenated frames** decompress to the concatenated contents, as `zstd -d` does. **Skippable frames** are skipped. Because joined frames are valid zstd, input cut off exactly at a frame boundary can't be told apart from complete input. Use one frame per message if that matters.
- **The checksum is on by default**, unlike the zstd library default. It costs 4 bytes per frame, and without it some corruption decodes silently to wrong bytes.
- **The async functions use separate threads only on the native backends.** The Node addon runs them on Node's thread pool, and React Native on a small pool of its own. The WebAssembly backend runs on the calling thread, so for large inputs in a browser, call it from a Web Worker.
- **Forcing WebAssembly:** set `ZSTD_JS_BACKEND=wasm` in Node.js, or import `@kodespire/zstd-js/wasm` in any runtime.

## Runtimes

| Runtime | Backend | Tested in CI |
| --- | --- | --- |
| Node.js 22.12+, 24, 26 | native | Linux x64/arm64, macOS, Windows |
| Bun | native | Linux |
| Deno 2 | WebAssembly | Linux |
| Chromium, Firefox, WebKit | WebAssembly | Playwright, through Vite |
| Cloudflare Workers (`workerd` condition) | WebAssembly | `wrangler dev` (workerd) |
| React Native 0.84+ on iOS and Android (`react-native` condition) | native (JSI) | iOS simulator, Android emulator |

Prebuilt native binaries cover:
- macOS arm64 and x64
- Linux x64 and arm64 (glibc 2.28+ and musl)
- Windows x64 and arm64

Bundlers that understand `new URL('./zstd.wasm', import.meta.url)`, such as Vite, webpack 5 and Parcel, pick up the WebAssembly file automatically. For anything else, including Metro for the web, serve `@kodespire/zstd-js/zstd.wasm` yourself and pass its URL to `init()`.

## Development

```sh
git clone --recursive https://github.com/kodespire/zstd-js
npm install
npm run build:native   # Node-API addon (needs Python 3 and a C/C++ compiler)
npm run build:wasm     # zstd.wasm (needs Emscripten; see .emsdk-version)
npm run build:ts       # dist/
node scripts/build-zstd-cli.mjs   # official zstd CLI, for the interop tests
npm test
BROWSERS=chromium npx vitest run -c vitest.browser.config.ts
```

The React Native example app runs a self-test on a simulator or emulator. Its `npm install` packs the package the way npm would publish it, so build `dist/` first:

```sh
cd example/react-native
npm install
(cd ios && bundle install && bundle exec pod install)
npm run selftest:ios       # boots a simulator if none is running
npm run selftest:android   # start an emulator first; needs ANDROID_HOME
```

All compression logic is in `csrc/zjs.c`, which every build shares. `csrc/addon.cc` (Node-API), `cpp/KodespireZstdModule.cpp` (React Native) and `src/wasm-backend.ts` (WebAssembly) only move bytes in and out. The tests run every case against both backends. They also check:
- decoding of output from the official CLI, and the CLI decoding ours
- streaming split at random points

## License

MIT. The bundled zstd library is BSD-licensed; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
