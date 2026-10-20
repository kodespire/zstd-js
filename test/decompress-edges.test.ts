// The decompression loop is where zstd bindings usually go wrong: output that
// fills a buffer exactly, frames without a recorded size, concatenated and
// skippable frames, and input that ends mid-frame. Every case runs on both backends.
import { describe, expect, it } from 'vitest';

import { backends, concat, errorCode, pipeChunks, randomBytes, skippableFrame, syncErrorCode, textBytes } from './helpers.js';

// Sizes around libzstd's 128 KiB block / streaming buffer size and the
// binding's 64 KiB initial allocation and 1.5x growth steps.
const BOUNDARY_SIZES = [
  0, 1, 2, 65535, 65536, 65537, 98303, 98304, 98305, 131071, 131072, 131073,
  147456, 196607, 196608, 196609, 262143, 262144, 262145, 1 << 20, (1 << 20) + 1,
];

describe.each(backends)('%s backend: decompression edge cases', (name, z) => {
  it('reports the expected backend', () => {
    expect(z.activeBackend()).toBe(name);
  });

  it.each(BOUNDARY_SIZES)('frame with recorded size, %i bytes', async (size) => {
    const src = textBytes(size, size + 1);
    const frame = z.compressSync(src);
    expect(z.getFrameContentSize(frame)).toBe(size);
    expect(z.decompressSync(frame)).toEqual(src);
    expect(await z.decompress(frame)).toEqual(src);
    // A limit equal to the exact size must pass; one byte less must not.
    expect(z.decompressSync(frame, { maxOutputSize: size })).toEqual(src);
    if (size > 0) expect(syncErrorCode(() => z.decompressSync(frame, { maxOutputSize: size - 1 }))).toBe('ERR_ZSTD_OUTPUT_LIMIT');
  });

  it.each(BOUNDARY_SIZES)('streamed frame without recorded size, %i bytes', async (size) => {
    const src = randomBytes(size, size + 7).map((b, i) => (i % 3 === 0 ? b : 0x61)); // partly compressible
    // A compress stream never knows the total size, so the header omits it.
    const frame = await pipeChunks(z.createCompressStream({ checksum: false }), src, () => 50_000);
    // libzstd records the size only when the whole input arrives in the final call.
    if (size > 0) expect(z.getFrameContentSize(frame)).toBeNull();
    expect(z.decompressSync(frame)).toEqual(src);
    expect(await z.decompress(frame, { maxOutputSize: size })).toEqual(src);
  });

  it('highly compressible input: 64 MiB of zeros from a few KB', async () => {
    const src = new Uint8Array(64 << 20);
    const frame = await z.compress(src, 1);
    expect(frame.length).toBeLessThan(10_000);
    const out = await z.decompress(frame);
    expect(out.length).toBe(src.length);
    expect(out.every((b) => b === 0)).toBe(true);
  });

  it('concatenated frames decode to the concatenated input', () => {
    const a = textBytes(100_000, 1);
    const b = randomBytes(70_000, 2);
    const c = new Uint8Array(0);
    const joined = concat(z.compressSync(a), z.compressSync(b, { checksum: false }), z.compressSync(c));
    expect(z.decompressSync(joined)).toEqual(concat(a, b, c));
  });

  it('skippable frames are skipped wherever they appear', () => {
    const a = textBytes(5000, 3);
    const b = textBytes(7000, 4);
    const skip = skippableFrame(new TextEncoder().encode('metadata'), 0);
    const skipEmpty = skippableFrame(new Uint8Array(0), 15);
    const data = concat(skip, z.compressSync(a), skipEmpty, z.compressSync(b), skip);
    expect(z.decompressSync(data)).toEqual(concat(a, b));
  });

  it('input consisting only of a skippable frame decodes to nothing', () => {
    expect(z.decompressSync(skippableFrame(new Uint8Array([1, 2, 3])))).toEqual(new Uint8Array(0));
  });

  it('a valid frame holding zero bytes decodes to nothing', () => {
    expect(z.decompressSync(z.compressSync(new Uint8Array(0)))).toEqual(new Uint8Array(0));
  });
});

describe.each(backends)('%s backend: truncated and invalid input', (_name, z) => {
  it('empty input is an error, as with the zstd CLI', async () => {
    expect(syncErrorCode(() => z.decompressSync(new Uint8Array(0)))).toBe('ERR_ZSTD_TRUNCATED');
    expect(await errorCode(() => z.decompress(new Uint8Array(0)))).toBe('ERR_ZSTD_TRUNCATED');
  });

  it('every proper prefix of a frame is rejected as truncated', () => {
    const src = textBytes(3000, 9);
    for (const checksum of [true, false]) {
      const frame = z.compressSync(src, { checksum, level: 5 });
      for (let cut = 0; cut < frame.length; cut++) {
        const code = syncErrorCode(() => z.decompressSync(frame.subarray(0, cut)));
        expect(code, `cut at ${cut}/${frame.length}, checksum=${checksum}`).toBe('ERR_ZSTD_TRUNCATED');
      }
      expect(z.decompressSync(frame)).toEqual(src);
    }
  });

  it('truncating a large frame is rejected (sampled offsets)', async () => {
    const src = textBytes(3 << 20, 10);
    const frame = await z.compress(src);
    for (const cut of [1, 4, 5, 6, 13, frame.length >> 2, frame.length >> 1, frame.length - 5, frame.length - 4, frame.length - 1]) {
      expect(await errorCode(() => z.decompress(frame.subarray(0, cut))), `cut at ${cut}`).toBe('ERR_ZSTD_TRUNCATED');
    }
  });

  it('regression: 1 MB of zeros with the last 3 bytes cut is an error, not 917504 bytes', async () => {
    const frame = await z.compress(new Uint8Array(1_000_000));
    expect(await errorCode(() => z.decompress(frame.subarray(0, frame.length - 3)))).toBe('ERR_ZSTD_TRUNCATED');
  });

  it('a second frame cut short is rejected even though the first is complete', () => {
    const data = concat(z.compressSync(textBytes(1000, 1)), z.compressSync(textBytes(1000, 2)));
    expect(syncErrorCode(() => z.decompressSync(data.subarray(0, data.length - 1)))).toBe('ERR_ZSTD_TRUNCATED');
  });

  it('corrupted data is rejected when the frame has a checksum', () => {
    const src = textBytes(200_000, 11);
    const frame = z.compressSync(src);
    let rejected = 0;
    for (let i = 20; i < frame.length; i += Math.max(1, Math.floor(frame.length / 60))) {
      const bad = frame.slice();
      bad[i]! ^= 0x5a;
      const code = syncErrorCode(() => z.decompressSync(bad));
      expect(code, `flip at ${i}`).not.toBe('no error');
      rejected++;
    }
    expect(rejected).toBeGreaterThan(30);
  });

  it('trailing garbage after a frame is rejected', () => {
    const frame = z.compressSync(textBytes(1000, 1));
    expect(syncErrorCode(() => z.decompressSync(concat(frame, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))))).toBe('ERR_ZSTD_LIBRARY');
  });

  it('data that is not zstd is rejected', () => {
    expect(syncErrorCode(() => z.decompressSync(new TextEncoder().encode('definitely not zstd')))).toBe('ERR_ZSTD_LIBRARY');
  });

  it('maxOutputSize stops a decompression bomb early', async () => {
    // 1 GiB of zeros, compressed by streaming 16 MiB chunks.
    const zeros = new Uint8Array(16 << 20);
    const parts: Uint8Array[] = [];
    const stream = z.createCompressStream(1);
    const writer = stream.writable.getWriter();
    const reading = (async () => {
      for await (const p of stream.readable as unknown as AsyncIterable<Uint8Array>) parts.push(p);
    })();
    for (let i = 0; i < 64; i++) await writer.write(zeros);
    await writer.close();
    await reading;
    const bomb = concat(...parts);
    expect(bomb.length).toBeLessThan(200_000);

    const started = performance.now();
    expect(await errorCode(() => z.decompress(bomb, { maxOutputSize: 10 << 20 }))).toBe('ERR_ZSTD_OUTPUT_LIMIT');
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it('maxOutputSize: 0 accepts only empty output', () => {
    expect(z.decompressSync(z.compressSync(new Uint8Array(0)), { maxOutputSize: 0 })).toEqual(new Uint8Array(0));
    expect(syncErrorCode(() => z.decompressSync(z.compressSync('x'), { maxOutputSize: 0 }))).toBe('ERR_ZSTD_OUTPUT_LIMIT');
  });
});

