// Declares the native module for React Native's codegen, which registers it with
// the app (see codegenConfig in package.json). Nothing imports this file: the module
// is written by hand in cpp/KodespireZstdModule.cpp, and src/jsi-backend.ts is its
// JavaScript side. Byte arrays are typed as Object because codegen has no Uint8Array.
import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  version(): string;
  compressSync(data: Object, level: number, checksum: boolean, dictionary: Object | null): Object;
  compress(data: Object, level: number, checksum: boolean, dictionary: Object | null): Promise<Object>;
  decompressSync(data: Object, dictionary: Object | null, windowLogMax: number, maxOutputSize: number): Object;
  decompress(data: Object, dictionary: Object | null, windowLogMax: number, maxOutputSize: number): Promise<Object>;
  frameContentSize(data: Object): number;
  createCStream(level: number, checksum: boolean, dictionary: Object | null): Object;
  createDStream(dictionary: Object | null, windowLogMax: number, maxOutputSize: number): Object;
}

export default TurboModuleRegistry.get<Spec>('KodespireZstd');
