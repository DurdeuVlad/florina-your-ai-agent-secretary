/**
 * Desktop launcher — spawns the Electron binary with a sanitized environment.
 *
 * `ELECTRON_RUN_AS_NODE` makes electron.exe behave as plain Node (no
 * `electron` builtin, `require('electron')` resolves to the npm shim). When
 * the variable leaks into a developer shell — e.g. exported globally or by
 * tooling — `npm run desktop` would launch a window-less Node process that
 * crashes on `app.whenReady()`. Deleting it here makes the script robust
 * regardless of the caller's environment.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const electronBin = require('electron'); // npm shim exports the binary path
const entry = fileURLToPath(new URL('../dist/bootstrap/desktop.js', import.meta.url));

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBin, [entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
});
child.on('exit', (code) => process.exit(code ?? 0));
