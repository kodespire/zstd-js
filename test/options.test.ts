import { describe, expect, it } from 'vitest';

import { backends, fixture, syncErrorCode, textBytes } from './helpers.js';

describe.each(backends)('%s backend: options', (_name, z) => {
  const corpus = fixture('corpus.txt');

  // Regression for mongodb-js/zstd NODE-6586, where the level argument was
  // dropped and every call compressed at the default level.
  it('the compression level changes the output', () => {
    const sizes = new Map<number, number>();
    for (const level of [-5, 1, 3, 9, 19]) sizes.set(level, z.compressSync(corpus, { level }).length);
    expect(new Set(sizes.values()).size).toBe(sizes.size);
    expect(sizes.get(19)!).toBeLessThan(sizes.get(3)!);
    // 19 and 22 differ only in window size, which this ~200 KB input does not reach.
    expect(z.compressSync(corpus, { level: 22 }).length).toBeLessThanOrEqual(sizes.get(19)!);
    expect(sizes.get(3)!).toBeLessThan(sizes.get(-5)!);
  });

  it('the level shorthand matches the options form, and the default is level 3', async () => {
    expect(z.compressSync(corpus, 19)).toEqual(z.compressSync(corpus, { level: 19 }));
    expect(await z.compress(corpus, 19)).toEqual(z.compressSync(corpus, { level: 19 }));
    expect(z.compressSync(corpus)).toEqual(z.compressSync(corpus, { level: 3 }));
  });

  it('the level reaches streaming compression too', async () => {
    const stream = async (level: number) => {
      const parts: Uint8Array[] = [];
      const s = z.createCompressStream({ level });
      const reading = (async () => {
        for await (const p of s.readable as unknown as AsyncIterable<Uint8Array>) parts.push(p);
      })();
      const w = s.writable.getWriter();
      await w.write(corpus);
      await w.close();
      await reading;
      return parts.reduce((n, p) => n + p.length, 0);
    };
    expect(await stream(19)).toBeLessThan(await stream(1));
  });

  it('checksum adds 4 bytes and is on by default', () => {
    const withSum = z.compressSync(corpus);
    const without = z.compressSync(corpus, { checksum: false });
    expect(withSum.length - without.length).toBe(4);
    expect(z.compressSync(corpus, { checksum: true })).toEqual(withSum);
  });

  it('a dictionary changes the output and is required to decompress', () => {
    const dictionary = fixture('dict.bin');
    const record = fixture('record.json');
    const plain = z.compressSync(record);
    const withDict = z.compressSync(record, { dictionary });
    expect(withDict.length).toBeLessThan(plain.length);
    expect(z.decompressSync(withDict, { dictionary })).toEqual(new Uint8Array(record));
    expect(syncErrorCode(() => z.decompressSync(withDict))).toBe('ERR_ZSTD_LIBRARY');
  });

  it('accepts every binary input type', () => {
    const src = textBytes(10_000);
    const frame = z.compressSync(src);
    const padded = new Uint8Array(frame.length + 10);
    padded.set(frame, 5);
    const inputs: unknown[] = [
      frame,
      Buffer.from(frame),
      frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength),
      padded.subarray(5, 5 + frame.length),
      new DataView(padded.buffer, 5, frame.length),
    ];
    for (const input of inputs) expect(z.decompressSync(input as Uint8Array)).toEqual(src);
    expect(z.decompressSync(z.compressSync('héllo ✓'))).toEqual(new TextEncoder().encode('héllo ✓'));
  });

  it('rejects unknown option names instead of ignoring them', () => {
    expect(() => z.compressSync('x', { compressionLevel: 19 } as never)).toThrow(/unknown option "compressionLevel".*Did you mean "level"/);
    expect(() => z.decompressSync(z.compressSync('x'), { maxOutput: 10 } as never)).toThrow(/unknown option "maxOutput"/);
  });

  it('validates option values', () => {
    expect(() => z.compressSync('x', { level: 23 })).toThrow(RangeError);
    expect(() => z.compressSync('x', { level: 1.5 })).toThrow(RangeError);
    expect(() => z.compressSync('x', { level: '3' as never })).toThrow(RangeError);
    expect(() => z.compressSync('x', { checksum: 1 as never })).toThrow(TypeError);
    expect(() => z.decompressSync(new Uint8Array(1), { maxOutputSize: -1 })).toThrow(RangeError);
    expect(() => z.decompressSync(new Uint8Array(1), { maxOutputSize: 1.5 })).toThrow(RangeError);
    expect(() => z.decompressSync(new Uint8Array(1), { windowLogMax: 9 })).toThrow(RangeError);
    expect(() => z.decompressSync('abc' as never)).toThrow(TypeError);
    expect(() => z.compressSync(123 as never)).toThrow(TypeError);
    expect(() => z.compressSync('x', null as never)).toThrow(TypeError);
  });

  it('accepts the extreme levels', () => {
    for (const level of [z.MIN_LEVEL, -1, 0, z.MAX_LEVEL]) {
      expect(z.decompressSync(z.compressSync(corpus, { level }))).toEqual(new Uint8Array(corpus));
    }
  });

  it('windowLogMax opens frames with large windows', () => {
    const frame = fixture('corpus.long28.zst');
    expect(syncErrorCode(() => z.decompressSync(frame))).toBe('ERR_ZSTD_LIBRARY');
    expect(z.decompressSync(frame, { windowLogMax: 28 })).toEqual(new Uint8Array(corpus));
  });

  it('getFrameContentSize and isZstdFrame', () => {
    expect(z.getFrameContentSize(fixture('corpus.file.zst'))).toBe(corpus.length);
    expect(z.getFrameContentSize(fixture('corpus.stdin.zst'))).toBeNull();
    expect(() => z.getFrameContentSize(new Uint8Array([1, 2, 3, 4, 5, 6]))).toThrow();
    expect(z.isZstdFrame(fixture('corpus.file.zst'))).toBe(true);
    expect(z.isZstdFrame(new Uint8Array([0x5f, 0x2a, 0x4d, 0x18]))).toBe(true); // skippable
    expect(z.isZstdFrame(corpus)).toBe(false);
    expect(z.isZstdFrame(new Uint8Array(2))).toBe(false);
  });
});
