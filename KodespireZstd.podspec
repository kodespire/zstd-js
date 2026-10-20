# React Native (iOS) build of the native binding: cpp/ over csrc/zjs.c and the
# bundled zstd sources, the same C code as the Node-API addon and the WebAssembly build.
require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))
zstd = "deps/zstd/lib"

Pod::Spec.new do |s|
  s.name         = "KodespireZstd"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.authors      = package["author"]
  s.platforms    = { :ios => min_ios_version_supported }
  s.source       = { :git => "https://github.com/kodespire/zstd-js.git", :tag => "v#{s.version}" }

  s.source_files = [
    "ios/*.{h,mm}",
    "cpp/*.{h,cpp}",
    "csrc/zjs.{h,c}",
    "#{zstd}/*.h",
    "#{zstd}/{common,compress,decompress}/*.{h,c}",
  ]
  # Only the provider is public, so zstd's internal headers (mem.h, debug.h, ...)
  # never shadow another pod's.
  s.public_header_files = "ios/*.h"

  s.pod_target_xcconfig = {
    "HEADER_SEARCH_PATHS" => "\"$(PODS_TARGET_SRCROOT)/cpp\" \"$(PODS_TARGET_SRCROOT)/csrc\" " \
                             "\"$(PODS_TARGET_SRCROOT)/#{zstd}\" \"$(PODS_TARGET_SRCROOT)/#{zstd}/common\"",
    # Same defines as binding.gyp and scripts/build-wasm.mjs.
    "GCC_PREPROCESSOR_DEFINITIONS" => "$(inherited) ZSTD_LEGACY_SUPPORT=0 ZSTD_DISABLE_ASM ZSTD_NO_TRACE XXH_NAMESPACE=ZSTD_",
    "GCC_OPTIMIZATION_LEVEL" => "3",
    "GCC_SYMBOLS_PRIVATE_EXTERN" => "YES",
    # Xcode's defaults flag a few idioms in zstd's sources.
    "CLANG_WARN_COMMA" => "NO",
    "CLANG_WARN_UNREACHABLE_CODE" => "NO",
  }

  install_modules_dependencies(s)
end
