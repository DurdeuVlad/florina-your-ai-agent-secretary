/**
 * PTT hotkey resolution + live rebind (issue #332): the accelerator the
 * app binds resolves env > saved > default, a `deskset:` save re-registers
 * without a restart, and a failed rebind keeps the working binding.
 */
import { describe, it, expect } from 'vitest';

import {
  createPttHotkey,
  DEFAULT_HOTKEYS,
  HotkeyManager,
  MockKeyboardBackend,
} from '../src/desktop/index.js';
import type { PttHotkeyDeps } from '../src/desktop/index.js';

function rig(opts?: Partial<PttHotkeyDeps>) {
  const backend = new MockKeyboardBackend();
  const hotkeys = new HotkeyManager(backend);
  const fires: string[] = [];
  const hints: string[] = [];
  const ptt = createPttHotkey({
    hotkeys,
    defaultAccelerator: DEFAULT_HOTKEYS.PTT_HOLD,
    onFire: () => fires.push('fire'),
    onHint: (h) => hints.push(h),
    ...opts,
  });
  return { backend, hotkeys, fires, hints, ptt };
}

describe('ptt hotkey resolution and rebind (issue #332)', () => {
  it('registers the default accelerator at startup and hints it', () => {
    const { hotkeys, hints, ptt } = rig();
    expect(ptt.register()).toBe(true);
    expect(hotkeys.isRegistered(DEFAULT_HOTKEYS.PTT_HOLD)).toBe(true);
    expect(hints.at(-1)).toBe(`${DEFAULT_HOTKEYS.PTT_HOLD} to talk — or click`);
  });

  it('saved setting wins over default; env wins over both', () => {
    const saved = rig({ savedAccelerator: 'Alt+P' });
    expect(saved.ptt.register()).toBe(true);
    expect(saved.hotkeys.isRegistered('Alt+P')).toBe(true);
    expect(saved.hotkeys.isRegistered(DEFAULT_HOTKEYS.PTT_HOLD)).toBe(false);

    const env = rig({ savedAccelerator: 'Alt+P', envAccelerator: 'Control+Alt+V' });
    expect(env.ptt.register()).toBe(true);
    expect(env.hotkeys.isRegistered('Control+Alt+V')).toBe(true);
    expect(env.hotkeys.isRegistered('Alt+P')).toBe(false);
  });

  it('startup conflict points the user at Settings, not just the env var', () => {
    const { backend, hints, ptt } = rig();
    backend.registered.add('CommandOrControl+space'); // held by another app
    expect(ptt.register()).toBe(false);
    expect(hints.at(-1)).toBe(
      `Hotkey conflict: ${DEFAULT_HOTKEYS.PTT_HOLD} — rebind in Settings → Desktop & voice`,
    );
  });

  it('env-sourced conflict names the env var as the culprit', () => {
    const envAccelerator = 'Alt+F9';
    const { backend, hints, ptt } = rig({ envAccelerator });
    backend.registered.add('Alt+f9');
    expect(ptt.register()).toBe(false);
    expect(hints.at(-1)).toBe(`Hotkey conflict: ${envAccelerator} (from FLORINA_PTT_HOTKEY)`);
  });

  it('a successful rebind swaps the registration and still fires onFire', () => {
    const { backend, fires, hotkeys, hints, ptt } = rig();
    ptt.register();
    expect(ptt.rebind('Alt+P').ok).toBe(true);
    expect(hotkeys.isRegistered('Alt+P')).toBe(true);
    expect(hotkeys.isRegistered(DEFAULT_HOTKEYS.PTT_HOLD)).toBe(false);
    expect(backend.registered.has('CommandOrControl+space')).toBe(false);
    expect(hints.at(-1)).toBe('Alt+P to talk — or click');
    expect(hotkeys.dispatch('Alt+P')).toBe(true);
    expect(fires).toEqual(['fire']);
  });

  it('a failed rebind keeps the working binding and names the culprit', () => {
    const { backend, hotkeys, hints, ptt } = rig();
    ptt.register();
    backend.registered.add('Alt+p'); // target held by another app
    const res = ptt.rebind('Alt+P');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Alt+P');
    expect(hotkeys.isRegistered(DEFAULT_HOTKEYS.PTT_HOLD)).toBe(true);
    expect(hotkeys.isRegistered('Alt+P')).toBe(false);
    // The HUD keeps advertising the binding that actually works.
    expect(hints.at(-1)).toBe(`${DEFAULT_HOTKEYS.PTT_HOLD} to talk — or click`);
  });

  it('clearing the field (null) reverts to the default', () => {
    const { hotkeys, ptt } = rig({ savedAccelerator: 'Alt+P' });
    ptt.register();
    expect(ptt.rebind(null).ok).toBe(true);
    expect(hotkeys.isRegistered(DEFAULT_HOTKEYS.PTT_HOLD)).toBe(true);
    expect(hotkeys.isRegistered('Alt+P')).toBe(false);
    expect(ptt.effective()).toBe(DEFAULT_HOTKEYS.PTT_HOLD);
  });

  it('under an env override, rebind resolves to the env accelerator', () => {
    const { hotkeys, ptt } = rig({ envAccelerator: 'Control+Alt+V' });
    ptt.register();
    // Saving anything else still resolves env-first → no OS churn.
    expect(ptt.rebind('Alt+P').ok).toBe(true);
    expect(hotkeys.isRegistered('Control+Alt+V')).toBe(true);
    expect(hotkeys.isRegistered('Alt+P')).toBe(false);
    expect(ptt.effective()).toBe('Control+Alt+V');
  });

  it('re-saving the already-bound accelerator is a no-op success', () => {
    const { backend, ptt } = rig({ savedAccelerator: 'Alt+P' });
    ptt.register();
    // 'alt+p' canonicalizes to the same binding — no false conflict.
    expect(ptt.rebind('alt+p').ok).toBe(true);
    expect(backend.registered.size).toBe(1);
  });

  it('a freed accelerator retries on the next save', () => {
    const { backend, hotkeys, ptt } = rig();
    backend.registered.add('CommandOrControl+space');
    expect(ptt.register()).toBe(false);
    backend.registered.delete('CommandOrControl+space'); // other app releases it
    expect(ptt.rebind(DEFAULT_HOTKEYS.PTT_HOLD).ok).toBe(true);
    expect(hotkeys.isRegistered(DEFAULT_HOTKEYS.PTT_HOLD)).toBe(true);
  });

  it('hintFor maps the display name without changing the binding', () => {
    const { hints, ptt } = rig({ hintFor: (a) => a.replace('CommandOrControl', 'Ctrl') });
    ptt.register();
    expect(hints.at(-1)).toBe('Ctrl+Space to talk — or click');
    expect(ptt.effective()).toBe('CommandOrControl+Space');
  });
});
