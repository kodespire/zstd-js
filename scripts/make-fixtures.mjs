// Regenerates test/fixtures with the official zstd CLI built from deps/zstd.
// The fixtures are committed; rerun this only when changing them.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCli } from './build-zstd-cli.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'test', 'fixtures');
const zstd = buildCli();
mkdirSync(out, { recursive: true });

// Deterministic, compressible text.
function corpus(seed, words) {
  const vocab = 'the quick brown fox jumps over lazy dog zstd frame block window literal sequence match offset entropy huffman table stream buffer chunk'.split(' ');
  let x = seed >>> 0;
  const parts = [];
  for (let i = 0; i < words; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    parts.push(vocab[x % vocab.length]);
    if (x % 17 === 0) parts.push(`${x % 100000}\n`);
  }
  return Buffer.from(parts.join(' '));
}

const run = (args, input) => execFileSync(zstd, args, { input, maxBuffer: 1 << 30 });
const write = (name, data) => writeFileSync(join(out, name), data);

const text = corpus(1, 30000);
write('corpus.txt', text);
// From stdin the CLI cannot know the size, so these headers do not record it.
write('corpus.stdin.zst', run(['-q', '-c'], text));
write('corpus.19.zst', run(['-q', '-c', '-19'], text));
write('corpus.ultra22.zst', run(['-q', '-c', '--ultra', '-22'], text));
write('corpus.fast5.zst', run(['-q', '-c', '--fast=5'], text));
write('corpus.nocheck.zst', run(['-q', '-c', '--no-check'], text));

// Same input from a file: the CLI records the content size in the header.
const tmp = mkdtempSync(join(tmpdir(), 'zstd-js-fixtures-'));
try {
  const file = join(tmp, 'corpus.txt');
  writeFileSync(file, text);
  write('corpus.file.zst', run(['-q', '-c', file]));

  // Two frames back to back, as `cat a.zst b.zst` produces.
  const half = text.length >> 1;
  write('corpus.multi.zst', Buffer.concat([run(['-q', '-c'], text.subarray(0, half)), run(['-q', '-c'], text.subarray(half))]));

  // Long-distance mode from stdin: the header declares a 256 MiB window, above the
  // decoder's default limit (2^27), so decoding needs windowLogMax >= 28.
  write('corpus.long28.zst', run(['-q', '-c', '--long=28'], text));

  // Dictionary: train on small JSON records, compress one of them with it.
  const samples = join(tmp, 'samples');
  mkdirSync(samples);
  for (let i = 0; i < 400; i++) {
    writeFileSync(join(samples, `${i}.json`), JSON.stringify({ id: i, user: `user-${i % 37}`, status: ['active', 'idle', 'banned'][i % 3], score: (i * 7919) % 1000, tags: ['alpha', 'beta', String(i % 11)] }));
  }
  const dictFile = join(tmp, 'dict');
  execFileSync(zstd, ['-q', '--train', '--maxdict=4096', '-o', dictFile, ...Array.from({ length: 400 }, (_, i) => join(samples, `${i}.json`))]);
  const record = readFileSync(join(samples, '123.json'));
  write('dict.bin', readFileSync(dictFile));
  write('record.json', record);
  write('record.dict.zst', run(['-q', '-c', '-D', dictFile], record));

  // A valid frame holding zero bytes (unlike zero bytes of input, which is not a frame).
  const empty = join(tmp, 'empty');
  writeFileSync(empty, '');
  write('empty-frame.zst', run(['-q', '-c', empty]));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`fixtures written to ${out} with ${run(['--version']).toString().trim()}`);
