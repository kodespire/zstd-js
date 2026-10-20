// React Native binding: a C++ TurboModule over the zjs C layer (csrc/zjs.c), the
// same code the Node-API addon and the WebAssembly build wrap. Registered on iOS by
// ios/KodespireZstdModuleProvider.mm and on Android by autolinking
// (react-native.config.js). src/jsi-backend.ts is the JavaScript side.

#pragma once

#include <ReactCommon/TurboModule.h>
#include <jsi/jsi.h>

#include <memory>
#include <string>

namespace facebook::react {

namespace kodespire_zstd {
class Promises;
}

class KodespireZstdModule : public TurboModule {
 public:
  static constexpr const char* kModuleName = "KodespireZstd";

  explicit KodespireZstdModule(std::shared_ptr<CallInvoker> jsInvoker);
  ~KodespireZstdModule() override;

  // The method implementations need these; they are not part of the JS interface.
  const std::shared_ptr<kodespire_zstd::Promises>& promises() const { return promises_; }
  std::weak_ptr<CallInvoker> invoker() const { return jsInvoker_; }

 private:
  // Pending promises, keyed by id. Only touched on the JS thread; workers hold a weak_ptr.
  std::shared_ptr<kodespire_zstd::Promises> promises_;
};

}  // namespace facebook::react
