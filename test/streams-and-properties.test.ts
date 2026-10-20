import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { backends, concat, errorCode, pipeChunks, randomBytes, textBytes } from './helpers.js';

describe.each(backends)('%s backend: streams', (_name, z) => {
  it('compress stream output decodes with one-shot decompress, for many chunk sizes', async () => {
    const src = textBytes(1_000_000, 21);
    for (const chunk of [1_000, 64 * 1024, 131_072, 300_000, 2_000_000]) {
      const frame = await pipeChunks(z.createCompressStream(), src, () => chunk);
      expect(z.decompressSync(frame), `chunk ${chunk}`).toEqual(src);
    }
  });

  it('decompress stream handles input split at every kind of boundary', async () => {
    const src = textBytes(400_000, 22);
    const frame = z.compressSync(src, { level: 7 });
    for (const chunk of [1, 3, 4096, 65_536, frame.length]) {
      const out = await pipeChunks(z.createDecompressStream(), frame, () => chunk);
      expect(out, `chunk ${chunk}`).toEqual(src);
    }
  });

  it('decompress stream handles concatenated frames split mid-frame', async () => {
    const a = textBytes(100_000, 1);
    const b = randomBytes(50_000, 2);
    const data = concat(z.compressSync(a), z.compressSync(b));
    expect(await pipeChunks(z.createDecompressStream(), data, () => 999)).toEqual(concat(a, b));
  });

  it('decompress stream errors on input that ends mid-frame', async () => {
    const frame = z.compressSync(textBytes(100_000, 3));
    expect(await errorCode(() => pipeChunks(z.createDecompressStream(), frame.subarray(0, frame.length - 1)))).toBe('ERR_ZSTD_TRUNCATED');
  });

  it('decompress stream errors when no input arrives at all', async () => {
    expect(await errorCode(() => pipeChunks(z.createDecompressStream(), new Uint8Array(0)))).toBe('ERR_ZSTD_TRUNCATED');
  });

  it('decompress stream enforces maxOutputSize across chunks', async () => {
    const frame = z.compressSync(new Uint8Array(5 << 20));
    expect(await errorCode(() => pipeChunks(z.createDecompressStream({ maxOutputSize: 1 << 20 }), frame, () => 10)))
      .toBe('ERR_ZSTD_OUTPUT_LIMIT');
    expect((await pipeChunks(z.createDecompressStream({ maxOutputSize: 5 << 20 }), frame, () => 10)).length).toBe(5 << 20);
  });

  it('decompress stream errors on corrupt input', async () => {
    const frame = z.compressSync(textBytes(100_000, 4));
    frame[frame.length >> 1]! ^= 0xff;
    expect(await errorCode(() => pipeChunks(z.createDecompressStream(), frame))).not.toBe('no error');
  });

  it('streams with a dictionary', async () => {
    const dictionary = textBytes(8_000, 5);
    const src = textBytes(50_000, 5);
    const frame = await pipeChunks(z.createCompressStream({ dictionary }), src);
    expect(z.decompressSync(frame, { dictionary })).toEqual(src);
    expect(await pipeChunks(z.createDecompressStream({ dictionary }), frame, () => 100)).toEqual(src);
  });

  it('many concurrent async calls return the right results', async () => {
    const inputs = Array.from({ length: 64 }, (_, i) => textBytes(20_000 + i * 997, i));
    const frames = await Promise.all(inputs.map((src, i) => z.compress(src, (i % 19) + 1)));
    const outputs = await Promise.all(frames.map((f) => z.decompress(f)));
    outputs.forEach((out, i) => expect(out).toEqual(inputs[i]));
  });
});

describe.each(backends)('%s backend: properties', (_name, z) => {
  it('decompress(compress(x)) === x for arbitrary bytes and options', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 20_000 }),
        fc.integer({ min: -10, max: 12 }),
        fc.boolean(),
        (src, level, checksum) => {
          expect(z.decompressSync(z.compressSync(src, { level, checksum }))).toEqual(src);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('chunked streaming matches one-shot for arbitrary splits', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 1, maxLength: 200_000 }).map((a) => a.map((b, i) => (i % 4 ? b & 0x0f : b))),
        fc.array(fc.integer({ min: 1, max: 70_000 }), { minLength: 1, maxLength: 20 }),
        async (src, sizes) => {
          const frame = await pipeChunks(z.createCompressStream(), src, (i) => sizes[i % sizes.length]!);
          expect(z.decompressSync(frame)).toEqual(src);
          const out = await pipeChunks(z.createDecompressStream(), frame, (i) => sizes[(i + 1) % sizes.length]!);
          expect(out).toEqual(src);
        },
      ),
      { numRuns: 40 },
    );
  });
});

describe('native and wasm agree', () => {
  const [[, native], [, wasm]] = backends;

  it('each decodes the other’s output', async () => {
    for (const level of [-3, 1, 3, 12, 19]) {
      const src = textBytes(300_000, level + 50);
      expect(wasm.decompressSync(native.compressSync(src, { level }))).toEqual(src);
      expect(native.decompressSync(wasm.compressSync(src, { level }))).toEqual(src);
      const streamed = await pipeChunks(native.createCompressStream({ level }), src, () => 50_000);
      expect(await pipeChunks(wasm.createDecompressStream(), streamed, () => 1234)).toEqual(src);
    }
  });

  it('report the same zstd version as the bundled source', () => {
    expect(native.ZSTD_VERSION).toBe(wasm.ZSTD_VERSION);
  });
});
