import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import * as constants from '../src/version.js';

const header = readFileSync(join(import.meta.dirname, '..', 'deps', 'zstd', 'lib', 'zstd.h'), 'utf8');
const define = (name: string) => Number(new RegExp(`#define ${name}\\s+(\\d+)`).exec(header)![1]);

describe('version constants', () => {
  it('ZSTD_VERSION matches deps/zstd/lib/zstd.h', () => {
    expect(constants.ZSTD_VERSION).toBe(`${define('ZSTD_VERSION_MAJOR')}.${define('ZSTD_VERSION_MINOR')}.${define('ZSTD_VERSION_RELEASE')}`);
  });

  it('level constants match the compiled library (native addon)', () => {
    const require = createRequire(import.meta.url);
    const addon = require('node-gyp-build')(join(import.meta.dirname, '..'));
    expect(addon.version).toBe(constants.ZSTD_VERSION);
    expect(addon.minLevel).toBe(constants.MIN_LEVEL);
    expect(addon.maxLevel).toBe(constants.MAX_LEVEL);
    expect(addon.defaultLevel).toBe(constants.DEFAULT_LEVEL);
  });
});
