// Starts `wrangler dev` on worker.mjs in the current directory (a project with
// @kodespire/zstd-js and wrangler installed), requests it, and checks the result.
//   cp worker.mjs wrangler.toml run.mjs <project> && cd <project> && node run.mjs
import { spawn } from 'node:child_process';

const port = 8799;
const wrangler = spawn('npx', ['wrangler', 'dev', '--port', String(port), '--ip', '127.0.0.1'], {
  env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' },
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: process.platform === 'win32',
});
let log = '';
wrangler.stdout.on('data', (d) => (log += d));
wrangler.stderr.on('data', (d) => (log += d));

let result;
const deadline = Date.now() + 90_000;
while (Date.now() < deadline && wrangler.exitCode === null) {
  try {
    result = await (await fetch(`http://127.0.0.1:${port}/`)).json();
    break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
wrangler.kill();

const ok = result && !result.error && result.roundTrip && result.sync && result.stream &&
  result.truncated === 'ERR_ZSTD_TRUNCATED' && result.backend === 'wasm';
console.log(ok ? 'ok: workerd' : 'FAIL: workerd', JSON.stringify(result));
if (!ok) {
  console.log(log);
  process.exit(1);
}
