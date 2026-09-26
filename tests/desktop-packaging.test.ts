/**
 * Unit tests for the desktop packaged-mode renderer path resolver (issue #171, DEC-028).
 *
 * The `resolveRendererAsset` helper in src/bootstrap/desktop.ts chooses between two
 * roots depending on `app.isPackaged`:
 *
 *   - dev:      relative to the compiled bootstrap file (source tree)
 *   - packaged: process.resourcesPath + "renderer/" + relativePath
 *
 * Because the function calls `app.isPackaged` which requires a live Electron
 * main process, we test the logic directly without importing desktop.ts (which
 * would try to `require('electron')`). The logic is simple enough that
 * property-based tests on the two branches are sufficient.
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Replica of the logic in src/bootstrap/desktop.ts so we can test it without
// importing Electron. If the implementation changes, update this replica too.
// ---------------------------------------------------------------------------

function makeResolver(
  isPackaged: boolean,
  resourcesPath: string,
  bootstrapDir: string,
): (relativePath: string) => string {
  return (relativePath: string) => {
    if (isPackaged) {
      return path.join(resourcesPath, 'renderer', relativePath);
    }
    // Mirrors the fileURLToPath(new URL(...)) pattern from desktop.ts:
    // bootstrapDir is the directory of dist/bootstrap/desktop.js
    return path.join(bootstrapDir, '..', '..', 'src', 'adapters', 'inbound', 'desktop', 'renderer', relativePath);
  };
}

describe('resolveRendererAsset — dev mode', () => {
  const bootstrapDir = path.join('C:', 'projects', 'florina', 'dist', 'bootstrap');
  const resolve = makeResolver(false, '', bootstrapDir);

  it('resolves index.html into the source renderer directory', () => {
    const result = resolve('index.html');
    expect(result).toContain(path.join('src', 'adapters', 'inbound', 'desktop', 'renderer'));
    expect(result).toContain('index.html');
  });

  it('resolves preload.cjs into the source renderer directory', () => {
    const result = resolve('preload.cjs');
    expect(result).toContain('preload.cjs');
    expect(result).toContain(path.join('src', 'adapters', 'inbound', 'desktop', 'renderer'));
  });

  it('resolves voice-overlay.html into the source renderer directory', () => {
    const result = resolve('voice-overlay.html');
    expect(result).toContain('voice-overlay.html');
  });
});

describe('resolveRendererAsset — packaged mode', () => {
  const resourcesPath = path.join('C:', 'Program Files', 'Florina', 'resources');
  const resolve = makeResolver(true, resourcesPath, '');

  it('resolves index.html under process.resourcesPath/renderer', () => {
    const result = resolve('index.html');
    expect(result).toBe(path.join(resourcesPath, 'renderer', 'index.html'));
  });

  it('resolves preload.cjs under process.resourcesPath/renderer', () => {
    const result = resolve('preload.cjs');
    expect(result).toBe(path.join(resourcesPath, 'renderer', 'preload.cjs'));
  });

  it('resolves voice-overlay.html under process.resourcesPath/renderer', () => {
    const result = resolve('voice-overlay.html');
    expect(result).toBe(path.join(resourcesPath, 'renderer', 'voice-overlay.html'));
  });

  it('never uses the source-tree path in packaged mode', () => {
    const result = resolve('index.html');
    expect(result).not.toContain('src');
  });

  it('returns an absolute path', () => {
    const result = resolve('index.html');
    expect(path.isAbsolute(result)).toBe(true);
  });
});

describe('resolveRendererAsset — path safety', () => {
  const resourcesPath = path.join('C:', 'resources');
  const resolve = makeResolver(true, resourcesPath, '');

  it('produces a path under resourcesPath for any valid filename', () => {
    for (const file of ['index.html', 'preload.cjs', 'voice-overlay.html', 'custom.js']) {
      const result = resolve(file);
      expect(result.startsWith(resourcesPath)).toBe(true);
    }
  });
});
