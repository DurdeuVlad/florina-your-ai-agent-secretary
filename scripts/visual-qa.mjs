/**
 * Visual QA launcher (issue #133) — spawns Electron with the capture
 * entry. Same ELECTRON_RUN_AS_NODE sanitization as desktop.mjs.
 *
 * `npm run build && npm run visual-qa` → PNGs land in ./shots/
 * (gitignored): mockup-<screen>.png vs app-<view>.png for the
 * side-by-side pass defined in docs/VISUAL_QA.md.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const electronBin = require('electron');
const entry = fileURLToPath(new URL('./visual-qa-entry.cjs', import.meta.url));

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBin, [entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
});
child.on('exit', (code) => process.exit(code ?? 0));
