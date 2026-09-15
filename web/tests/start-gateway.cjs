const { spawn } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const data = mkdtempSync(path.join(tmpdir(), 'gateway-browser-test-'));
const child = spawn(path.resolve(__dirname, '../../bin/gateway'), [
  '--addr', '127.0.0.1:18318', '--data-dir', data,
  ...(process.argv.includes('--local-no-password') ? ['--local-no-password'] : []),
], { stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('error', error => {
  rmSync(data, { recursive: true, force: true });
  console.error(error.message);
  process.exit(1);
});
child.on('exit', code => {
  rmSync(data, { recursive: true, force: true });
  process.exit(code ?? 0);
});
