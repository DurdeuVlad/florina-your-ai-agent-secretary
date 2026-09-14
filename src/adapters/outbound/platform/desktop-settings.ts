/**
 * Desktop-local settings (issue #132, DEC-028) — preferences that belong
 * to the desktop app itself rather than the daemon's routing profile.
 * Persisted as JSON at `~/.florina/desktop-settings.json` so they apply
 * even when the daemon is down (the daemon profile can't hold them — the
 * app needs them to decide how to treat the daemon's lifecycle).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface DesktopSettings {
  /**
   * When true, quitting the app also stops the local daemon
   * (`florina stop`). Default false — the daemon is a shared local
   * service other surfaces (CLI, voice) may still be using, so quitting
   * the window leaves it running.
   */
  readonly stopDaemonOnQuit: boolean;
}

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  stopDaemonOnQuit: false,
};

/** Path of the desktop settings file inside `dir` (default `~/.florina`). */
export function desktopSettingsPath(dir: string = join(homedir(), '.florina')): string {
  return join(dir, 'desktop-settings.json');
}

/**
 * Read desktop settings. Missing or malformed files return the defaults —
 * a corrupt settings file must never break app startup.
 */
export function readDesktopSettings(dir?: string): DesktopSettings {
  const file = desktopSettingsPath(dir);
  if (!existsSync(file)) return { ...DEFAULT_DESKTOP_SETTINGS };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    return {
      stopDaemonOnQuit:
        typeof parsed['stopDaemonOnQuit'] === 'boolean'
          ? parsed['stopDaemonOnQuit']
          : DEFAULT_DESKTOP_SETTINGS.stopDaemonOnQuit,
    };
  } catch {
    return { ...DEFAULT_DESKTOP_SETTINGS };
  }
}

/** Persist desktop settings, creating the directory if needed. */
export function writeDesktopSettings(settings: DesktopSettings, dir?: string): void {
  const file = desktopSettingsPath(dir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
}
