// Node-API binding. Moves bytes between JavaScript and the zjs C layer; all
// compression logic lives in zjs.c.
//
// Errors are thrown (or rejected) as Error objects carrying a numeric
// `zjsCode` property; the TypeScript layer turns them into ZstdError.

#include <napi.h>

#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "zjs.h"

namespace {

Napi::Error MakeError(Napi::Env env, int code, const char* detail) {
  Napi::Error error = Napi::Error::New(env, detail ? detail : "zstd error");
  error.Value().Set("zjsCode", Napi::Number::New(env, code));
  return error;
}

// Hands a zjs_buf to JavaScript without copying when the runtime allows
// external buffers, and copies otherwise (e.g. Electron's V8 sandbox).
// Leaves `buf` empty either way.
Napi::Buffer<uint8_t> TakeBuffer(Napi::Env env, zjs_buf* buf) {
  if (buf->size == 0) {
    zjs_buf_free(buf);
    return Napi::Buffer<uint8_t>::New(env, 0);
  }
  if (buf->cap - buf->size > 4096) {
    void* shrunk = realloc(buf->data, buf->size);
    if (shrunk) {
      buf->data = static_cast<uint8_t*>(shrunk);
      buf->cap = buf->size;
    }
  }
  uint8_t* data = buf->data;
  size_t size = buf->size;
  buf->data = nullptr;
  buf->size = 0;
  buf->cap = 0;
  return Napi::Buffer<uint8_t>::NewOrCopy(env, data, size,
                                          [](Napi::Env, uint8_t* p) { free(p); });
}

Napi::Uint8Array BytesArg(const Napi::CallbackInfo& info, size_t index, const char* name) {
  Napi::Value v = info[index];
  if (!v.IsTypedArray() || v.As<Napi::TypedArray>().TypedArrayType() != napi_uint8_array) {
    throw Napi::TypeError::New(info.Env(), std::string(name) + " must be a Uint8Array");
  }
  return v.As<Napi::Uint8Array>();
}

// Optional Uint8Array: null/undefined -> empty.
std::vector<uint8_t> OptionalBytesCopy(const Napi::CallbackInfo& info, size_t index, const char* name) {
  Napi::Value v = info[index];
  if (v.IsNull() || v.IsUndefined()) return {};
  Napi::Uint8Array a = BytesArg(info, index, name);
  return std::vector<uint8_t>(a.Data(), a.Data() + a.ByteLength());
}

int32_t IntArg(const Napi::CallbackInfo& info, size_t index, const char* name) {
  if (!info[index].IsNumber()) {
    throw Napi::TypeError::New(info.Env(), std::string(name) + " must be a number");
  }
  return info[index].As<Napi::Number>().Int32Value();
}

bool BoolArg(const Napi::CallbackInfo& info, size_t index) {
  return info[index].ToBoolean().Value();
}

// Number -> size_t limit. Infinity (and anything >= SIZE_MAX) means no limit.
size_t LimitArg(const Napi::CallbackInfo& info, size_t index, const char* name) {
  if (!info[index].IsNumber()) {
    throw Napi::TypeError::New(info.Env(), std::string(name) + " must be a number");
  }
  double d = info[index].As<Napi::Number>().DoubleValue();
  if (std::isnan(d) || d < 0) {
    throw Napi::RangeError::New(info.Env(), std::string(name) + " must be a non-negative number");
  }
  if (std::isinf(d) || d >= static_cast<double>(SIZE_MAX)) return SIZE_MAX;
  return static_cast<size_t>(d);
}

const uint8_t* DataOrNull(const std::vector<uint8_t>& v) {
  return v.empty() ? nullptr : v.data();
}

// ---- async one-shot ------------------------------------------------------

class BufferWorker : public Napi::AsyncWorker {
 public:
  explicit BufferWorker(Napi::Env env)
      : Napi::AsyncWorker(env, "zstd-js"), deferred_(Napi::Promise::Deferred::New(env)) {}
  ~BufferWorker() override { zjs_buf_free(&out_); }

  Napi::Promise Promise() { return deferred_.Promise(); }

 protected:
  virtual int Run(zjs_buf* out, const char** detail) = 0;
  virtual void Done() {}

  void Execute() override { rc_ = Run(&out_, &detail_); }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::HandleScope scope(env);
    Done();
    if (rc_ != ZJS_OK) {
      deferred_.Reject(MakeError(env, rc_, detail_).Value());
    } else {
      deferred_.Resolve(TakeBuffer(env, &out_));
    }
  }

  void OnError(const Napi::Error& e) override {
    Done();
    deferred_.Reject(e.Value());
  }

 private:
  Napi::Promise::Deferred deferred_;
  zjs_buf out_{};
  int rc_ = ZJS_OK;
  const char* detail_ = nullptr;
};

// Inputs are copied: JavaScript may modify or transfer (detach) the source
// ArrayBuffer while the worker runs on another thread.
class CompressWorker : public BufferWorker {
 public:
  CompressWorker(Napi::Env env, std::vector<uint8_t> src, int level, bool checksum,
                 std::vector<uint8_t> dict)
      : BufferWorker(env), src_(std::move(src)), dict_(std::move(dict)),
        level_(level), checksum_(checksum) {}

 protected:
  int Run(zjs_buf* out, const char** detail) override {
    return zjs_compress(DataOrNull(src_), src_.size(), level_, checksum_ ? 1 : 0,
                        DataOrNull(dict_), dict_.size(), out, detail);
  }

 private:
  std::vector<uint8_t> src_, dict_;
  int level_;
  bool checksum_;
};

class DecompressWorker : public BufferWorker {
 public:
  DecompressWorker(Napi::Env env, std::vector<uint8_t> src, std::vector<uint8_t> dict,
                   int window_log_max, size_t max_output)
      : BufferWorker(env), src_(std::move(src)), dict_(std::move(dict)),
        window_log_max_(window_log_max), max_output_(max_output) {}

 protected:
  int Run(zjs_buf* out, const char** detail) override {
    return zjs_decompress(DataOrNull(src_), src_.size(), DataOrNull(dict_), dict_.size(),
                          window_log_max_, max_output_, out, detail);
  }

 private:
  std::vector<uint8_t> src_, dict_;
  int window_log_max_;
  size_t max_output_;
};

std::vector<uint8_t> CopyBytes(const Napi::Uint8Array& a) {
  return std::vector<uint8_t>(a.Data(), a.Data() + a.ByteLength());
}

// compressSync(data, level, checksum, dict | null): Buffer
Napi::Value CompressSync(const Napi::CallbackInfo& info) {
  Napi::Uint8Array src = BytesArg(info, 0, "data");
  int level = IntArg(info, 1, "level");
  bool checksum = BoolArg(info, 2);
  std::vector<uint8_t> dict = OptionalBytesCopy(info, 3, "dictionary");
  zjs_buf out{};
  const char* detail = nullptr;
  int rc = zjs_compress(src.Data(), src.ByteLength(), level, checksum ? 1 : 0,
                        DataOrNull(dict), dict.size(), &out, &detail);
  if (rc != ZJS_OK) {
    zjs_buf_free(&out);
    throw MakeError(info.Env(), rc, detail);
  }
  return TakeBuffer(info.Env(), &out);
}

// compress(data, level, checksum, dict | null): Promise<Buffer>
Napi::Value Compress(const Napi::CallbackInfo& info) {
  Napi::Uint8Array src = BytesArg(info, 0, "data");
  int level = IntArg(info, 1, "level");
  bool checksum = BoolArg(info, 2);
  std::vector<uint8_t> dict = OptionalBytesCopy(info, 3, "dictionary");
  auto* worker = new CompressWorker(info.Env(), CopyBytes(src), level, checksum, std::move(dict));
  Napi::Promise promise = worker->Promise();
  worker->Queue();
  return promise;
}

// decompressSync(data, dict | null, windowLogMax, maxOutput): Buffer
Napi::Value DecompressSync(const Napi::CallbackInfo& info) {
  Napi::Uint8Array src = BytesArg(info, 0, "data");
  std::vector<uint8_t> dict = OptionalBytesCopy(info, 1, "dictionary");
  int window_log_max = IntArg(info, 2, "windowLogMax");
  size_t max_output = LimitArg(info, 3, "maxOutputSize");
  zjs_buf out{};
  const char* detail = nullptr;
  int rc = zjs_decompress(src.Data(), src.ByteLength(), DataOrNull(dict), dict.size(),
                          window_log_max, max_output, &out, &detail);
  if (rc != ZJS_OK) {
    zjs_buf_free(&out);
    throw MakeError(info.Env(), rc, detail);
  }
  return TakeBuffer(info.Env(), &out);
}

// decompress(data, dict | null, windowLogMax, maxOutput): Promise<Buffer>
Napi::Value Decompress(const Napi::CallbackInfo& info) {
  Napi::Uint8Array src = BytesArg(info, 0, "data");
  std::vector<uint8_t> dict = OptionalBytesCopy(info, 1, "dictionary");
  int window_log_max = IntArg(info, 2, "windowLogMax");
  size_t max_output = LimitArg(info, 3, "maxOutputSize");
  auto* worker = new DecompressWorker(info.Env(), CopyBytes(src), std::move(dict),
                                      window_log_max, max_output);
  Napi::Promise promise = worker->Promise();
  worker->Queue();
  return promise;
}

// frameContentSize(data): number (-1 when the header does not record it)
Napi::Value FrameContentSize(const Napi::CallbackInfo& info) {
  Napi::Uint8Array src = BytesArg(info, 0, "data");
  double size = 0;
  const char* detail = nullptr;
  int rc = zjs_frame_content_size(src.Data(), src.ByteLength(), &size, &detail);
  if (rc != ZJS_OK) throw MakeError(info.Env(), rc, detail);
  return Napi::Number::New(info.Env(), size);
}

// ---- streams ---------------------------------------------------------------

// Shared by CStream and DStream: one operation at a time, and the JS object
// stays referenced while a worker uses the native context, so the garbage
// collector cannot free the context underneath it.
template <typename T>
class StreamBase : public Napi::ObjectWrap<T> {
 public:
  using Napi::ObjectWrap<T>::ObjectWrap;

  void Acquire(Napi::Env env) {
    if (busy_) throw MakeError(env, ZJS_ERR_ARG, "stream is busy: wait for the previous push to finish");
    if (closed_) throw MakeError(env, ZJS_ERR_ARG, "stream is closed");
    busy_ = true;
  }
  void Release() { busy_ = false; }
  bool busy() const { return busy_; }

 protected:
  bool busy_ = false;
  bool closed_ = false;
};

class StreamPushWorker : public BufferWorker {
 public:
  using Job = int (*)(void* ctx, const uint8_t* src, size_t size, int mode, zjs_buf* out,
                      const char** detail);
  StreamPushWorker(Napi::Env env, Napi::Object owner, void* ctx, Job job,
                   std::vector<uint8_t> src, int mode, void (*release)(Napi::Object))
      : BufferWorker(env), ctx_(ctx), job_(job), src_(std::move(src)), mode_(mode),
        release_(release) {
    owner_ = Napi::Persistent(owner);
  }

 protected:
  int Run(zjs_buf* out, const char** detail) override {
    return job_(ctx_, DataOrNull(src_), src_.size(), mode_, out, detail);
  }
  void Done() override {
    release_(owner_.Value());
    owner_.Reset();
  }

 private:
  void* ctx_;
  Job job_;
  std::vector<uint8_t> src_;
  int mode_;
  void (*release_)(Napi::Object);
  Napi::ObjectReference owner_;
};

class CStream : public StreamBase<CStream> {
 public:
  static Napi::Function Init(Napi::Env env) {
    return DefineClass(env, "CStream",
                       {InstanceMethod("push", &CStream::Push),
                        InstanceMethod("pushAsync", &CStream::PushAsync),
                        InstanceMethod("close", &CStream::Close)});
  }

  // new CStream(level, checksum, dict | null)
  explicit CStream(const Napi::CallbackInfo& info) : StreamBase<CStream>(info) {
    int level = IntArg(info, 0, "level");
    bool checksum = BoolArg(info, 1);
    std::vector<uint8_t> dict = OptionalBytesCopy(info, 2, "dictionary");
    const char* detail = nullptr;
    int rc = zjs_cstream_create(level, checksum ? 1 : 0, DataOrNull(dict), dict.size(), &stream_,
                                &detail);
    if (rc != ZJS_OK) throw MakeError(info.Env(), rc, detail);
  }
  ~CStream() override { zjs_cstream_free(stream_); }

 private:
  static int Job(void* ctx, const uint8_t* src, size_t size, int mode, zjs_buf* out,
                 const char** detail) {
    return zjs_cstream_push(static_cast<zjs_cstream*>(ctx), src, size, mode, out, detail);
  }
  static void ReleaseOwner(Napi::Object owner) { CStream::Unwrap(owner)->Release(); }

  // push(chunk, mode): Buffer
  Napi::Value Push(const Napi::CallbackInfo& info) {
    Napi::Uint8Array chunk = BytesArg(info, 0, "chunk");
    int mode = IntArg(info, 1, "mode");
    Acquire(info.Env());
    zjs_buf out{};
    const char* detail = nullptr;
    int rc = zjs_cstream_push(stream_, chunk.Data(), chunk.ByteLength(), mode, &out, &detail);
    Release();
    if (rc != ZJS_OK) {
      zjs_buf_free(&out);
      throw MakeError(info.Env(), rc, detail);
    }
    return TakeBuffer(info.Env(), &out);
  }

  // pushAsync(chunk, mode): Promise<Buffer>
  Napi::Value PushAsync(const Napi::CallbackInfo& info) {
    Napi::Uint8Array chunk = BytesArg(info, 0, "chunk");
    int mode = IntArg(info, 1, "mode");
    Acquire(info.Env());
    auto* worker = new StreamPushWorker(info.Env(), info.This().As<Napi::Object>(), stream_, Job,
                                        CopyBytes(chunk), mode, ReleaseOwner);
    Napi::Promise promise = worker->Promise();
    worker->Queue();
    return promise;
  }

  Napi::Value Close(const Napi::CallbackInfo& info) {
    if (busy_) throw MakeError(info.Env(), ZJS_ERR_ARG, "stream is busy: wait for the previous push to finish");
    zjs_cstream_free(stream_);
    stream_ = nullptr;
    closed_ = true;
    return info.Env().Undefined();
  }

  zjs_cstream* stream_ = nullptr;
};

class DStream : public StreamBase<DStream> {
 public:
  static Napi::Function Init(Napi::Env env) {
    return DefineClass(env, "DStream",
                       {InstanceMethod("push", &DStream::Push),
                        InstanceMethod("pushAsync", &DStream::PushAsync),
                        InstanceMethod("finish", &DStream::Finish),
                        InstanceMethod("close", &DStream::Close)});
  }

  // new DStream(dict | null, windowLogMax, maxOutput)
  explicit DStream(const Napi::CallbackInfo& info) : StreamBase<DStream>(info) {
    std::vector<uint8_t> dict = OptionalBytesCopy(info, 0, "dictionary");
    int window_log_max = IntArg(info, 1, "windowLogMax");
    size_t max_output = LimitArg(info, 2, "maxOutputSize");
    const char* detail = nullptr;
    int rc = zjs_dstream_create(DataOrNull(dict), dict.size(), window_log_max, max_output,
                                &stream_, &detail);
    if (rc != ZJS_OK) throw MakeError(info.Env(), rc, detail);
  }
  ~DStream() override { zjs_dstream_free(stream_); }

 private:
  static int Job(void* ctx, const uint8_t* src, size_t size, int /*mode*/, zjs_buf* out,
                 const char** detail) {
    return zjs_dstream_push(static_cast<zjs_dstream*>(ctx), src, size, out, detail);
  }
  static void ReleaseOwner(Napi::Object owner) { DStream::Unwrap(owner)->Release(); }

  // push(chunk): Buffer
  Napi::Value Push(const Napi::CallbackInfo& info) {
    Napi::Uint8Array chunk = BytesArg(info, 0, "chunk");
    Acquire(info.Env());
    zjs_buf out{};
    const char* detail = nullptr;
    int rc = zjs_dstream_push(stream_, chunk.Data(), chunk.ByteLength(), &out, &detail);
    Release();
    if (rc != ZJS_OK) {
      zjs_buf_free(&out);
      throw MakeError(info.Env(), rc, detail);
    }
    return TakeBuffer(info.Env(), &out);
  }

  // pushAsync(chunk): Promise<Buffer>
  Napi::Value PushAsync(const Napi::CallbackInfo& info) {
    Napi::Uint8Array chunk = BytesArg(info, 0, "chunk");
    Acquire(info.Env());
    auto* worker = new StreamPushWorker(info.Env(), info.This().As<Napi::Object>(), stream_, Job,
                                        CopyBytes(chunk), 0, ReleaseOwner);
    Napi::Promise promise = worker->Promise();
    worker->Queue();
    return promise;
  }

  // finish(): throws if the input ended inside a frame
  Napi::Value Finish(const Napi::CallbackInfo& info) {
    Acquire(info.Env());
    const char* detail = nullptr;
    int rc = zjs_dstream_finish(stream_, &detail);
    Release();
    if (rc != ZJS_OK) throw MakeError(info.Env(), rc, detail);
    return info.Env().Undefined();
  }

  Napi::Value Close(const Napi::CallbackInfo& info) {
    if (busy_) throw MakeError(info.Env(), ZJS_ERR_ARG, "stream is busy: wait for the previous push to finish");
    zjs_dstream_free(stream_);
    stream_ = nullptr;
    closed_ = true;
    return info.Env().Undefined();
  }

  zjs_dstream* stream_ = nullptr;
};

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("compressSync", Napi::Function::New(env, CompressSync));
  exports.Set("compress", Napi::Function::New(env, Compress));
  exports.Set("decompressSync", Napi::Function::New(env, DecompressSync));
  exports.Set("decompress", Napi::Function::New(env, Decompress));
  exports.Set("frameContentSize", Napi::Function::New(env, FrameContentSize));
  exports.Set("version", Napi::String::New(env, zjs_version()));
  exports.Set("minLevel", Napi::Number::New(env, zjs_min_level()));
  exports.Set("maxLevel", Napi::Number::New(env, zjs_max_level()));
  exports.Set("defaultLevel", Napi::Number::New(env, zjs_default_level()));
  exports.Set("CStream", CStream::Init(env));
  exports.Set("DStream", DStream::Init(env));
  return exports;
}

}  // namespace

NODE_API_MODULE(zstd_js, Init)
