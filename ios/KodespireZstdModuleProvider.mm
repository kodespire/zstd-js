#import "KodespireZstdModuleProvider.h"

#import "KodespireZstdModule.h"

@implementation KodespireZstdModuleProvider

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::KodespireZstdModule>(params.jsInvoker);
}

@end
