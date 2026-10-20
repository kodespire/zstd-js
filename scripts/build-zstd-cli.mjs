// Builds the official zstd command-line tool from deps/zstd into out/zstd-cli/zstd,
// for generating fixtures and for interop tests. Needs make and a C compiler.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const work = join(root, 'out', 'zstd-cli');
export const cliPath = join(work, 'programs', process.platform === 'win32' ? 'zstd.exe' : 'zstd');

export function buildCli() {
  if (existsSync(cliPath)) return cliPath;
  mkdirSync(work, { recursive: true });
  // Build in a copy so the submodule's working tree stays clean.
  for (const dir of ['lib', 'programs']) {
    cpSync(join(root, 'deps', 'zstd', dir), join(work, dir), { recursive: true });
  }
  execFileSync('make', ['-j8', 'zstd'], { cwd: join(work, 'programs'), stdio: ['ignore', 'ignore', 'inherit'] });
  return cliPath;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(buildCli());
}
