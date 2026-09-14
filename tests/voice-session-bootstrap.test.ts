/**
 * createStdinVoiceSession composition (issue #162): the desktop reuses
 * the CLI's voice pipeline by injecting its IPC audio transport, a
 * prebuilt realtime bridge, and an initialized whisper adapter. This
 * file proves the injections are honored — the injected bridge is the
 * one connected, the injected transport is the one closed, and state
 * reporting flows to the injected CommandExecutor (#131 wiring is part
 * of the composition, not an add-on).
 */
import { describe, it, expect, vi } from 'vitest';

import { createStdinVoiceSession } from '../src/bootstrap/voice-session.js';
import type {
  AudioChunk,
  AudioTransport,
  RealtimeSessionOptions,
  RealtimeSessionPort,
  ToolCallEvent,
  TranscriptEvent,
  VoiceSessionState,
  VoiceStateChangeEvent,
} from '../src/core/application/ports/outbound/voice.js';
import type { Command, Response } from '../src/core/application/use-cases/tasks/command-api.js';

class StubTransport implements AudioTransport {
  captureStarted = 0;
  closed = 0;
  private cb: ((c: AudioChunk) => void) | null = null;
  startCapture(cb: (c: AudioChunk) => void): void {
    this.captureStarted += 1;
    this.cb = cb;
  }
  stopCapture(): void {
    this.cb = null;
  }
  play(): void {}
  stopPlayback(): void {}
  close(): void {
    this.closed += 1;
  }
}

class StubBridge implements RealtimeSessionPort {
  connected: Array<{ apiKey: string; options?: RealtimeSessionOptions }> = [];
  disconnected = 0;
  isConnected = false;
  currentState: VoiceSessionState = 'idle';
  listening = 0;
  stoppedListening = 0;
  private transcriptCbs = new Set<(e: TranscriptEvent) => void>();
  private stateCbs = new Set<(e: VoiceStateChangeEvent) => void>();
  private toolCbs = new Set<(e: ToolCallEvent) => void>();

  async connect(apiKey: string, options?: RealtimeSessionOptions): Promise<void> {
    this.connected.push({ apiKey, options });
    this.isConnected = true;
  }
  async disconnect(): Promise<void> {
    this.disconnected += 1;
    this.isConnected = false;
  }
  startListening(): void {
    this.listening += 1;
  }
  stopListening(): void {
    this.stoppedListening += 1;
  }
  sendToolCallOutput(): void {}
  sendUserMessage(): void {}
  onTranscript(cb: (e: TranscriptEvent) => void): () => void {
    this.transcriptCbs.add(cb);
    return () => this.transcriptCbs.delete(cb);
  }
  onStateChange(cb: (e: VoiceStateChangeEvent) => void): () => void {
    this.stateCbs.add(cb);
    return () => this.stateCbs.delete(cb);
  }
  onToolCall(cb: (e: ToolCallEvent) => void): () => void {
    this.toolCbs.add(cb);
    return () => this.toolCbs.delete(cb);
  }
  emitState(to: VoiceSessionState): void {
    const from = this.currentState;
    this.currentState = to;
    for (const cb of this.stateCbs) cb({ from, to });
  }
  emitTranscript(e: TranscriptEvent): void {
    for (const cb of this.transcriptCbs) cb(e);
  }
}

describe('createStdinVoiceSession injectable engines (issue #162)', () => {
  function executor(): { execute: (cmd: Command) => Promise<Response>; calls: Command[] } {
    const calls: Command[] = [];
    return {
      calls,
      execute: async (cmd: Command) => {
        calls.push(cmd);
        return { ok: true };
      },
    };
  }

  it('drives the injected bridge + transport, not stdin', async () => {
    const transport = new StubTransport();
    const bridge = new StubBridge();
    const commandApi = executor();

    const manager = await createStdinVoiceSession({
      apiKey: 'sk-test',
      commandApi,
      audioTransport: transport,
      bridge,
    });
    await manager.start();

    expect(bridge.connected).toHaveLength(1);
    expect(bridge.connected[0]?.apiKey).toBe('sk-test');
    // Default Florina voice tools were attached to the session options.
    expect(bridge.connected[0]?.options?.tools?.length).toBeGreaterThan(0);

    manager.startListening();
    expect(bridge.listening).toBe(1);
    manager.stopListening();
    expect(bridge.stoppedListening).toBe(1);

    await manager.stop();
    expect(bridge.disconnected).toBe(1);
    expect(transport.closed).toBe(1);
  });

  it('routes state changes to the command executor as voice-state reports', async () => {
    const commandApi = executor();
    const bridge = new StubBridge();
    const manager = await createStdinVoiceSession({
      apiKey: 'sk-test',
      commandApi,
      audioTransport: new StubTransport(),
      bridge,
    });
    await manager.start();

    bridge.emitState('listening');
    await vi.waitFor(() => {
      expect(commandApi.calls.some((c) => c.kind === 'voice-state')).toBe(true);
    });
    await manager.stop();
  });

  it('queries preferences for the first-run interview through the injected executor', async () => {
    const commandApi = executor();
    await createStdinVoiceSession({
      apiKey: 'sk-test',
      commandApi,
      audioTransport: new StubTransport(),
      bridge: new StubBridge(),
    });
    expect(commandApi.calls.some((c) => c.kind === 'query-preferences')).toBe(true);
  });
});
