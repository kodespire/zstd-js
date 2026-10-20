// Prints the libzstd C sources that both builds compile, one per line.
// Used by binding.gyp (via <!@(...)) and scripts/build-wasm.mjs.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const lib = path.join('deps', 'zstd', 'lib');

function sources() {
  const out = [];
  for (const dir of ['common', 'compress', 'decompress']) {
    const abs = path.join(root, lib, dir);
    if (!fs.existsSync(abs)) {
      throw new Error(`${abs} is missing. Run: git submodule update --init`);
    }
    for (const name of fs.readdirSync(abs).sort()) {
      if (name.endsWith('.c')) out.push(path.posix.join('deps/zstd/lib', dir, name));
    }
  }
  return out;
}

module.exports = { sources };

if (require.main === module) {
  process.stdout.write(sources().join('\n') + '\n');
}
