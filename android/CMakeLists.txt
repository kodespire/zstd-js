# The C++ TurboModule, added to the app's native build by autolinking
# (react-native.config.js). Same sources and defines as binding.gyp.
cmake_minimum_required(VERSION 3.13)
project(kodespire_zstd C CXX)

set(ROOT ${CMAKE_CURRENT_LIST_DIR}/..)
set(ZSTD ${ROOT}/deps/zstd/lib)
file(GLOB ZSTD_SOURCES ${ZSTD}/common/*.c ${ZSTD}/compress/*.c ${ZSTD}/decompress/*.c)

add_library(kodespire_zstd STATIC
  ${ROOT}/cpp/KodespireZstdModule.cpp
  ${ROOT}/csrc/zjs.c
  ${ZSTD_SOURCES})

target_include_directories(kodespire_zstd
  PUBLIC ${ROOT}/cpp
  PRIVATE ${ROOT}/csrc ${ZSTD} ${ZSTD}/common)
target_compile_definitions(kodespire_zstd PRIVATE
  ZSTD_LEGACY_SUPPORT=0 ZSTD_DISABLE_ASM ZSTD_NO_TRACE XXH_NAMESPACE=ZSTD_)
# -O3 in debug builds too: zstd at -O0 is too slow to be useful.
target_compile_options(kodespire_zstd PRIVATE -O3 -fvisibility=hidden)
set_target_properties(kodespire_zstd PROPERTIES CXX_STANDARD 20 CXX_STANDARD_REQUIRED ON)

target_link_libraries(kodespire_zstd ReactAndroid::jsi ReactAndroid::reactnative)
