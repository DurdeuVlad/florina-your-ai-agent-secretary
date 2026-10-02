/**
 * Postinstall guard for the Electron binary (issue #115).
 *
 * When npm runs with scripts disabled (--ignore-scripts, or a global
 * `ignore-scripts=true` in .npmrc), electron's own install step never runs
 * and `node_modules/electron/dist/` stays empty — `npm run desktop` then
 * fails at spawn time with a confusing error. This script detects the
 * missing binary and runs Electron's installer directly. It is a no-op when
 * the binary is already present, so it is safe as a normal postinstall hook.
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const electronDir = dirname(require.resolve('electron')); // …/node_modules/electron
// Electron's extracted layout differs per OS: win32 → dist/electron.exe,
// darwin → dist/Electron.app/Contents/MacOS/Electron, linux → dist/electron.
const binaryPath = join(
  electronDir,
  'dist',
  process.platform === 'win32'
    ? 'electron.exe'
    : process.platform === 'darwin'
      ? join('Electron.app', 'Contents', 'MacOS', 'Electron')
      : 'electron',
);

if (!existsSync(binaryPath)) {
  console.log('electron binary missing — running installer…');
  spawnSync(process.execPath, [join(electronDir, 'install.js')], {
    stdio: 'inherit',
  });
}

if (!existsSync(binaryPath)) {
  console.error(
    'electron binary still missing after install. ' +
      'Re-run manually: node node_modules/electron/install.js',
  );
  process.exit(1);
}
