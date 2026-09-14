/**
 * Desktop-local settings (issue #132): ~/.florina/desktop-settings.json
 * holds app-owned preferences — chiefly `stopDaemonOnQuit`, the
 * leave-or-stop choice on quit.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';

import {
  DEFAULT_DESKTOP_SETTINGS,
  desktopSettingsPath,
  readDesktopSettings,
  writeDesktopSettings,
} from '../src/adapters/outbound/platform/desktop-settings.js';

const dirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'florina-settings-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('desktop settings (issue #132)', () => {
  it('returns defaults when the file does not exist', () => {
    expect(readDesktopSettings(tmpDir())).toEqual(DEFAULT_DESKTOP_SETTINGS);
    expect(DEFAULT_DESKTOP_SETTINGS.stopDaemonOnQuit).toBe(false);
  });

  it('round-trips a written settings file', () => {
    const dir = tmpDir();
    writeDesktopSettings({ stopDaemonOnQuit: true }, dir);
    expect(readDesktopSettings(dir)).toEqual({ stopDaemonOnQuit: true });
  });

  it('returns defaults on a malformed file — never breaks startup', () => {
    const dir = tmpDir();
    writeFileSync(desktopSettingsPath(dir), '{ not json');
    expect(readDesktopSettings(dir)).toEqual(DEFAULT_DESKTOP_SETTINGS);
  });

  it('ignores unknown fields and bad types', () => {
    const dir = tmpDir();
    writeFileSync(desktopSettingsPath(dir), JSON.stringify({ stopDaemonOnQuit: 'yes', future: 1 }));
    expect(readDesktopSettings(dir)).toEqual(DEFAULT_DESKTOP_SETTINGS);
  });
});
