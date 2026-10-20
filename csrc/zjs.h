/*
 * zjs: the C layer shared by the Node-API addon and the WebAssembly build.
 *
 * Every compress/decompress loop lives here, once. Both bindings are thin
 * wrappers that move bytes in and out, so a fix or a test here covers both.
 *
 * Conventions:
 *   - Functions return ZJS_OK (0) or a ZJS_ERR_* code.
 *   - On error, *detail (when non-NULL) points to a static, NUL-terminated
 *     message. It is never freed and is safe to read from any thread.
 *   - Output is appended to a caller-owned zjs_buf, which the caller frees
 *     with zjs_buf_free (also on error).
 */
#ifndef ZJS_H
#define ZJS_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum {
  ZJS_OK = 0,
  ZJS_ERR_LIBRARY = 1,      /* libzstd reported an error; detail is its message */
  ZJS_ERR_TRUNCATED = 2,    /* input ended before the end of a frame (or was empty) */
  ZJS_ERR_OUTPUT_LIMIT = 3, /* decompressed size would exceed max_output */
  ZJS_ERR_NOMEM = 4,        /* allocation failed */
  ZJS_ERR_ARG = 5           /* invalid argument */
};

enum { ZJS_MODE_CONTINUE = 0, ZJS_MODE_FLUSH = 1, ZJS_MODE_END = 2 };

typedef struct zjs_buf {
  uint8_t* data;
  size_t size;
  size_t cap;
} zjs_buf;

void zjs_buf_free(zjs_buf* buf);

/* One-shot compression of src into a single frame (content size recorded). */
int zjs_compress(const uint8_t* src, size_t src_size, int level, int checksum,
                 const uint8_t* dict, size_t dict_size, zjs_buf* out,
                 const char** detail);

/*
 * One-shot decompression of every frame in src (concatenated and skippable
 * frames included). Fails with ZJS_ERR_TRUNCATED unless src ends exactly at
 * the end of a frame. window_log_max = 0 keeps the libzstd default (27).
 * max_output = SIZE_MAX means no limit.
 */
int zjs_decompress(const uint8_t* src, size_t src_size, const uint8_t* dict,
                   size_t dict_size, int window_log_max, size_t max_output,
                   zjs_buf* out, const char** detail);

typedef struct zjs_cstream zjs_cstream;
typedef struct zjs_dstream zjs_dstream;

int zjs_cstream_create(int level, int checksum, const uint8_t* dict,
                       size_t dict_size, zjs_cstream** stream,
                       const char** detail);
/* mode: ZJS_MODE_CONTINUE, ZJS_MODE_FLUSH (end of block) or ZJS_MODE_END (end of frame). */
int zjs_cstream_push(zjs_cstream* stream, const uint8_t* src, size_t src_size,
                     int mode, zjs_buf* out, const char** detail);
void zjs_cstream_free(zjs_cstream* stream);

int zjs_dstream_create(const uint8_t* dict, size_t dict_size,
                       int window_log_max, size_t max_output,
                       zjs_dstream** stream, const char** detail);
/* Decodes all of src. Returns only once every byte decodable so far is in out. */
int zjs_dstream_push(zjs_dstream* stream, const uint8_t* src, size_t src_size,
                     zjs_buf* out, const char** detail);
/* Call at end of input: fails with ZJS_ERR_TRUNCATED if a frame is unfinished. */
int zjs_dstream_finish(zjs_dstream* stream, const char** detail);
void zjs_dstream_free(zjs_dstream* stream);

/* Content size declared by the first frame's header: -1 if not recorded. */
int zjs_frame_content_size(const uint8_t* src, size_t src_size, double* size,
                           const char** detail);

const char* zjs_version(void);
int zjs_min_level(void);
int zjs_max_level(void);
int zjs_default_level(void);

#ifdef __cplusplus
}
#endif

#endif /* ZJS_H */
