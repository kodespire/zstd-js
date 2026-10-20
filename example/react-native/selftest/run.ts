// Self-test of @kodespire/zstd-js on a device or simulator. Each result is logged as
// one `ZSTD_SELFTEST ...` line, which scripts/selftest.mjs reads from the device log,
// and the last line is `ZSTD_SELFTEST DONE passed=N failed=M`.
import {
  activeBackend,
  compress,
  compressSync,
  createCompressStream,
  createDecompressStream,
  decompress,
  decompressSync,
  getFrameContentSize,
  init,
  isZstdFrame,
  ZSTD_VERSION,
  ZstdError,
} from '@kodespire/zstd-js';

// @ts-ignore generated plain JS
import fixtureData from './fixtures.generated';

declare const require: (id: string) => unknown;

type Log = (line: string) => void;

function fixture(name: string): Uint8Array {
  const binary = atob((fixtureData as Record<string, string>)[name]!);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Deterministic, moderately compressible bytes (the same generator as test/helpers.ts). */
function textBytes(length: number, seed = 1): Uint8Array {
  const words = ['alpha ', 'beta ', 'gamma ', 'delta ', 'zstd ', 'frame ', 'block ', '\n'];
  const out = new Uint8Array(length);
  let x = seed >>> 0 || 1;
  let i = 0;
  while (i < length) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    const w = words[(x & 0xff) % words.length]!;
    for (let j = 0; j < w.length && i < length; j++) out[i++] = w.charCodeAt(j);
  }
  return out;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertBytes(actual: Uint8Array, expected: Uint8Array, what: string): void {
  assert(actual instanceof Uint8Array, `${what}: not a Uint8Array`);
  assert(actual.length === expected.length, `${what}: length ${actual.length}, expected ${expected.length}`);
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) throw new Error(`${what}: differs at byte ${i}`);
  }
}

async function assertCode(run: () => unknown, code: string, what: string): Promise<void> {
  try {
    await run();
  } catch (error) {
    assert(error instanceof ZstdError, `${what}: threw ${String(error)}, expected a ZstdError`);
    assert(error.code === code, `${what}: code ${error.code}, expected ${code}`);
    return;
  }
  throw new Error(`${what}: did not throw ${code}`);
}

async function pipe(stream: TransformStream<Uint8Array, Uint8Array>, chunks: Uint8Array[]): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const parts: Uint8Array[] = [];
  const reading = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      parts.push(value);
    }
  })();
  const writing = (async () => {
    for (const chunk of chunks) await writer.write(chunk);
    await writer.close();
  })();
  await Promise.all([reading, writing]);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function split(data: Uint8Array, size: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += size) chunks.push(data.subarray(i, i + size));
  return chunks;
}

const tests: [name: string, run: (log: Log) => Promise<void>][] = [
  ['native backend', async (log) => {
    await init();
    assert(activeBackend() === 'native', `activeBackend() is ${activeBackend()}`);
    log(`info zstd ${ZSTD_VERSION}`);
  }],

  ['round trip', async () => {
    const data = textBytes(1 << 20);
    for (const options of [undefined, 1, { level: 19 }, { level: -5, checksum: false }]) {
      const packed = await compress(data, options);
      assert(isZstdFrame(packed), 'output is not a zstd frame');
      assert(getFrameContentSize(packed) === data.length, 'frame content size');
      assertBytes(await decompress(packed), data, `async, options ${JSON.stringify(options)}`);
      assertBytes(decompressSync(compressSync(data, options)), data, `sync, options ${JSON.stringify(options)}`);
    }
    const text = 'héllo € 😀 '.repeat(100);
    assertBytes(decompressSync(compressSync(text)), new TextEncoder().encode(text), 'string input');
    assertBytes(await decompress(await compress(new Uint8Array(0))), new Uint8Array(0), 'empty input');
    // A view into a larger buffer: only the viewed bytes are compressed.
    const view = new Uint8Array(data.buffer, 1000, 5000);
    assertBytes(await decompress(await compress(view)), data.subarray(1000, 6000), 'subarray input');
  }],

  ['frames from the zstd CLI', async () => {
    const corpus = fixture('corpus.txt');
    assertBytes(await decompress(fixture('corpus.19.zst')), corpus, 'corpus.19.zst');
    assertBytes(decompressSync(fixture('corpus.multi.zst')), corpus, 'corpus.multi.zst (concatenated frames)');
  }],

  ['truncated input', async () => {
    const packed = compressSync(textBytes(100_000));
    for (const end of [1, 4, packed.length >> 1, packed.length - 1]) {
      const cut = packed.subarray(0, end);
      await assertCode(() => decompress(cut), 'ERR_ZSTD_TRUNCATED', `decompress, ${end} bytes`);
      await assertCode(() => decompressSync(cut), 'ERR_ZSTD_TRUNCATED', `decompressSync, ${end} bytes`);
    }
    await assertCode(() => decompress(new Uint8Array(0)), 'ERR_ZSTD_TRUNCATED', 'empty input');
    const corrupt = packed.slice();
    corrupt[corrupt.length >> 1] ^= 0xff;
    await assertCode(() => decompress(corrupt), 'ERR_ZSTD_LIBRARY', 'corrupt input');
  }],

  ['maxOutputSize', async () => {
    const data = textBytes(200_000);
    const packed = await compress(data);
    await assertCode(() => decompress(packed, { maxOutputSize: data.length - 1 }), 'ERR_ZSTD_OUTPUT_LIMIT', 'async, one byte short');
    await assertCode(() => decompressSync(packed, { maxOutputSize: 0 }), 'ERR_ZSTD_OUTPUT_LIMIT', 'sync, limit 0');
    assertBytes(await decompress(packed, { maxOutputSize: data.length }), data, 'exact limit');
    await assertCode(() => decompress(new Uint8Array(0), { maxOutputSize: 10 }), 'ERR_ZSTD_TRUNCATED', 'empty input with a limit');
  }],

  ['async work runs off the JS thread', async (log) => {
    // Grow the input until one async compress takes long enough to measure, then
    // check the JS thread kept running timers the whole time.
    let size = 4 << 20;
    for (;;) {
      const data = textBytes(size);
      let last = performance.now();
      let maxGap = 0;
      let ticks = 0;
      const timer = setInterval(() => {
        const now = performance.now();
        maxGap = Math.max(maxGap, now - last);
        last = now;
        ticks++;
      }, 10);
      const start = performance.now();
      const packed = await compress(data, 19);
      const elapsed = performance.now() - start;
      clearInterval(timer);
      if (elapsed < 400 && size < 64 << 20) {
        size *= 2;
        continue;
      }
      assertBytes(decompressSync(packed), data, 'output');
      log(`info compress(${size >> 20} MiB, 19): ${elapsed.toFixed(0)} ms, ${ticks} timer ticks, longest JS stall ${maxGap.toFixed(0)} ms`);
      assert(ticks >= 10, `only ${ticks} timer ticks in ${elapsed.toFixed(0)} ms`);
      assert(maxGap < elapsed / 2, `JS thread stalled for ${maxGap.toFixed(0)} ms of ${elapsed.toFixed(0)} ms`);
      break;
    }
    // Several jobs at once, and inputs captured at call time.
    const inputs = [1, 2, 3, 4].map((seed) => textBytes(500_000, seed));
    const expected = inputs.map((input) => input.slice());
    const pending = inputs.map((input) => compress(input, 3));
    for (const input of inputs) input.fill(0);
    const outputs = await Promise.all(pending);
    for (let i = 0; i < outputs.length; i++) assertBytes(decompressSync(outputs[i]!), expected[i]!, `job ${i}`);
  }],

  ['dictionary', async () => {
    const dictionary = fixture('dict.bin');
    const record = fixture('record.json');
    assertBytes(await decompress(fixture('record.dict.zst'), { dictionary }), record, 'frame from the zstd CLI');
    const packed = await compress(record, { dictionary, level: 19 });
    assertBytes(decompressSync(packed, { dictionary }), record, 'round trip');
    assert(packed.length < compressSync(record, 19).length, 'dictionary did not shrink the output');
    await assertCode(() => decompress(packed), 'ERR_ZSTD_LIBRARY', 'without the dictionary');
    // Raw-content dictionaries work too.
    const raw = textBytes(20_000, 9);
    const rawPacked = compressSync(textBytes(1000, 9), { dictionary: raw });
    assertBytes(await decompress(rawPacked, { dictionary: raw }), textBytes(1000, 9), 'raw dictionary');
  }],

  ['options are checked', async () => {
    let threw = false;
    try {
      compressSync(new Uint8Array(1), { compressionLevel: 3 } as never);
    } catch (error) {
      threw = error instanceof TypeError;
    }
    assert(threw, 'an unknown option did not throw a TypeError');
  }],

  ['streams', async (log) => {
    if (typeof TransformStream === 'undefined') {
      let message = '';
      try {
        createCompressStream();
      } catch (error) {
        message = String(error);
      }
      assert(/TransformStream/.test(message), `without a TransformStream: ${message || 'no error'}`);
      require('web-streams-polyfill/polyfill');
      log('info no global TransformStream: using web-streams-polyfill');
    }
    const data = textBytes(1 << 20, 5);
    const packed = await pipe(createCompressStream({ level: 5 }), split(data, 65_536));
    assertBytes(decompressSync(packed), data, 'compress stream');
    assertBytes(await pipe(createDecompressStream(), split(packed, 7_000)), data, 'decompress stream');
    const dictionary = fixture('dict.bin');
    const record = fixture('record.json');
    const dictPacked = await pipe(createCompressStream({ dictionary }), [record]);
    assertBytes(decompressSync(dictPacked, { dictionary }), record, 'dictionary stream');
    await assertCode(() => pipe(createDecompressStream(), [packed.subarray(0, packed.length - 3)]), 'ERR_ZSTD_TRUNCATED', 'truncated stream');
    await assertCode(() => pipe(createDecompressStream({ maxOutputSize: 1000 }), [packed]), 'ERR_ZSTD_OUTPUT_LIMIT', 'stream over maxOutputSize');
  }],

  ['speed', async (log) => {
    const data = textBytes(8 << 20);
    let start = performance.now();
    const packed = compressSync(data);
    const compressMs = performance.now() - start;
    start = performance.now();
    decompressSync(packed);
    const decompressMs = performance.now() - start;
    const mbps = (ms: number) => (data.length / 1e6 / (ms / 1000)).toFixed(0);
    log(`info level 3, 8 MiB: compress ${mbps(compressMs)} MB/s, decompress ${mbps(decompressMs)} MB/s, ratio ${(data.length / packed.length).toFixed(2)}`);
  }],
];

export async function runSelfTest(log: Log): Promise<boolean> {
  let passed = 0;
  let failed = 0;
  for (const [name, run] of tests) {
    const start = performance.now();
    try {
      await run(log);
      passed++;
      log(`ok ${name} (${(performance.now() - start).toFixed(0)} ms)`);
    } catch (error) {
      failed++;
      log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  log(`DONE passed=${passed} failed=${failed}`);
  return failed === 0;
}
