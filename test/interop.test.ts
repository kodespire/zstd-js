// Interoperability with the official zstd CLI, built from the same deps/zstd.
// Fixtures in test/fixtures were produced by it (scripts/make-fixtures.mjs);
// the CLI round-trip tests run when out/zstd-cli exists (or ZSTD_CLI is set).
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { backends, fixture, textBytes, zstdCli } from './helpers.js';

const corpus = new Uint8Array(fixture('corpus.txt'));

describe.each(backends)('%s backend: decodes official CLI output', (_name, z) => {
  it.each([
    'corpus.stdin.zst',
    'corpus.file.zst',
    'corpus.19.zst',
    'corpus.ultra22.zst',
    'corpus.fast5.zst',
    'corpus.nocheck.zst',
    'corpus.multi.zst',
  ])('%s', async (name) => {
    expect(z.decompressSync(fixture(name))).toEqual(corpus);
    expect(await z.decompress(fixture(name))).toEqual(corpus);
  });

  it('long-window frame with windowLogMax', () => {
    expect(z.decompressSync(fixture('corpus.long28.zst'), { windowLogMax: 28 })).toEqual(corpus);
  });

  it('dictionary frame', () => {
    expect(z.decompressSync(fixture('record.dict.zst'), { dictionary: fixture('dict.bin') })).toEqual(new Uint8Array(fixture('record.json')));
  });

  it('empty frame', () => {
    expect(z.decompressSync(fixture('empty-frame.zst'))).toEqual(new Uint8Array(0));
  });
});

describe.skipIf(!zstdCli).each(backends)('%s backend: official CLI decodes our output', (_name, z) => {
  const cliDecompress = (data: Uint8Array, args: string[] = []) =>
    new Uint8Array(execFileSync(zstdCli!, ['-d', '-c', '-q', ...args], { input: data, maxBuffer: 1 << 30 }));

  it.each([-5, 1, 3, 19, 22])('level %i', (level) => {
    const src = textBytes(500_000, level + 100);
    expect(cliDecompress(z.compressSync(src, { level }))).toEqual(src);
  });

  it('streamed frames', async () => {
    const src = textBytes(800_000, 5);
    const parts: Uint8Array[] = [];
    const s = z.createCompressStream();
    const reading = (async () => {
      for await (const p of s.readable as unknown as AsyncIterable<Uint8Array>) parts.push(p);
    })();
    const w = s.writable.getWriter();
    for (let i = 0; i < src.length; i += 77_777) await w.write(src.subarray(i, i + 77_777));
    await w.close();
    await reading;
    expect(cliDecompress(Buffer.concat(parts))).toEqual(src);
  });

  it('dictionary', () => {
    const dictionary = fixture('dict.bin');
    const record = new Uint8Array(fixture('record.json'));
    const frame = z.compressSync(record, { dictionary });
    const dictPath = `${import.meta.dirname}/fixtures/dict.bin`;
    expect(cliDecompress(frame, ['-D', dictPath])).toEqual(record);
  });
});
