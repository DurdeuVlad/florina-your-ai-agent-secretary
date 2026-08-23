import { describe, it, expect, vi } from 'vitest';

import { VoiceSessionState } from '../src/voice/audio-types.js';
import type { VoicePipelineState } from '../src/voice/voice-pipeline.js';
import {
  PttHudViewModel,
  DEFAULT_PTT_HUD_STATE,
} from '../src/desktop/views/ptt-hud.js';
import type { PttHudState } from '../src/desktop/views/ptt-hud.js';
import {
  renderPttHud,
  renderPttButton,
  renderTranscriptPreview,
  renderVoiceModeIndicator,
  renderHotkeyHint,
  renderResponsePreview,
} from '../src/desktop/views/ptt-templates.js';
import type { RenderTree } from '../src/desktop/views/view-types.js';
import {
  HotkeyManager,
  MockKeyboardBackend,
  DEFAULT_HOTKEYS,
  parseAccelerator,
} from '../src/desktop/hotkeys.js';
import type { KeyEventLike, ParsedAccelerator } from '../src/desktop/hotkeys.js';

/* ------------------------------------------------------------------ *
 * Test helpers
 * ------------------------------------------------------------------ */

/** Build a VoicePipelineState with overrides. */
function pipelineState(
  overrides: Partial<VoicePipelineState> = {},
): VoicePipelineState {
  return {
    mode: 'realtime',
    realtimeState: VoiceSessionState.Idle,
    realtimeConnected: true,
    whisperAvailable: false,
    ...overrides,
  };
}

/** Deep clone via JSON to confirm serializability. */
function jsonRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/* ------------------------------------------------------------------ *
 * PttHudViewModel — state updates
 * ------------------------------------------------------------------ */

describe('PttHudViewModel.update', () => {
  it('derives listening flag from realtime Listening state', () => {
    const vm = new PttHudViewModel();
    const state = vm.update(
      pipelineState({ mode: 'realtime', realtimeState: VoiceSessionState.Listening }),
    );
    expect(state.isListening).toBe(true);
    expect(state.isProcessing).toBe(false);
    expect(state.isResponding).toBe(false);
    expect(state.voiceMode).toBe('realtime');
  });

  it('derives processing flag from realtime Processing state', () => {
    const vm = new PttHudViewModel();
    const state = vm.update(
      pipelineState({ mode: 'realtime', realtimeState: VoiceSessionState.Processing }),
    );
    expect(state.isProcessing).toBe(true);
    expect(state.isListening).toBe(false);
  });

  it('derives responding flag from realtime Responding state', () => {
    const vm = new PttHudViewModel();
    const state = vm.update(
      pipelineState({ mode: 'realtime', realtimeState: VoiceSessionState.Responding }),
    );
    expect(state.isResponding).toBe(true);
    expect(state.isListening).toBe(false);
    expect(state.isProcessing).toBe(false);
  });

  it('clears all activity flags when offline', () => {
    const vm = new PttHudViewModel();
    vm.update(
      pipelineState({ mode: 'realtime', realtimeState: VoiceSessionState.Listening }),
    );
    const state = vm.update(pipelineState({ mode: 'offline' }));
    expect(state.isListening).toBe(false);
    expect(state.isProcessing).toBe(false);
    expect(state.isResponding).toBe(false);
    expect(state.voiceMode).toBe('offline');
  });

  it('surfaces listening in whisper mode when bridge is idle', () => {
    const vm = new PttHudViewModel();
    const state = vm.update(
      pipelineState({
        mode: 'whisper',
        realtimeState: VoiceSessionState.Idle,
        realtimeConnected: false,
        whisperAvailable: true,
      }),
    );
    expect(state.voiceMode).toBe('whisper');
    expect(state.isListening).toBe(true);
    expect(state.isProcessing).toBe(false);
  });

  it('surfaces processing in whisper mode when bridge is Processing', () => {
    const vm = new PttHudViewModel();
    const state = vm.update(
      pipelineState({
        mode: 'whisper',
        realtimeState: VoiceSessionState.Processing,
      }),
    );
    expect(state.isProcessing).toBe(true);
    expect(state.isListening).toBe(false);
  });

  it('preserves transcript, response preview, and hotkey hint across update', () => {
    const vm = new PttHudViewModel();
    vm.setTranscript('hello world');
    vm.setResponsePreview('okay');
    vm.setHotkeyHint('Hold ⌘␣');
    const state = vm.update(
      pipelineState({ mode: 'realtime', realtimeState: VoiceSessionState.Listening }),
    );
    expect(state.currentTranscript).toBe('hello world');
    expect(state.responsePreview).toBe('okay');
    expect(state.hotkeyHint).toBe('Hold ⌘␣');
  });

  it('Idle realtime state yields no activity flags', () => {
    const vm = new PttHudViewModel();
    const state = vm.update(
      pipelineState({ mode: 'realtime', realtimeState: VoiceSessionState.Idle }),
    );
    expect(state.isListening).toBe(false);
    expect(state.isProcessing).toBe(false);
    expect(state.isResponding).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * PttHudViewModel — state change notifications
 * ------------------------------------------------------------------ */

describe('PttHudViewModel.onStateChange', () => {
  it('notifies subscribers on update when state changes', () => {
    const vm = new PttHudViewModel();
    const cb = vi.fn();
    vm.onStateChange(cb);
    vm.update(
      pipelineState({ mode: 'realtime', realtimeState: VoiceSessionState.Listening }),
    );
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0].isListening).toBe(true);
  });

  it('does not notify when state is unchanged', () => {
    const vm = new PttHudViewModel();
    vm.update(
      pipelineState({ mode: 'realtime', realtimeState: VoiceSessionState.Listening }),
    );
    const cb = vi.fn();
    vm.onStateChange(cb);
    // Same state as current — no change.
    vm.update(
      pipelineState({ mode: 'realtime', realtimeState: VoiceSessionState.Listening }),
    );
    expect(cb).not.toHaveBeenCalled();
  });

  it('notifies on setTranscript / setResponsePreview / setHotkeyHint', () => {
    const vm = new PttHudViewModel();
    const cb = vi.fn();
    vm.onStateChange(cb);
    vm.setTranscript('hi');
    vm.setResponsePreview('yo');
    vm.setHotkeyHint('hint');
    expect(cb).toHaveBeenCalledTimes(3);
  });

  it('unsubscribe stops further notifications', () => {
    const vm = new PttHudViewModel();
    const cb = vi.fn();
    const unsub = vm.onStateChange(cb);
    vm.setTranscript('a');
    unsub();
    vm.setTranscript('b');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('getState returns a copy that does not mutate internal state', () => {
    const vm = new PttHudViewModel();
    vm.setTranscript('original');
    const snap = vm.getState();
    (snap as unknown as { currentTranscript: string }).currentTranscript = 'mutated';
    expect(vm.getState().currentTranscript).toBe('original');
  });

  it('reset returns to DEFAULT_PTT_HUD_STATE and notifies', () => {
    const vm = new PttHudViewModel();
    vm.setTranscript('abc');
    const cb = vi.fn();
    vm.onStateChange(cb);
    const state = vm.reset();
    expect(state).toEqual(DEFAULT_PTT_HUD_STATE);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('a throwing subscriber does not break other subscribers', () => {
    const vm = new PttHudViewModel();
    const good = vi.fn();
    vm.onStateChange(() => {
      throw new Error('boom');
    });
    vm.onStateChange(good);
    vm.setTranscript('x');
    expect(good).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------ *
 * PttHudViewModel — JSON serializability
 * ------------------------------------------------------------------ */

describe('PttHudViewModel serialization', () => {
  it('getState is JSON-serializable (round-trips cleanly)', () => {
    const vm = new PttHudViewModel();
    vm.update(
      pipelineState({ mode: 'realtime', realtimeState: VoiceSessionState.Listening }),
    );
    vm.setTranscript('hello');
    vm.setResponsePreview('world');
    vm.setHotkeyHint('⌘␣');
    const state = vm.getState();
    const round = jsonRoundTrip(state);
    expect(round).toEqual(state);
  });
});

/* ------------------------------------------------------------------ *
 * PTT templates
 * ------------------------------------------------------------------ */

describe('PTT templates', () => {
  const listeningState: PttHudState = {
    isListening: true,
    isProcessing: false,
    isResponding: false,
    voiceMode: 'realtime',
    currentTranscript: 'how many tasks',
    responsePreview: '',
    hotkeyHint: 'Hold ⌘␣ to talk',
  };

  describe('renderPttHud', () => {
    it('produces a PttHud overlay container with alwaysOnTop', () => {
      const tree = renderPttHud(listeningState);
      expect(tree.tag).toBe('PttHud');
      expect(tree.props?.alwaysOnTop).toBe(true);
      expect(tree.props?.overlay).toBe(true);
    });

    it('uses green color when listening', () => {
      const tree = renderPttHud(listeningState);
      expect(tree.props?.color).toBe('green');
      expect(tree.props?.activeState).toBe('listening');
    });

    it('uses yellow color when processing', () => {
      const tree = renderPttHud({
        ...listeningState,
        isListening: false,
        isProcessing: true,
      });
      expect(tree.props?.color).toBe('yellow');
      expect(tree.props?.activeState).toBe('processing');
    });

    it('uses blue color when responding', () => {
      const tree = renderPttHud({
        ...listeningState,
        isListening: false,
        isResponding: true,
      });
      expect(tree.props?.color).toBe('blue');
      expect(tree.props?.activeState).toBe('responding');
    });

    it('uses gray color when offline', () => {
      const tree = renderPttHud({
        ...listeningState,
        voiceMode: 'offline',
        isListening: false,
      });
      expect(tree.props?.color).toBe('gray');
      expect(tree.props?.activeState).toBe('offline');
    });

    it('includes transcript, response preview, and hint children when present', () => {
      const tree = renderPttHud({
        ...listeningState,
        responsePreview: 'three tasks',
      });
      const tags = (tree.children ?? []).map((c) =>
        typeof c === 'string' ? c : c.tag,
      );
      expect(tags).toContain('PttButton');
      expect(tags).toContain('VoiceModeIndicator');
      expect(tags).toContain('TranscriptPreview');
      expect(tags).toContain('ResponsePreview');
      expect(tags).toContain('HotkeyHint');
    });

    it('omits transcript / response / hint children when empty', () => {
      const tree = renderPttHud(DEFAULT_PTT_HUD_STATE);
      const tags = (tree.children ?? []).map((c) =>
        typeof c === 'string' ? c : c.tag,
      );
      expect(tags).not.toContain('TranscriptPreview');
      expect(tags).not.toContain('ResponsePreview');
      expect(tags).not.toContain('HotkeyHint');
    });

    it('produces a JSON-serializable RenderTree', () => {
      const tree = renderPttHud(listeningState);
      expect(() => jsonRoundTrip(tree)).not.toThrow();
      expect(jsonRoundTrip(tree)).toEqual(tree);
    });
  });

  describe('renderPttButton', () => {
    it('renders an active button with the listening color when listening', () => {
      const tree = renderPttButton(listeningState);
      expect(tree.tag).toBe('PttButton');
      expect(tree.props?.active).toBe(true);
      expect(tree.props?.color).toBe('green');
      expect(tree.props?.command).toBe('ptt:toggle');
    });

    it('renders an inactive button when idle', () => {
      const tree = renderPttButton(DEFAULT_PTT_HUD_STATE);
      expect(tree.props?.active).toBe(false);
      expect(tree.props?.color).toBe('gray');
      expect(tree.props?.icon).toBe('mic');
    });

    it('uses the spinner icon when processing', () => {
      const tree = renderPttButton({
        ...listeningState,
        isListening: false,
        isProcessing: true,
      });
      expect(tree.props?.icon).toBe('spinner');
    });

    it('uses the speaker icon when responding', () => {
      const tree = renderPttButton({
        ...listeningState,
        isListening: false,
        isResponding: true,
      });
      expect(tree.props?.icon).toBe('speaker');
    });
  });

  describe('renderTranscriptPreview', () => {
    it('renders a TranscriptPreview with the given text', () => {
      const tree = renderTranscriptPreview('how many tasks');
      expect(tree.tag).toBe('TranscriptPreview');
      expect(tree.children).toEqual(['how many tasks']);
    });

    it('is JSON-serializable', () => {
      const tree = renderTranscriptPreview('abc');
      expect(jsonRoundTrip(tree)).toEqual(tree);
    });
  });

  describe('renderVoiceModeIndicator', () => {
    it('renders realtime mode with blue color and bolt icon', () => {
      const tree = renderVoiceModeIndicator('realtime');
      expect(tree.tag).toBe('VoiceModeIndicator');
      expect(tree.props?.mode).toBe('realtime');
      expect(tree.props?.color).toBe('blue');
      expect(tree.props?.icon).toBe('bolt');
      expect(tree.children).toEqual(['Realtime']);
    });

    it('renders whisper mode with amber color', () => {
      const tree = renderVoiceModeIndicator('whisper');
      expect(tree.props?.color).toBe('amber');
      expect(tree.children).toEqual(['Whisper']);
    });

    it('renders offline mode with gray color', () => {
      const tree = renderVoiceModeIndicator('offline');
      expect(tree.props?.color).toBe('gray');
      expect(tree.children).toEqual(['Offline']);
    });
  });

  describe('renderHotkeyHint', () => {
    it('renders a HotkeyHint with the given text', () => {
      const tree = renderHotkeyHint('Hold ⌘␣ to talk');
      expect(tree.tag).toBe('HotkeyHint');
      expect(tree.children).toEqual(['Hold ⌘␣ to talk']);
    });
  });

  describe('renderResponsePreview', () => {
    it('renders a ResponsePreview with the given text', () => {
      const tree = renderResponsePreview('three tasks');
      expect(tree.tag).toBe('ResponsePreview');
      expect(tree.children).toEqual(['three tasks']);
    });
  });
});

/* ------------------------------------------------------------------ *
 * Accelerator parsing
 * ------------------------------------------------------------------ */

describe('parseAccelerator', () => {
  it('parses CommandOrControl+Shift+Space', () => {
    const p = parseAccelerator('CommandOrControl+Shift+Space');
    expect(p.commandOrControl).toBe(true);
    expect(p.shift).toBe(true);
    expect(p.ctrl).toBe(false);
    expect(p.meta).toBe(false);
    expect(p.alt).toBe(false);
    expect(p.key).toBe('space');
    expect(p.raw).toBe('CommandOrControl+Shift+Space');
  });

  it('parses CommandOrControl+Space', () => {
    const p = parseAccelerator('CommandOrControl+Space');
    expect(p.commandOrControl).toBe(true);
    expect(p.shift).toBe(false);
    expect(p.key).toBe('space');
  });

  it('parses Alt+P', () => {
    const p = parseAccelerator('Alt+P');
    expect(p.alt).toBe(true);
    expect(p.commandOrControl).toBe(false);
    expect(p.key).toBe('p');
  });

  it('parses CmdOrCtrl alias as commandOrControl', () => {
    const p = parseAccelerator('CmdOrCtrl+Y');
    expect(p.commandOrControl).toBe(true);
    expect(p.key).toBe('y');
  });

  it('parses Control+Shift+N with explicit ctrl', () => {
    const p = parseAccelerator('Control+Shift+N');
    expect(p.ctrl).toBe(true);
    expect(p.commandOrControl).toBe(false);
    expect(p.shift).toBe(true);
    expect(p.key).toBe('n');
  });

  it('parses Command+E (meta) alias', () => {
    const p = parseAccelerator('Command+E');
    expect(p.meta).toBe(true);
    expect(p.commandOrControl).toBe(false);
    expect(p.key).toBe('e');
  });

  it('parses a single-token accelerator with no modifiers', () => {
    const p = parseAccelerator('Escape');
    expect(p.key).toBe('escape');
    expect(p.commandOrControl).toBe(false);
    expect(p.shift).toBe(false);
  });

  it('normalizes Enter / Return / Esc aliases', () => {
    expect(parseAccelerator('Enter').key).toBe('enter');
    expect(parseAccelerator('Return').key).toBe('enter');
    expect(parseAccelerator('Esc').key).toBe('escape');
  });

  it('is JSON-serializable', () => {
    const p: ParsedAccelerator = parseAccelerator('CommandOrControl+Shift+Space');
    expect(jsonRoundTrip(p)).toEqual(p);
  });
});

/* ------------------------------------------------------------------ *
 * HotkeyManager — register / unregister / match
 * ------------------------------------------------------------------ */

describe('HotkeyManager', () => {
  describe('register / unregister', () => {
    it('registers an accelerator with the backend and stores the callback', () => {
      const backend = new MockKeyboardBackend();
      const mgr = new HotkeyManager(backend);
      const cb = vi.fn();
      expect(mgr.register('Alt+P', cb)).toBe(true);
      expect(backend.registered.has('Alt+p')).toBe(true);
      expect(mgr.isRegistered('Alt+P')).toBe(true);
    });

    it('dispatch fires the registered callback', () => {
      const mgr = new HotkeyManager();
      const cb = vi.fn();
      mgr.register('Alt+P', cb);
      expect(mgr.dispatch('Alt+P')).toBe(true);
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('dispatch returns false for an unregistered accelerator', () => {
      const mgr = new HotkeyManager();
      expect(mgr.dispatch('Alt+P')).toBe(false);
    });

    it('unregister removes the callback and backend registration', () => {
      const backend = new MockKeyboardBackend();
      const mgr = new HotkeyManager(backend);
      const cb = vi.fn();
      mgr.register('Alt+P', cb);
      mgr.unregister('Alt+P');
      expect(mgr.isRegistered('Alt+P')).toBe(false);
      expect(backend.registered.has('Alt+p')).toBe(false);
      expect(mgr.dispatch('Alt+P')).toBe(false);
    });

    it('unregister is a no-op for an unregistered accelerator', () => {
      const mgr = new HotkeyManager();
      expect(() => mgr.unregister('Alt+P')).not.toThrow();
    });

    it('unregisterAll clears everything', () => {
      const backend = new MockKeyboardBackend();
      const mgr = new HotkeyManager(backend);
      mgr.register('Alt+P', () => {});
      mgr.register('Alt+Q', () => {});
      mgr.unregisterAll();
      expect(mgr.registeredAccelerators).toEqual([]);
      expect(backend.registered.size).toBe(0);
    });

    it('re-registering replaces the callback', () => {
      const mgr = new HotkeyManager();
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      mgr.register('Alt+P', cb1);
      mgr.register('Alt+P', cb2);
      mgr.dispatch('Alt+P');
      expect(cb1).not.toHaveBeenCalled();
      expect(cb2).toHaveBeenCalledTimes(1);
    });

    it('canonicalizes equivalent accelerators (CmdOrCtrl vs CommandOrControl)', () => {
      const mgr = new HotkeyManager();
      const cb = vi.fn();
      mgr.register('CommandOrControl+Space', cb);
      // Dispatching the alias form should fire the same callback.
      expect(mgr.dispatch('CmdOrCtrl+Space')).toBe(true);
      expect(cb).toHaveBeenCalledTimes(1);
    });
  });

  describe('match / findMatch / dispatchEvent', () => {
    it('matches a CommandOrControl+Space event with ctrl held', () => {
      const mgr = new HotkeyManager();
      const cb = vi.fn();
      mgr.register('CommandOrControl+Space', cb);
      const event: KeyEventLike = { key: ' ', ctrlKey: true };
      expect(mgr.match(event)).toBe(true);
      expect(mgr.findMatch(event)).toBe('CommandOrControl+space');
    });

    it('matches a CommandOrControl+Space event with meta held (macOS)', () => {
      const mgr = new HotkeyManager();
      mgr.register('CommandOrControl+Space', () => {});
      const event: KeyEventLike = { key: ' ', metaKey: true };
      expect(mgr.match(event)).toBe(true);
    });

    it('does not match when neither ctrl nor meta is held for CommandOrControl', () => {
      const mgr = new HotkeyManager();
      mgr.register('CommandOrControl+Space', () => {});
      const event: KeyEventLike = { key: ' ' };
      expect(mgr.match(event)).toBe(false);
    });

    it('matches CommandOrControl+Shift+Space with ctrl+shift', () => {
      const mgr = new HotkeyManager();
      const cb = vi.fn();
      mgr.register('CommandOrControl+Shift+Space', cb);
      const event: KeyEventLike = { key: ' ', ctrlKey: true, shiftKey: true };
      expect(mgr.dispatchEvent(event)).toBe(true);
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('does not match CommandOrControl+Shift+Space without shift', () => {
      const mgr = new HotkeyManager();
      mgr.register('CommandOrControl+Shift+Space', () => {});
      const event: KeyEventLike = { key: ' ', ctrlKey: true };
      expect(mgr.match(event)).toBe(false);
    });

    it('matches Alt+P', () => {
      const mgr = new HotkeyManager();
      const cb = vi.fn();
      mgr.register('Alt+P', cb);
      const event: KeyEventLike = { key: 'p', altKey: true };
      expect(mgr.dispatchEvent(event)).toBe(true);
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('explicit Control does not match meta alone', () => {
      const mgr = new HotkeyManager();
      mgr.register('Control+Y', () => {});
      const event: KeyEventLike = { key: 'y', metaKey: true };
      expect(mgr.match(event)).toBe(false);
    });

    it('explicit Control matches ctrl', () => {
      const mgr = new HotkeyManager();
      mgr.register('Control+Y', () => {});
      const event: KeyEventLike = { key: 'y', ctrlKey: true };
      expect(mgr.match(event)).toBe(true);
    });

    it('returns false when no accelerator matches', () => {
      const mgr = new HotkeyManager();
      mgr.register('Alt+P', () => {});
      const event: KeyEventLike = { key: 'q', altKey: true };
      expect(mgr.match(event)).toBe(false);
      expect(mgr.dispatchEvent(event)).toBe(false);
    });

    it('matches case-insensitively on the key', () => {
      const mgr = new HotkeyManager();
      mgr.register('CommandOrControl+Y', () => {});
      const event: KeyEventLike = { key: 'Y', ctrlKey: true };
      expect(mgr.match(event)).toBe(true);
    });
  });

  describe('registerDefaults', () => {
    it('registers all supplied default hotkeys', () => {
      const mgr = new HotkeyManager();
      const cbs = {
        PTT_HOLD: vi.fn(),
        PTT_TOGGLE: vi.fn(),
        APPROVE: vi.fn(),
        DENY: vi.fn(),
        INBOX: vi.fn(),
        ESCALATE: vi.fn(),
      };
      const registered = mgr.registerDefaults(cbs);
      expect(registered.has('PTT_HOLD')).toBe(true);
      expect(registered.has('PTT_TOGGLE')).toBe(true);
      expect(registered.has('APPROVE')).toBe(true);
      expect(registered.has('DENY')).toBe(true);
      expect(registered.has('INBOX')).toBe(true);
      expect(registered.has('ESCALATE')).toBe(true);
      expect(mgr.registeredAccelerators.length).toBe(6);
    });

    it('skips actions with no supplied callback', () => {
      const mgr = new HotkeyManager();
      const registered = mgr.registerDefaults({ APPROVE: vi.fn() });
      expect(registered.has('APPROVE')).toBe(true);
      expect(registered.has('PTT_HOLD')).toBe(false);
      expect(mgr.registeredAccelerators.length).toBe(1);
    });

    it('default APPROVE hotkey fires on CommandOrControl+Y', () => {
      const mgr = new HotkeyManager();
      const cb = vi.fn();
      mgr.registerDefaults({ APPROVE: cb });
      mgr.dispatchEvent({ key: 'y', ctrlKey: true });
      expect(cb).toHaveBeenCalledTimes(1);
    });
  });
});

/* ------------------------------------------------------------------ *
 * Default hotkeys
 * ------------------------------------------------------------------ */

describe('DEFAULT_HOTKEYS', () => {
  it('defines the six required default hotkeys', () => {
    expect(DEFAULT_HOTKEYS.PTT_HOLD).toBe('CommandOrControl+Space');
    expect(DEFAULT_HOTKEYS.PTT_TOGGLE).toBe('CommandOrControl+Shift+Space');
    expect(DEFAULT_HOTKEYS.APPROVE).toBe('CommandOrControl+Y');
    expect(DEFAULT_HOTKEYS.DENY).toBe('CommandOrControl+N');
    expect(DEFAULT_HOTKEYS.INBOX).toBe('CommandOrControl+I');
    expect(DEFAULT_HOTKEYS.ESCALATE).toBe('CommandOrControl+E');
  });

  it('each default accelerator parses without error', () => {
    for (const accel of Object.values(DEFAULT_HOTKEYS)) {
      expect(() => parseAccelerator(accel)).not.toThrow();
    }
  });
});

/* ------------------------------------------------------------------ *
 * MockKeyboardBackend
 * ------------------------------------------------------------------ */

describe('MockKeyboardBackend', () => {
  it('register adds to the registered set and returns true', () => {
    const backend = new MockKeyboardBackend();
    expect(backend.register('Alt+P')).toBe(true);
    expect(backend.registered.has('Alt+P')).toBe(true);
  });

  it('register returns false for a duplicate', () => {
    const backend = new MockKeyboardBackend();
    backend.register('Alt+P');
    expect(backend.register('Alt+P')).toBe(false);
  });

  it('unregister removes from the registered set', () => {
    const backend = new MockKeyboardBackend();
    backend.register('Alt+P');
    backend.unregister('Alt+P');
    expect(backend.registered.has('Alt+P')).toBe(false);
  });

  it('unregisterAll clears the set', () => {
    const backend = new MockKeyboardBackend();
    backend.register('Alt+P');
    backend.register('Alt+Q');
    backend.unregisterAll();
    expect(backend.registered.size).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Serialization — RenderTree & HUD state
 * ------------------------------------------------------------------ */

describe('serialization', () => {
  it('RenderTree from renderPttHud has no function values in props', () => {
    const state: PttHudState = {
      isListening: true,
      isProcessing: false,
      isResponding: false,
      voiceMode: 'realtime',
      currentTranscript: 'hi',
      responsePreview: 'bye',
      hotkeyHint: '⌘␣',
    };
    const tree: RenderTree = renderPttHud(state);
    const round = jsonRoundTrip(tree);
    expect(round).toEqual(tree);
  });

  it('all template functions produce JSON-serializable trees', () => {
    const trees: RenderTree[] = [
      renderPttButton(DEFAULT_PTT_HUD_STATE),
      renderTranscriptPreview('text'),
      renderVoiceModeIndicator('realtime'),
      renderVoiceModeIndicator('whisper'),
      renderVoiceModeIndicator('offline'),
      renderHotkeyHint('hint'),
      renderResponsePreview('resp'),
    ];
    for (const t of trees) {
      expect(jsonRoundTrip(t)).toEqual(t);
    }
  });
});
