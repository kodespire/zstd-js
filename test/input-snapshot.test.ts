// Async calls must use the bytes as they were when the call was made, even if the
// caller changes its buffer before the promise settles. Regression: 0.1.0 awaited
// the backend before copying the input, so a change made right after the call
// (on any call, not only while the WebAssembly module was loading) was compressed.
// The wasm backend is first used in this file by these tests, so the loading path
// is covered too.
import { describe, expect, it } from 'vitest';

import { backends, pipeChunks, textBytes } from './helpers.js';

// Byte comparison without vitest's array diff, which takes minutes on 200 KB inputs.
const same = (a: Uint8Array, b: Uint8Array) => Buffer.compare(a, b) === 0;

describe.each(backends)('%s backend: async calls capture their input at call time', (_name, z) => {
  it('compress ignores changes made to the input after the call', async () => {
    const original = textBytes(200_000, 41);
    const buf = Buffer.from(original);
    const pending = z.compress(buf);
    buf.fill(0);
    expect(same(z.decompressSync(await pending), original)).toBe(true);
  });

  it('decompress ignores changes made to the frame after the call', async () => {
    const original = textBytes(200_000, 42);
    const frame = Buffer.from(z.compressSync(original));
    const pending = z.decompress(frame);
    frame.fill(0);
    expect(same(await pending, original)).toBe(true);
  });

  it('dictionaries are captured when the call or stream is made', async () => {
    // Compare compressed bytes: decompressing would not notice, because a frame made
    // with an all-zero dictionary barely references it and decodes with any dictionary.
    const dictCopy = textBytes(8_000, 43);
    const src = new Uint8Array([...dictCopy.subarray(0, 4_000), ...textBytes(20_000, 44)]);
    const expected = z.compressSync(src, { dictionary: dictCopy });

    const dictionary = Buffer.from(dictCopy);
    const pending = z.compress(src, { dictionary });
    dictionary.fill(0);
    expect(same(await pending, expected)).toBe(true);

    const streamed = await pipeChunks(z.createCompressStream({ dictionary: dictCopy }), src);
    const streamDictionary = Buffer.from(dictCopy);
    const stream = z.createCompressStream({ dictionary: streamDictionary });
    streamDictionary.fill(0);
    expect(same(await pipeChunks(stream, src), streamed)).toBe(true);
  });
});
