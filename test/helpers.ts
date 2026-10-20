// Tests run against the built package in dist/ (what users get), once per backend.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as nodeEntry from '../dist/entry-node.js';
import * as wasmEntry from '../dist/entry-wasm.js';

export type Zstd = typeof nodeEntry;

export const backends: [name: 'native' | 'wasm', api: Zstd][] = [
  ['native', nodeEntry],
  ['wasm', wasmEntry as Zstd],
];

const fixturesDir = join(import.meta.dirname, 'fixtures');
export const fixture = (name: string): Buffer => readFileSync(join(fixturesDir, name));

const cliCandidate = process.env['ZSTD_CLI'] ?? join(import.meta.dirname, '..', 'out', 'zstd-cli', 'programs', 'zstd');
/** Path to the official zstd CLI, if built (`node scripts/build-zstd-cli.mjs`). */
export const zstdCli: string | undefined = existsSync(cliCandidate) ? cliCandidate : undefined;

/** Deterministic pseudo-random bytes (incompressible). */
export function randomBytes(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

/** Deterministic, moderately compressible bytes. */
export function textBytes(length: number, seed = 1): Uint8Array {
  const words = ['alpha ', 'beta ', 'gamma ', 'delta ', 'zstd ', 'frame ', 'block ', '\n'];
  const out = new Uint8Array(length);
  const r = randomBytes(length, seed);
  let i = 0;
  let k = 0;
  while (i < length) {
    const w = words[r[k++ % length]! % words.length]!;
    for (let j = 0; j < w.length && i < length; j++) out[i++] = w.charCodeAt(j);
  }
  return out;
}

/** A skippable frame (magic 0x184D2A5?) carrying `payload`. */
export function skippableFrame(payload: Uint8Array, nibble = 0): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x184d2a50 + nibble, true);
  view.setUint32(4, payload.length, true);
  out.set(payload, 8);
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Runs bytes through a TransformStream, writing them in the given chunk sizes. */
export async function pipeChunks(
  stream: TransformStream<Uint8Array, Uint8Array>,
  data: Uint8Array,
  chunkSizes: (i: number) => number = () => 65536,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const reading = (async () => {
    for await (const part of stream.readable as unknown as AsyncIterable<Uint8Array>) parts.push(part);
  })();
  const writer = stream.writable.getWriter();
  try {
    for (let offset = 0, i = 0; offset < data.length; i++) {
      const size = Math.max(1, chunkSizes(i));
      await writer.write(data.subarray(offset, offset + size));
      offset += size;
    }
    await writer.close();
  } catch (error) {
    await reading.catch(() => {});
    throw error;
  }
  await reading;
  return concat(...parts);
}

/** Resolves to the ZstdError code thrown by fn, or 'no error'. */
export async function errorCode(fn: () => unknown): Promise<string> {
  try {
    await fn();
    return 'no error';
  } catch (error) {
    return (error as { code?: string }).code ?? `uncoded ${String(error)}`;
  }
}

export function syncErrorCode(fn: () => unknown): string {
  try {
    fn();
    return 'no error';
  } catch (error) {
    return (error as { code?: string }).code ?? `uncoded ${String(error)}`;
  }
}
