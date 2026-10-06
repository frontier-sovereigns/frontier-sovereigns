import { spawn } from 'node:child_process';
const node = process.execPath;
const env = { ...process.env, NODE_ENV: 'development' };
// Both processes are our own children; no existing host/model processes are touched.
const children = [
  spawn(node, ['--env-file-if-exists=.env', '--import', 'tsx', 'apps/server/src/index.ts'], { stdio: 'inherit', env }),
  spawn(node, ['--env-file-if-exists=../../.env', 'node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], { cwd: 'apps/client', stdio: 'inherit', env }),
];
let closing = false;
function close(code = 0) { if (closing) return; closing = true; for (const child of children) child.kill(); process.exitCode = code; }
for (const child of children) { child.on('error', e => { console.error(e.message); close(1); }); child.on('exit', code => close(code ?? 1)); }
process.on('SIGINT', () => close());
process.on('SIGTERM', () => close());
