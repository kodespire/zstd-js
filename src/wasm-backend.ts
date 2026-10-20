// Loader and bindings for out/wasm/zstd.wasm (a standalone module with no
// Emscripten JS glue). Memory can grow during any call, which replaces
// memory.buffer, so views are created fresh after every call into WebAssembly
// and never cached. Pointers and sizes coming back are unsigned 32-bit (>>> 0).

import { errorFromCore, ZstdError } from './errors.js';
import type { Backend, CStreamHandle, DStreamHandle } from './types.js';

interface ZjsExports {
  memory: WebAssembly.Memory;
  _initialize?: () => void;
  malloc(size: number): number;
  free(ptr: number): void;
  zjs_buf_free(buf: number): void;
  zjs_compress(src: number, srcSize: number, level: number, checksum: number, dict: number, dictSize: number, out: number, detail: number): number;
  zjs_decompress(src: number, srcSize: number, dict: number, dictSize: number, windowLogMax: number, maxOutput: number, out: number, detail: number): number;
  zjs_cstream_create(level: number, checksum: number, dict: number, dictSize: number, stream: number, detail: number): number;
  zjs_cstream_push(stream: number, src: number, srcSize: number, mode: number, out: number, detail: number): number;
  zjs_cstream_free(stream: number): void;
  zjs_dstream_create(dict: number, dictSize: number, windowLogMax: number, maxOutput: number, stream: number, detail: number): number;
  zjs_dstream_push(stream: number, src: number, srcSize: number, out: number, detail: number): number;
  zjs_dstream_finish(stream: number, detail: number): number;
  zjs_dstream_free(stream: number): void;
  zjs_frame_content_size(src: number, srcSize: number, size: number, detail: number): number;
  zjs_version(): number;
}

const imports = {
  env: {
    // Called by the module after memory.grow; views are rebuilt per call anyway.
    emscripten_notify_memory_growth() {},
  },
};

// Scratch block layout (allocated once per instance):
//   +0  zjs_buf { data, size, cap }   (3 x u32)
//   +12 const char* detail            (u32)
//   +16 stream pointer out-param      (u32)
//   +24 double out-param              (f64)
const SCRATCH_SIZE = 32;
const BUF = 0;
const DETAIL = 12;
const STREAM = 16;
const DOUBLE = 24;

// wasm32 size_t: anything at or above 2^32 - 1 means "no limit".
const NO_LIMIT = 0xffffffff;

const decoder = new TextDecoder();

class Wasm {
  readonly e: ZjsExports;
  readonly scratch: number;

  constructor(instance: WebAssembly.Instance) {
    this.e = instance.exports as unknown as ZjsExports;
    this.e._initialize?.();
    this.scratch = this.e.malloc(SCRATCH_SIZE) >>> 0;
    if (this.scratch === 0) throw new ZstdError('ERR_ZSTD_OUT_OF_MEMORY', 'out of memory');
  }

  u8(): Uint8Array {
    return new Uint8Array(this.e.memory.buffer);
  }

  view(): DataView {
    return new DataView(this.e.memory.buffer);
  }

  resetScratch(): void {
    this.u8().fill(0, this.scratch, this.scratch + SCRATCH_SIZE);
  }

  /** Copies bytes into WebAssembly memory. Returns 0 for empty input. Caller frees. */
  copyIn(bytes: Uint8Array): number {
    if (bytes.length === 0) return 0;
    const ptr = this.e.malloc(bytes.length) >>> 0;
    if (ptr === 0) throw new ZstdError('ERR_ZSTD_OUT_OF_MEMORY', 'out of memory');
    this.u8().set(bytes, ptr);
    return ptr;
  }

  free(ptr: number): void {
    if (ptr !== 0) this.e.free(ptr);
  }

  cString(ptr: number): string {
    if (ptr === 0) return 'zstd error';
    const mem = this.u8();
    let end = ptr;
    while (mem[end] !== 0) end++;
    return decoder.decode(mem.subarray(ptr, end));
  }

  /** Copies the scratch zjs_buf out to a new Uint8Array and frees it. */
  takeBuf(): Uint8Array {
    const view = this.view();
    const data = view.getUint32(this.scratch + BUF, true);
    const size = view.getUint32(this.scratch + BUF + 4, true);
    const out = this.u8().slice(data, data + size);
    this.e.zjs_buf_free(this.scratch + BUF);
    return out;
  }

  /** Frees the scratch zjs_buf and returns the error for rc. */
  fail(rc: number): ZstdError {
    const detail = this.cString(this.view().getUint32(this.scratch + DETAIL, true));
    this.e.zjs_buf_free(this.scratch + BUF);
    return errorFromCore(rc, detail);
  }

  readPointer(offset: number): number {
    return this.view().getUint32(this.scratch + offset, true);
  }
}

function limit(maxOutput: number): number {
  return maxOutput >= NO_LIMIT ? NO_LIMIT : maxOutput;
}

const registry =
  typeof FinalizationRegistry === 'function'
    ? new FinalizationRegistry<() => void>((free) => free())
    : undefined;

function createBackend(w: Wasm): Backend {
  const { e } = w;

  function withInputs<T>(inputs: (Uint8Array | null)[], fn: (ptrs: number[]) => T): T {
    const ptrs: number[] = [];
    try {
      for (const input of inputs) ptrs.push(input ? w.copyIn(input) : 0);
      w.resetScratch();
      return fn(ptrs);
    } finally {
      for (const p of ptrs) w.free(p);
    }
  }

  function compressSync(data: Uint8Array, level: number, checksum: boolean, dict: Uint8Array | null): Uint8Array {
    return withInputs([data, dict], ([src, d]) => {
      const rc = e.zjs_compress(src!, data.length, level, checksum ? 1 : 0, d!, dict?.length ?? 0, w.scratch + BUF, w.scratch + DETAIL);
      if (rc !== 0) throw w.fail(rc);
      return w.takeBuf();
    });
  }

  function decompressSync(data: Uint8Array, dict: Uint8Array | null, windowLogMax: number, maxOutput: number): Uint8Array {
    return withInputs([data, dict], ([src, d]) => {
      const rc = e.zjs_decompress(src!, data.length, d!, dict?.length ?? 0, windowLogMax, limit(maxOutput), w.scratch + BUF, w.scratch + DETAIL);
      if (rc !== 0) throw w.fail(rc);
      return w.takeBuf();
    });
  }

  function createCStream(level: number, checksum: boolean, dict: Uint8Array | null): CStreamHandle {
    let ptr = withInputs([dict], ([d]) => {
      const rc = e.zjs_cstream_create(level, checksum ? 1 : 0, d!, dict?.length ?? 0, w.scratch + STREAM, w.scratch + DETAIL);
      if (rc !== 0) throw w.fail(rc);
      return w.readPointer(STREAM);
    });
    const token = {};
    const release = (p: number) => () => e.zjs_cstream_free(p);
    registry?.register(token, release(ptr), token);
    const handle: CStreamHandle & { token: object } = {
      token,
      push(chunk, mode) {
        if (ptr === 0) throw new ZstdError('ERR_ZSTD_INVALID_ARGUMENT', 'stream is closed');
        return withInputs([chunk], ([src]) => {
          const rc = e.zjs_cstream_push(ptr, src!, chunk.length, mode, w.scratch + BUF, w.scratch + DETAIL);
          if (rc !== 0) throw w.fail(rc);
          return w.takeBuf();
        });
      },
      async pushAsync(chunk, mode) {
        return handle.push(chunk, mode);
      },
      close() {
        if (ptr === 0) return;
        registry?.unregister(token);
        e.zjs_cstream_free(ptr);
        ptr = 0;
      },
    };
    return handle;
  }

  function createDStream(dict: Uint8Array | null, windowLogMax: number, maxOutput: number): DStreamHandle {
    let ptr = withInputs([dict], ([d]) => {
      const rc = e.zjs_dstream_create(d!, dict?.length ?? 0, windowLogMax, limit(maxOutput), w.scratch + STREAM, w.scratch + DETAIL);
      if (rc !== 0) throw w.fail(rc);
      return w.readPointer(STREAM);
    });
    const token = {};
    registry?.register(token, ((p: number) => () => e.zjs_dstream_free(p))(ptr), token);
    const closed = () => new ZstdError('ERR_ZSTD_INVALID_ARGUMENT', 'stream is closed');
    const handle: DStreamHandle & { token: object } = {
      token,
      push(chunk) {
        if (ptr === 0) throw closed();
        return withInputs([chunk], ([src]) => {
          const rc = e.zjs_dstream_push(ptr, src!, chunk.length, w.scratch + BUF, w.scratch + DETAIL);
          if (rc !== 0) throw w.fail(rc);
          return w.takeBuf();
        });
      },
      async pushAsync(chunk) {
        return handle.push(chunk);
      },
      finish() {
        if (ptr === 0) throw closed();
        w.resetScratch();
        const rc = e.zjs_dstream_finish(ptr, w.scratch + DETAIL);
        if (rc !== 0) throw w.fail(rc);
      },
      close() {
        if (ptr === 0) return;
        registry?.unregister(token);
        e.zjs_dstream_free(ptr);
        ptr = 0;
      },
    };
    return handle;
  }

  function frameContentSize(data: Uint8Array): number {
    return withInputs([data], ([src]) => {
      const rc = e.zjs_frame_content_size(src!, data.length, w.scratch + DOUBLE, w.scratch + DETAIL);
      if (rc !== 0) throw w.fail(rc);
      return w.view().getFloat64(w.scratch + DOUBLE, true);
    });
  }

  return {
    kind: 'wasm',
    version: w.cString(e.zjs_version() >>> 0),
    compressSync,
    compress: async (...args) => compressSync(...args),
    decompressSync,
    decompress: async (...args) => decompressSync(...args),
    frameContentSize,
    createCStream,
    createDStream,
  };
}

export async function instantiateWasmBackend(module: WebAssembly.Module): Promise<Backend> {
  const instance = await WebAssembly.instantiate(module, imports);
  return createBackend(new Wasm(instance));
}

export function instantiateWasmBackendSync(module: WebAssembly.Module): Backend {
  return createBackend(new Wasm(new WebAssembly.Instance(module, imports)));
}
