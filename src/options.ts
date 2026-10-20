import type { Bytes, CompressOptions, DecompressOptions } from './types.js';
import { DEFAULT_LEVEL, MAX_LEVEL, MIN_LEVEL } from './version.js';

const encoder = new TextEncoder();

function isArrayBufferLike(value: unknown): value is ArrayBufferLike {
  const tag = Object.prototype.toString.call(value);
  return tag === '[object ArrayBuffer]' || tag === '[object SharedArrayBuffer]';
}

/** A Uint8Array view over the caller's bytes (no copy). */
export function toBytes(input: unknown, name: string): Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (isArrayBufferLike(input)) return new Uint8Array(input);
  throw new TypeError(`${name} must be an ArrayBuffer, a typed array, a DataView or a Buffer`);
}

/** Like toBytes, and also accepts strings (encoded as UTF-8). */
export function toInputBytes(input: unknown): Uint8Array {
  return typeof input === 'string' ? encoder.encode(input) : toBytes(input, 'data');
}

// Unknown keys throw instead of being ignored, so a typo such as
// `{ compressionLevel: 19 }` cannot silently compress at the default level.
function checkKeys(options: object, allowed: readonly string[], fn: string): void {
  for (const key of Object.keys(options)) {
    if (!allowed.includes(key)) {
      const hint = key.toLowerCase().includes('level') && allowed.includes('level') ? ' Did you mean "level"?' : '';
      throw new TypeError(`${fn}: unknown option "${key}". Valid options: ${allowed.join(', ')}.${hint}`);
    }
  }
}

function checkOptionsObject(options: unknown, fn: string): void {
  if (options !== undefined && (options === null || typeof options !== 'object')) {
    throw new TypeError(`${fn}: options must be an object`);
  }
}

export interface ResolvedCompressOptions {
  level: number;
  checksum: boolean;
  dictionary: Uint8Array | null;
}

const COMPRESS_KEYS = ['level', 'checksum', 'dictionary'] as const;

export function resolveCompressOptions(options: CompressOptions | number | undefined, fn: string): ResolvedCompressOptions {
  if (typeof options === 'number') options = { level: options };
  checkOptionsObject(options, fn);
  if (options) checkKeys(options, COMPRESS_KEYS, fn);
  const level = options?.level ?? DEFAULT_LEVEL;
  if (typeof level !== 'number' || !Number.isInteger(level) || level < MIN_LEVEL || level > MAX_LEVEL) {
    throw new RangeError(`${fn}: level must be an integer from ${MIN_LEVEL} to ${MAX_LEVEL}, got ${String(level)}`);
  }
  const checksum = options?.checksum ?? true;
  if (typeof checksum !== 'boolean') throw new TypeError(`${fn}: checksum must be a boolean`);
  const dictionary = options?.dictionary === undefined ? null : toBytes(options.dictionary, 'dictionary');
  return { level, checksum, dictionary: dictionary && dictionary.length > 0 ? dictionary : null };
}

export interface ResolvedDecompressOptions {
  maxOutputSize: number;
  dictionary: Uint8Array | null;
  /** 0 = libzstd default. */
  windowLogMax: number;
}

const DECOMPRESS_KEYS = ['maxOutputSize', 'dictionary', 'windowLogMax'] as const;

export function resolveDecompressOptions(options: DecompressOptions | undefined, fn: string): ResolvedDecompressOptions {
  checkOptionsObject(options, fn);
  if (options) checkKeys(options, DECOMPRESS_KEYS, fn);
  const maxOutputSize = options?.maxOutputSize ?? Infinity;
  if (typeof maxOutputSize !== 'number' || Number.isNaN(maxOutputSize) || maxOutputSize < 0 ||
      (Number.isFinite(maxOutputSize) && !Number.isInteger(maxOutputSize))) {
    throw new RangeError(`${fn}: maxOutputSize must be a non-negative integer or Infinity`);
  }
  const windowLogMax = options?.windowLogMax ?? 0;
  if (windowLogMax !== 0 && (typeof windowLogMax !== 'number' || !Number.isInteger(windowLogMax) || windowLogMax < 10 || windowLogMax > 31)) {
    throw new RangeError(`${fn}: windowLogMax must be an integer from 10 to 31`);
  }
  const dictionary = options?.dictionary === undefined ? null : toBytes(options.dictionary, 'dictionary');
  return { maxOutputSize, windowLogMax, dictionary: dictionary && dictionary.length > 0 ? dictionary : null };
}

export type { Bytes };
