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
  /**
   * Preferred microphone device id (renderer `getUserMedia` constraint,
   * issue #162). Undefined → the OS default input device.
   */
  readonly micDeviceId?: string;
  /**
   * When true, the Chat composer opens in voice mode (two-way turns)
   * instead of dictation (issue #162). Default false — dictation is the
   * conservative default; voice mode is an explicit opt-in.
   */
  readonly voiceModeDefault: boolean;
  /**
   * BCP-47-ish language hint for speech transcription (issue #163) —
   * applied to the realtime transcription session config and the
   * whisper.cpp adapter. Undefined → auto-detect.
   */
  readonly dictationLanguage?: string;
  /**
   * Saved push-to-talk accelerator (issue #332). Persisted only after the
   * OS-level registration succeeds — a saved value always means "this is
   * bound". `FLORINA_PTT_HOTKEY` env wins over this when set; both fall
   * back to the built-in default.
   */
  readonly pttHotkey?: string;
  /**
   * First-run setup state (issue #277): `open` (or undefined on a fresh
   * install) shows the guided setup on the Florina view; `skipped`
   * collapses it to a resumable row; `done` hides it. Desktop-local —
   * setup progress is a UI concern, not daemon state.
   */
  readonly onboardingState?: 'open' | 'skipped' | 'done';
}

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  stopDaemonOnQuit: false,
  voiceModeDefault: false,
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
      voiceModeDefault:
        typeof parsed['voiceModeDefault'] === 'boolean'
          ? parsed['voiceModeDefault']
          : DEFAULT_DESKTOP_SETTINGS.voiceModeDefault,
      ...(typeof parsed['micDeviceId'] === 'string' && parsed['micDeviceId'].length > 0
        ? { micDeviceId: parsed['micDeviceId'] }
        : {}),
      ...(typeof parsed['dictationLanguage'] === 'string' && parsed['dictationLanguage'].length > 0
        ? { dictationLanguage: parsed['dictationLanguage'] }
        : {}),
      ...(typeof parsed['pttHotkey'] === 'string' && parsed['pttHotkey'].length > 0
        ? { pttHotkey: parsed['pttHotkey'] }
        : {}),
      ...(parsed['onboardingState'] === 'open' ||
      parsed['onboardingState'] === 'skipped' ||
      parsed['onboardingState'] === 'done'
        ? { onboardingState: parsed['onboardingState'] }
        : {}),
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
