import { describe, it, expect } from 'vitest';

import { HudController, MockIpcTransport, MockWindowBackend } from '../src/desktop/index.js';
import type { RendererStateData } from '../src/desktop/index.js';
import { DEFAULT_RENDERER_STATE } from '../src/desktop/index.js';
import type { PttHudState } from '../src/desktop/index.js';

function makeState(patch: Partial<RendererStateData>): RendererStateData {
  return {
    ...DEFAULT_RENDERER_STATE,
    voiceState: { listening: false, speaking: false, muted: false, processing: false },
    ...patch,
  };
}

function lastHudPush(transport: MockIpcTransport): PttHudState | undefined {
  const msgs = transport.toRenderer.filter((m) => m.channel === 'hud:state');
  return msgs.length > 0 ? (msgs[msgs.length - 1].data as PttHudState) : undefined;
}

describe('HudController (issue #123)', () => {
  it('creates a frameless, always-on-top, transparent 380px overlay', () => {
    const window = new MockWindowBackend();
    const hud = new HudController({ window, ipc: new MockIpcTransport() });
    hud.start();
    const opts = window.windowOptions;
    expect(opts.width).toBe(380);
    expect(opts.frame).toBe(false);
    expect(opts.transparent).toBe(true);
    expect(opts.alwaysOnTop).toBe(true);
    expect(opts.resizable).toBe(false);
    expect(opts.skipTaskbar).toBe(true);
    expect(window.isVisible()).toBe(true);
  });

  it('pushes the initial state to the HUD window on start', () => {
    const transport = new MockIpcTransport();
    const hud = new HudController({ window: new MockWindowBackend(), ipc: transport });
    hud.start();
    const pushed = lastHudPush(transport);
    expect(pushed).toBeDefined();
    expect(pushed!.voiceMode).toBe('offline');
    expect(pushed!.isListening).toBe(false);
  });

  it('maps a disconnected daemon to the offline HUD state', () => {
    const transport = new MockIpcTransport();
    const hud = new HudController({ window: new MockWindowBackend(), ipc: transport });
    hud.start();
    hud.applyRendererState(makeState({ daemonStatus: 'connected' }));
    transport.toRenderer.length = 0;
    hud.applyRendererState(makeState({ daemonStatus: 'disconnected' }));
    expect(lastHudPush(transport)!.voiceMode).toBe('offline');
  });

  it('maps voice listening / responding flags to HUD activity states', () => {
    const transport = new MockIpcTransport();
    const hud = new HudController({ window: new MockWindowBackend(), ipc: transport });
    hud.start();
    hud.applyRendererState(
      makeState({
        daemonStatus: 'connected',
        voiceState: { listening: true, speaking: false, muted: false, processing: false },
      }),
    );
    let pushed = lastHudPush(transport)!;
    expect(pushed.isListening).toBe(true);
    expect(pushed.voiceMode).toBe('realtime');

    hud.applyRendererState(
      makeState({
        daemonStatus: 'connected',
        voiceState: { listening: false, speaking: true, muted: false, processing: false },
      }),
    );
    pushed = lastHudPush(transport)!;
    expect(pushed.isResponding).toBe(true);
    expect(pushed.isListening).toBe(false);
  });

  it('connected daemon with no voice activity maps to idle (realtime, no flags)', () => {
    const transport = new MockIpcTransport();
    const hud = new HudController({ window: new MockWindowBackend(), ipc: transport });
    hud.start();
    hud.applyRendererState(makeState({ daemonStatus: 'connected' }));
    const pushed = lastHudPush(transport)!;
    expect(pushed.voiceMode).toBe('realtime');
    expect(pushed.isListening).toBe(false);
    expect(pushed.isProcessing).toBe(false);
    expect(pushed.isResponding).toBe(false);
  });

  it('streams transcripts and response previews into the HUD state', () => {
    const transport = new MockIpcTransport();
    const hud = new HudController({ window: new MockWindowBackend(), ipc: transport });
    hud.start();
    hud.setTranscript('approve network access for…');
    expect(lastHudPush(transport)!.currentTranscript).toBe('approve network access for…');
    hud.setResponsePreview('Approved network, this task only.');
    expect(lastHudPush(transport)!.responsePreview).toBe('Approved network, this task only.');
  });

  it('does not re-push when the state is unchanged', () => {
    const transport = new MockIpcTransport();
    const hud = new HudController({ window: new MockWindowBackend(), ipc: transport });
    hud.start();
    const same = makeState({ daemonStatus: 'connected' });
    hud.applyRendererState(same);
    const n = transport.toRenderer.length;
    hud.applyRendererState(same);
    hud.applyRendererState(same);
    expect(transport.toRenderer.length).toBe(n);
  });

  it('stop closes the overlay window', () => {
    const window = new MockWindowBackend();
    const hud = new HudController({ window, ipc: new MockIpcTransport() });
    hud.start();
    hud.stop();
    expect(window.isClosed()).toBe(true);
  });
});

describe('HudController local PTT (issue #124)', () => {
  it('toggleLocalListening flips the HUD into listening while connected', () => {
    const transport = new MockIpcTransport();
    const hud = new HudController({ window: new MockWindowBackend(), ipc: transport });
    hud.start();
    hud.applyRendererState(makeState({ daemonStatus: 'connected' }));
    expect(hud.toggleLocalListening()).toBe(true);
    expect(lastHudPush(transport)!.isListening).toBe(true);
    expect(hud.toggleLocalListening()).toBe(false);
    expect(lastHudPush(transport)!.isListening).toBe(false);
  });

  it('a dropped daemon clears local listening instead of resurfacing on reconnect', () => {
    const transport = new MockIpcTransport();
    const hud = new HudController({ window: new MockWindowBackend(), ipc: transport });
    hud.start();
    hud.applyRendererState(makeState({ daemonStatus: 'connected' }));
    hud.toggleLocalListening();
    expect(hud.isLocallyListening).toBe(true);
    hud.applyRendererState(makeState({ daemonStatus: 'disconnected' }));
    expect(hud.isLocallyListening).toBe(false);
    expect(lastHudPush(transport)!.voiceMode).toBe('offline');
    hud.applyRendererState(makeState({ daemonStatus: 'connected' }));
    expect(lastHudPush(transport)!.isListening).toBe(false);
  });

  it('cannot listen while the daemon is offline', () => {
    const transport = new MockIpcTransport();
    const hud = new HudController({ window: new MockWindowBackend(), ipc: transport });
    hud.start();
    hud.applyRendererState(makeState({ daemonStatus: 'disconnected' }));
    hud.toggleLocalListening();
    expect(lastHudPush(transport)!.isListening).toBe(false);
    expect(lastHudPush(transport)!.voiceMode).toBe('offline');
  });

  it('inline mode (no window) pushes hud:state without creating a window', () => {
    const transport = new MockIpcTransport();
    const hud = new HudController({ ipc: transport });
    hud.start();
    // No window was created — state pushes still flow over the transport.
    hud.applyRendererState(makeState({ daemonStatus: 'connected' }));
    hud.toggleLocalListening();
    const pushed = lastHudPush(transport);
    expect(pushed).toBeDefined();
    expect(pushed!.isListening).toBe(true);
    hud.stop();
  });
});

describe('HudController voice pipeline mapping (issue #131)', () => {
  function makeHud() {
    const transport = new MockIpcTransport();
    const hud = new HudController({ window: new MockWindowBackend(), ipc: transport });
    hud.start();
    return { transport, hud };
  }

  it('maps processing to the processing HUD activity state', () => {
    const { transport, hud } = makeHud();
    hud.applyRendererState(
      makeState({
        daemonStatus: 'connected',
        voiceState: { listening: false, speaking: false, muted: false, processing: true },
      }),
    );
    const pushed = lastHudPush(transport)!;
    expect(pushed.isProcessing).toBe(true);
    expect(pushed.isListening).toBe(false);
    expect(pushed.isResponding).toBe(false);
  });

  it('listening beats processing beats responding; offline beats all', () => {
    const { transport, hud } = makeHud();
    hud.applyRendererState(
      makeState({
        daemonStatus: 'connected',
        voiceState: {
          listening: true,
          speaking: true,
          muted: false,
          processing: true,
        },
      }),
    );
    expect(lastHudPush(transport)!.isListening).toBe(true);

    hud.applyRendererState(
      makeState({
        daemonStatus: 'connected',
        voiceState: { listening: false, speaking: true, muted: false, processing: true },
      }),
    );
    expect(lastHudPush(transport)!.isProcessing).toBe(true);

    hud.applyRendererState(
      makeState({
        daemonStatus: 'disconnected',
        voiceState: { listening: false, speaking: true, muted: false, processing: true },
      }),
    );
    expect(lastHudPush(transport)!.voiceMode).toBe('offline');
  });

  it('maps whisper mode and partial/final transcripts into the two-line area', () => {
    const { transport, hud } = makeHud();
    hud.applyRendererState(
      makeState({
        daemonStatus: 'connected',
        voiceState: {
          listening: true,
          speaking: false,
          muted: false,
          processing: false,
          mode: 'whisper',
          transcript: 'par',
        },
      }),
    );
    let pushed = lastHudPush(transport)!;
    expect(pushed.voiceMode).toBe('whisper');
    expect(pushed.currentTranscript).toBe('par');

    hud.applyRendererState(
      makeState({
        daemonStatus: 'connected',
        voiceState: {
          listening: false,
          speaking: false,
          muted: false,
          processing: false,
          mode: 'whisper',
          transcript: 'partial final',
          responsePreview: 'Acknowledged.',
        },
      }),
    );
    pushed = lastHudPush(transport)!;
    expect(pushed.currentTranscript).toBe('partial final');
    expect(pushed.responsePreview).toBe('Acknowledged.');
  });
});
