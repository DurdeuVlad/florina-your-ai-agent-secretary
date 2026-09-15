/**
 * Voice-mode full-window overlay (issue #182): a distinct, larger takeover
 * surface from the small PTT HUD pill, driven by the SAME PttHudViewModel
 * (single source of truth) rather than a second state machine.
 */
import { describe, it, expect } from 'vitest';

import { VoiceOverlayController } from '../src/adapters/inbound/desktop/voice-overlay-controller.js';
import { MockWindowBackend } from '../src/adapters/inbound/desktop/window-backend.js';
import { MockIpcTransport } from '../src/adapters/inbound/desktop/ipc-bridge.js';
import { PttHudViewModel } from '../src/adapters/inbound/desktop/views/ptt-hud.js';
import { VoiceSessionState } from '../src/core/application/ports/outbound/voice.js';
import type { PttHudState } from '../src/adapters/inbound/desktop/views/ptt-hud.js';

function lastHudPush(transport: MockIpcTransport): PttHudState | undefined {
  const msgs = transport.toRenderer.filter((m) => m.channel === 'hud:state');
  return msgs.length > 0 ? (msgs[msgs.length - 1].data as PttHudState) : undefined;
}

describe('VoiceOverlayController (issue #182)', () => {
  it('is not visible and creates no window until shown', () => {
    const window = new MockWindowBackend();
    const overlay = new VoiceOverlayController({
      window,
      ipc: new MockIpcTransport(),
      viewModel: new PttHudViewModel(),
    });
    expect(overlay.isVisible).toBe(false);
    expect(window.log).toEqual([]);
  });

  it('creates a frameless, always-on-top, transparent, larger-than-HUD window on first show', () => {
    const window = new MockWindowBackend();
    const overlay = new VoiceOverlayController({
      window,
      ipc: new MockIpcTransport(),
      viewModel: new PttHudViewModel(),
    });
    overlay.show();
    const opts = window.windowOptions;
    expect(opts.width).toBe(480);
    expect(opts.height).toBe(480);
    expect(opts.frame).toBe(false);
    expect(opts.transparent).toBe(true);
    expect(opts.alwaysOnTop).toBe(true);
    expect(opts.skipTaskbar).toBe(true);
    expect(window.isVisible()).toBe(true);
    expect(overlay.isVisible).toBe(true);
  });

  it('pushes the current view-model state to the overlay on show', () => {
    const transport = new MockIpcTransport();
    const vm = new PttHudViewModel();
    vm.update({
      mode: 'realtime',
      realtimeState: VoiceSessionState.Listening,
      realtimeConnected: true,
      whisperAvailable: false,
    });
    const overlay = new VoiceOverlayController({
      window: new MockWindowBackend(),
      ipc: transport,
      viewModel: vm,
    });
    overlay.show();
    expect(lastHudPush(transport)!.isListening).toBe(true);
  });

  it('mirrors later state transitions only while visible', () => {
    const transport = new MockIpcTransport();
    const vm = new PttHudViewModel();
    const overlay = new VoiceOverlayController({
      window: new MockWindowBackend(),
      ipc: transport,
      viewModel: vm,
    });
    overlay.show();
    transport.toRenderer.length = 0;
    vm.update({
      mode: 'realtime',
      realtimeState: VoiceSessionState.Responding,
      realtimeConnected: true,
      whisperAvailable: false,
    });
    expect(lastHudPush(transport)!.isResponding).toBe(true);

    overlay.hide();
    transport.toRenderer.length = 0;
    vm.update({
      mode: 'realtime',
      realtimeState: VoiceSessionState.Idle,
      realtimeConnected: true,
      whisperAvailable: false,
    });
    expect(lastHudPush(transport)).toBeUndefined();
  });

  it('reuses the existing window on a second show instead of recreating it', () => {
    const window = new MockWindowBackend();
    const overlay = new VoiceOverlayController({
      window,
      ipc: new MockIpcTransport(),
      viewModel: new PttHudViewModel(),
    });
    overlay.show();
    overlay.hide();
    overlay.show();
    expect(window.log.filter((l) => l.startsWith('createWindow')).length).toBe(1);
  });

  it('hide() is idempotent and safe before any show()', () => {
    const overlay = new VoiceOverlayController({
      window: new MockWindowBackend(),
      ipc: new MockIpcTransport(),
      viewModel: new PttHudViewModel(),
    });
    expect(() => overlay.hide()).not.toThrow();
    expect(overlay.isVisible).toBe(false);
  });

  it('stop() closes the window only if it was ever created', () => {
    const neverShown = new MockWindowBackend();
    const overlay1 = new VoiceOverlayController({
      window: neverShown,
      ipc: new MockIpcTransport(),
      viewModel: new PttHudViewModel(),
    });
    overlay1.stop();
    expect(neverShown.log).toEqual([]);

    const shown = new MockWindowBackend();
    const overlay2 = new VoiceOverlayController({
      window: shown,
      ipc: new MockIpcTransport(),
      viewModel: new PttHudViewModel(),
    });
    overlay2.show();
    overlay2.stop();
    expect(shown.isClosed()).toBe(true);
  });
});
