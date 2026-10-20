#define ZSTD_STATIC_LINKING_ONLY /* ZSTD_decompressBound */
#include "zjs.h"

#include <stdlib.h>

#include "zstd.h"
#include "zstd_errors.h"

/* Upper bound for the first allocation when decompressing. Content sizes come
 * from frame headers, which are untrusted, so we never allocate more than
 * this up front; the buffer grows as real output arrives. */
#define ZJS_INITIAL_CAP_LIMIT ((size_t)64 << 20)

/* Pointer handed to libzstd for empty input, so it never sees NULL. */
static const uint8_t zjs_empty = 0;

static int zjs_fail(int code, const char* message, const char** detail) {
  if (detail) *detail = message;
  return code;
}

static int zjs_lib_fail(size_t result, const char** detail) {
  if (ZSTD_getErrorCode(result) == ZSTD_error_memory_allocation) {
    return zjs_fail(ZJS_ERR_NOMEM, "out of memory", detail);
  }
  return zjs_fail(ZJS_ERR_LIBRARY, ZSTD_getErrorName(result), detail);
}

void zjs_buf_free(zjs_buf* buf) {
  if (!buf) return;
  free(buf->data);
  buf->data = NULL;
  buf->size = 0;
  buf->cap = 0;
}

/* Ensures at least min_free bytes of spare capacity, growing by ~1.5x. */
static int zjs_buf_reserve(zjs_buf* buf, size_t min_free, const char** detail) {
  size_t need, cap;
  uint8_t* data;
  if (buf->cap - buf->size >= min_free) return ZJS_OK;
  if (min_free > SIZE_MAX - buf->size) return zjs_fail(ZJS_ERR_NOMEM, "out of memory", detail);
  need = buf->size + min_free;
  cap = buf->cap + buf->cap / 2;
  if (cap < buf->cap || cap < need) cap = need;
  data = (uint8_t*)realloc(buf->data, cap);
  if (!data && cap != need) {
    cap = need;
    data = (uint8_t*)realloc(buf->data, cap);
  }
  if (!data) return zjs_fail(ZJS_ERR_NOMEM, "out of memory", detail);
  buf->data = data;
  buf->cap = cap;
  return ZJS_OK;
}

static int zjs_valid_level(int level) {
  return level >= ZSTD_minCLevel() && level <= ZSTD_maxCLevel();
}

static int zjs_configure_cctx(ZSTD_CCtx* cctx, int level, int checksum,
                              const uint8_t* dict, size_t dict_size,
                              const char** detail) {
  size_t r = ZSTD_CCtx_setParameter(cctx, ZSTD_c_compressionLevel, level);
  if (ZSTD_isError(r)) return zjs_lib_fail(r, detail);
  r = ZSTD_CCtx_setParameter(cctx, ZSTD_c_checksumFlag, checksum ? 1 : 0);
  if (ZSTD_isError(r)) return zjs_lib_fail(r, detail);
  if (dict_size > 0) {
    r = ZSTD_CCtx_loadDictionary(cctx, dict, dict_size); /* copies dict */
    if (ZSTD_isError(r)) return zjs_lib_fail(r, detail);
  }
  return ZJS_OK;
}

int zjs_compress(const uint8_t* src, size_t src_size, int level, int checksum,
                 const uint8_t* dict, size_t dict_size, zjs_buf* out,
                 const char** detail) {
  ZSTD_CCtx* cctx;
  size_t bound, r;
  int rc;

  if (!zjs_valid_level(level)) return zjs_fail(ZJS_ERR_ARG, "compression level out of range", detail);
  bound = ZSTD_compressBound(src_size);
  if (ZSTD_isError(bound) || bound == 0) return zjs_fail(ZJS_ERR_ARG, "input too large", detail);

  cctx = ZSTD_createCCtx();
  if (!cctx) return zjs_fail(ZJS_ERR_NOMEM, "out of memory", detail);
  rc = zjs_configure_cctx(cctx, level, checksum, dict, dict_size, detail);
  if (rc == ZJS_OK) rc = zjs_buf_reserve(out, bound, detail);
  if (rc == ZJS_OK) {
    r = ZSTD_compress2(cctx, out->data + out->size, out->cap - out->size,
                       src_size ? src : &zjs_empty, src_size);
    if (ZSTD_isError(r)) {
      rc = zjs_lib_fail(r, detail);
    } else {
      out->size += r;
    }
  }
  ZSTD_freeCCtx(cctx);
  return rc;
}

/* ---- streaming compression --------------------------------------------- */

struct zjs_cstream {
  ZSTD_CCtx* cctx;
};

int zjs_cstream_create(int level, int checksum, const uint8_t* dict,
                       size_t dict_size, zjs_cstream** stream,
                       const char** detail) {
  zjs_cstream* s;
  int rc;
  *stream = NULL;
  if (!zjs_valid_level(level)) return zjs_fail(ZJS_ERR_ARG, "compression level out of range", detail);
  s = (zjs_cstream*)calloc(1, sizeof(*s));
  if (!s) return zjs_fail(ZJS_ERR_NOMEM, "out of memory", detail);
  s->cctx = ZSTD_createCCtx();
  if (!s->cctx) {
    free(s);
    return zjs_fail(ZJS_ERR_NOMEM, "out of memory", detail);
  }
  rc = zjs_configure_cctx(s->cctx, level, checksum, dict, dict_size, detail);
  if (rc != ZJS_OK) {
    zjs_cstream_free(s);
    return rc;
  }
  *stream = s;
  return ZJS_OK;
}

int zjs_cstream_push(zjs_cstream* stream, const uint8_t* src, size_t src_size,
                     int mode, zjs_buf* out, const char** detail) {
  ZSTD_EndDirective op;
  ZSTD_inBuffer in;
  int rc;

  if (!stream || !stream->cctx) return zjs_fail(ZJS_ERR_ARG, "stream is closed", detail);
  switch (mode) {
    case ZJS_MODE_CONTINUE: op = ZSTD_e_continue; break;
    case ZJS_MODE_FLUSH: op = ZSTD_e_flush; break;
    case ZJS_MODE_END: op = ZSTD_e_end; break;
    default: return zjs_fail(ZJS_ERR_ARG, "invalid stream mode", detail);
  }
  in.src = src_size ? src : &zjs_empty;
  in.size = src_size;
  in.pos = 0;

  for (;;) {
    ZSTD_outBuffer o;
    size_t r;
    rc = zjs_buf_reserve(out, ZSTD_CStreamOutSize(), detail);
    if (rc != ZJS_OK) return rc;
    o.dst = out->data + out->size;
    o.size = out->cap - out->size;
    o.pos = 0;
    r = ZSTD_compressStream2(stream->cctx, &o, &in, op);
    if (ZSTD_isError(r)) return zjs_lib_fail(r, detail);
    out->size += o.pos;
    /* continue: done once all input is consumed. flush/end: done once
     * libzstd reports nothing left to write (r == 0), which also implies all
     * input was consumed. */
    if (op == ZSTD_e_continue ? in.pos == in.size : r == 0) break;
  }
  return ZJS_OK;
}

void zjs_cstream_free(zjs_cstream* stream) {
  if (!stream) return;
  ZSTD_freeCCtx(stream->cctx);
  free(stream);
}

/* ---- streaming decompression ------------------------------------------- */

struct zjs_dstream {
  ZSTD_DCtx* dctx;
  size_t max_output;
  size_t total_out;
  /* Last ZSTD_decompressStream() result from a call that made progress.
   * 0 means "at a frame boundary"; anything else means a frame is open or
   * no frame has been seen yet (empty input is not a valid zstd stream). */
  size_t last_ret;
  int seen_input;
};

int zjs_dstream_create(const uint8_t* dict, size_t dict_size,
                       int window_log_max, size_t max_output,
                       zjs_dstream** stream, const char** detail) {
  zjs_dstream* s;
  size_t r;
  *stream = NULL;
  s = (zjs_dstream*)calloc(1, sizeof(*s));
  if (!s) return zjs_fail(ZJS_ERR_NOMEM, "out of memory", detail);
  s->dctx = ZSTD_createDCtx();
  if (!s->dctx) {
    free(s);
    return zjs_fail(ZJS_ERR_NOMEM, "out of memory", detail);
  }
  s->max_output = max_output;
  s->last_ret = 1;
  if (window_log_max != 0) {
    r = ZSTD_DCtx_setParameter(s->dctx, ZSTD_d_windowLogMax, window_log_max);
    if (ZSTD_isError(r)) {
      zjs_dstream_free(s);
      return zjs_lib_fail(r, detail);
    }
  }
  if (dict_size > 0) {
    r = ZSTD_DCtx_loadDictionary(s->dctx, dict, dict_size); /* copies dict */
    if (ZSTD_isError(r)) {
      zjs_dstream_free(s);
      return zjs_lib_fail(r, detail);
    }
  }
  *stream = s;
  return ZJS_OK;
}

int zjs_dstream_push(zjs_dstream* stream, const uint8_t* src, size_t src_size,
                     zjs_buf* out, const char** detail) {
  ZSTD_inBuffer in;
  int rc;

  if (!stream || !stream->dctx) return zjs_fail(ZJS_ERR_ARG, "stream is closed", detail);
  in.src = src_size ? src : &zjs_empty;
  in.size = src_size;
  in.pos = 0;
  if (src_size) stream->seen_input = 1;

  for (;;) {
    ZSTD_outBuffer o;
    size_t r, in_before, allowed;

    if (out->size == out->cap) {
      rc = zjs_buf_reserve(out, ZSTD_DStreamOutSize(), detail);
      if (rc != ZJS_OK) return rc;
    }
    /* Never let libzstd write more than one byte past the limit: that byte
     * is how we detect "too big" without decoding the rest. */
    allowed = stream->max_output - stream->total_out;
    if (allowed < SIZE_MAX) allowed += 1;

    o.dst = out->data + out->size;
    o.size = out->cap - out->size;
    if (o.size > allowed) o.size = allowed;
    o.pos = 0;
    in_before = in.pos;

    r = ZSTD_decompressStream(stream->dctx, &o, &in);
    if (ZSTD_isError(r)) return zjs_lib_fail(r, detail);

    out->size += o.pos;
    stream->total_out += o.pos;
    if (stream->total_out > stream->max_output) {
      return zjs_fail(ZJS_ERR_OUTPUT_LIMIT, "decompressed size exceeds maxOutputSize", detail);
    }
    if (o.pos > 0 || in.pos > in_before) stream->last_ret = r;

    if (in.pos == in.size) {
      /* r == 0: frame fully decoded and flushed. o.pos < o.size: libzstd had
       * room left, so it flushed everything it could. Either way nothing is
       * held back. If the output filled up exactly, loop to drain it. */
      if (r == 0 || o.pos < o.size) break;
    } else if (o.pos == 0 && in.pos == in_before) {
      return zjs_fail(ZJS_ERR_LIBRARY, "zstd decoder made no progress", detail);
    }
  }
  return ZJS_OK;
}

int zjs_dstream_finish(zjs_dstream* stream, const char** detail) {
  if (!stream || !stream->dctx) return zjs_fail(ZJS_ERR_ARG, "stream is closed", detail);
  if (stream->last_ret != 0) {
    return zjs_fail(ZJS_ERR_TRUNCATED,
                    stream->seen_input ? "zstd input ended before the end of a frame"
                                       : "zstd input is empty",
                    detail);
  }
  return ZJS_OK;
}

void zjs_dstream_free(zjs_dstream* stream) {
  if (!stream) return;
  ZSTD_freeDCtx(stream->dctx);
  free(stream);
}

int zjs_decompress(const uint8_t* src, size_t src_size, const uint8_t* dict,
                   size_t dict_size, int window_log_max, size_t max_output,
                   zjs_buf* out, const char** detail) {
  zjs_dstream* s;
  unsigned long long bound;
  size_t hint;
  int rc;

  rc = zjs_dstream_create(dict, dict_size, window_log_max, max_output, &s, detail);
  if (rc != ZJS_OK) return rc;

  /* Size the first allocation from the frame headers when they declare a
   * content size (exact for well-formed input), otherwise from the input
   * size. Capped, because headers can lie. */
  bound = src_size ? ZSTD_decompressBound(src, src_size) : ZSTD_CONTENTSIZE_ERROR;
  if (bound != ZSTD_CONTENTSIZE_ERROR) {
    hint = bound > ZJS_INITIAL_CAP_LIMIT ? ZJS_INITIAL_CAP_LIMIT : (size_t)bound;
  } else {
    hint = src_size > ZJS_INITIAL_CAP_LIMIT / 4 ? ZJS_INITIAL_CAP_LIMIT : src_size * 4;
    if (hint < 65536) hint = 65536;
  }
  if (max_output < SIZE_MAX && hint > max_output + 1) hint = max_output + 1;
  if (hint > 0 && zjs_buf_reserve(out, hint, detail) != ZJS_OK) {
    /* Not fatal: start small and let real output drive growth. */
    if (detail) *detail = NULL;
  }

  rc = zjs_dstream_push(s, src, src_size, out, detail);
  if (rc == ZJS_OK) rc = zjs_dstream_finish(s, detail);
  zjs_dstream_free(s);
  return rc;
}

int zjs_frame_content_size(const uint8_t* src, size_t src_size, double* size,
                           const char** detail) {
  unsigned long long n = ZSTD_getFrameContentSize(src_size ? src : &zjs_empty, src_size);
  if (n == ZSTD_CONTENTSIZE_ERROR) {
    return zjs_fail(ZJS_ERR_ARG, "not a zstd frame, or the header is incomplete", detail);
  }
  *size = n == ZSTD_CONTENTSIZE_UNKNOWN ? -1.0 : (double)n;
  return ZJS_OK;
}

const char* zjs_version(void) { return ZSTD_versionString(); }
int zjs_min_level(void) { return ZSTD_minCLevel(); }
int zjs_max_level(void) { return ZSTD_maxCLevel(); }
int zjs_default_level(void) { return ZSTD_defaultCLevel(); }
