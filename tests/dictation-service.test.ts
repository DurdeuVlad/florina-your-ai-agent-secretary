import { describe, it, expect, beforeEach } from 'vitest';

import { DictationService } from '../src/core/application/use-cases/voice/dictation-service.js';
import type {
  AudioChunk,
  AudioTransport,
  RealtimeSessionOptions,
  RealtimeSessionPort,
  TranscriptionPort,
  TranscriptEvent,
  TranscriptResult,
  ToolCallEvent,
  VoiceStateChangeEvent,
  VoiceSessionState,
} from '../src/core/application/ports/outbound/voice.js';

/* ------------------------------------------------------------------ *
 * Mocks
 * ------------------------------------------------------------------ */

class MockAudioTransport implements AudioTransport {
  private cb: ((chunk: AudioChunk) => void) | null = null;
  captureStarts = 0;
  captureStops = 0;

  startCapture(onChunk: (chunk: AudioChunk) => void): void {
    this.captureStarts += 1;
    this.cb = onChunk;
  }
  stopCapture(): void {
    this.captureStops += 1;
    this.cb = null;
  }
  feed(chunk: AudioChunk): void {
    this.cb?.(chunk);
  }
  play(): void {}
  stopPlayback(): void {}
  close(): void {}
}

class MockRealtimeSession implements RealtimeSessionPort {
  currentState: VoiceSessionState = 'idle';
  isConnected = false;
  connectCalls: Array<{ apiKey: string; options?: RealtimeSessionOptions }> = [];
  listening = false;
  failConnect: Error | null = null;

  private transcriptCbs = new Set<(e: TranscriptEvent) => void>();
  private stateCbs = new Set<(e: VoiceStateChangeEvent) => void>();

  async connect(apiKey: string, options?: RealtimeSessionOptions): Promise<void> {
    this.connectCalls.push({ apiKey, options });
    if (this.failConnect !== null) throw this.failConnect;
    this.isConnected = true;
  }
  async disconnect(): Promise<void> {
    this.isConnected = false;
    this.emitState('idle');
  }
  startListening(): void {
    this.listening = true;
  }
  stopListening(): void {
    this.listening = false;
  }
  sendToolCallOutput(): void {}
  sendUserMessage(): void {}
  onToolCall(cb: (e: ToolCallEvent) => void): () => void {
    void cb;
    return () => undefined;
  }
  onTranscript(cb: (e: TranscriptEvent) => void): () => void {
    this.transcriptCbs.add(cb);
    return () => this.transcriptCbs.delete(cb);
  }
  onStateChange(cb: (e: VoiceStateChangeEvent) => void): () => void {
    this.stateCbs.add(cb);
    return () => this.stateCbs.delete(cb);
  }

  emitTranscript(event: TranscriptEvent): void {
    for (const cb of this.transcriptCbs) cb(event);
  }
  emitState(to: VoiceSessionState): void {
    const from = this.currentState;
    this.currentState = to;
    if (to === 'idle' || to === 'error')
      this.isConnected = to !== 'idle' ? this.isConnected : false;
    for (const cb of this.stateCbs) cb({ from, to });
  }
}

class MockWhisper implements TranscriptionPort {
  isInitialized = true;
  available = true;
  result: TranscriptResult = { text: 'whisper words', confidence: 0.9 };
  failWith: Error | null = null;
  calls: Array<readonly AudioChunk[]> = [];

  async transcribe(chunks: readonly AudioChunk[]): Promise<TranscriptResult> {
    this.calls.push(chunks);
    if (this.failWith !== null) throw this.failWith;
    return this.result;
  }
  async isAvailable(): Promise<boolean> {
    return this.available;
  }
  async close(): Promise<void> {}
}

function chunk(pcm: string): AudioChunk {
  return { pcm, sampleRate: 24000, channels: 1 };
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

describe('DictationService', () => {
  let transport: MockAudioTransport;
  let session: MockRealtimeSession;
  let whisper: MockWhisper;
  let updates: Array<{ state: string; error?: string }>;
  let transcripts: TranscriptEvent[];

  function makeService(extra?: {
    session?: RealtimeSessionPort;
    whisper?: TranscriptionPort;
    finalTimeoutMs?: number;
  }): DictationService {
    return new DictationService({
      transport,
      apiKey: 'sk-test',
      session: extra && 'session' in extra ? extra.session : session,
      whisper: extra && 'whisper' in extra ? extra.whisper : whisper,
      finalTimeoutMs: extra?.finalTimeoutMs ?? 50,
      onUpdate: (u) => updates.push(u),
      onTranscript: (t) => transcripts.push(t),
    });
  }

  beforeEach(() => {
    transport = new MockAudioTransport();
    session = new MockRealtimeSession();
    whisper = new MockWhisper();
    updates = [];
    transcripts = [];
  });

  it('connects the realtime session in transcriptionOnly mode on first start', async () => {
    const svc = makeService();
    await svc.start();
    expect(session.connectCalls).toHaveLength(1);
    expect(session.connectCalls[0]?.options?.transcriptionOnly).toBe(true);
    expect(session.listening).toBe(true);
    expect(svc.currentState).toBe('listening');
    expect(updates.map((u) => u.state)).toEqual(['connecting', 'listening']);
  });

  it('reuses the realtime session across rounds — no reconnect', async () => {
    const svc = makeService();
    await svc.start();
    session.emitTranscript({ partial: false, text: 'first' });
    await svc.stop();
    await svc.start();
    expect(session.connectCalls).toHaveLength(1);
    expect(svc.currentState).toBe('listening');
  });

  it('forwards partial transcripts while listening', async () => {
    const svc = makeService();
    await svc.start();
    session.emitTranscript({ partial: true, text: 'hel' });
    session.emitTranscript({ partial: true, text: 'hello wor' });
    expect(transcripts).toEqual([
      { partial: true, text: 'hel' },
      { partial: true, text: 'hello wor' },
    ]);
  });

  it('stop() commits and emits the final transcript, then idles', async () => {
    const svc = makeService();
    await svc.start();
    const stopping = svc.stop();
    expect(svc.currentState).toBe('transcribing');
    session.emitTranscript({ partial: false, text: 'hello world' });
    await stopping;
    expect(transcripts).toContainEqual({ partial: false, text: 'hello world' });
    expect(svc.currentState).toBe('idle');
    expect(session.listening).toBe(false);
  });

  it('degrades to the last partial when the final never arrives', async () => {
    const svc = makeService();
    await svc.start();
    session.emitTranscript({ partial: true, text: 'partial words' });
    await svc.stop(); // finalTimeoutMs=50 → timeout, no final event
    expect(transcripts).toContainEqual({ partial: false, text: 'partial words' });
    expect(svc.currentState).toBe('idle');
  });

  it('emits no final on a totally silent round', async () => {
    const svc = makeService();
    await svc.start();
    await svc.stop();
    expect(transcripts.filter((t) => !t.partial)).toHaveLength(0);
    expect(svc.currentState).toBe('idle');
  });

  it('cancel() suppresses a late-arriving final transcript', async () => {
    const svc = makeService();
    await svc.start();
    svc.cancel();
    expect(svc.currentState).toBe('idle');
    session.emitTranscript({ partial: false, text: 'too late' });
    expect(transcripts.filter((t) => !t.partial)).toHaveLength(0);
  });

  it('cancel() on the whisper path stops renderer capture', async () => {
    session.failConnect = new Error('no network');
    const svc = makeService();
    await svc.start();
    expect(svc.currentState).toBe('listening');
    svc.cancel();
    expect(transport.captureStops).toBe(1);
    expect(svc.currentState).toBe('idle');
  });

  it('falls back to whisper when realtime connect fails', async () => {
    session.failConnect = new Error('ws refused');
    const svc = makeService();
    await svc.start();
    expect(svc.currentState).toBe('listening');
    expect(transport.captureStarts).toBe(1);
    // Chunks are collected directly for the batch engine.
    transport.feed(chunk('QUJD'));
    await svc.stop();
    expect(whisper.calls).toHaveLength(1);
    expect(whisper.calls[0]?.[0]?.pcm).toBe('QUJD');
    expect(transcripts).toContainEqual({ partial: false, text: 'whisper words' });
    expect(svc.currentState).toBe('idle');
  });

  it('reports an honest error when no engine is available', async () => {
    const svc = makeService({ session: undefined, whisper: undefined });
    await svc.start();
    expect(svc.currentState).toBe('error');
    expect(updates.at(-1)?.error).toContain('no voice engine');
  });

  it('reports an error when realtime fails and whisper is unavailable', async () => {
    session.failConnect = new Error('ws refused');
    whisper.available = false;
    const svc = makeService();
    await svc.start();
    expect(svc.currentState).toBe('error');
    expect(updates.at(-1)?.error).toContain('ws refused');
  });

  it('surfaces whisper transcription failures as errors', async () => {
    session.failConnect = new Error('offline');
    whisper.failWith = new Error('decode exploded');
    const svc = makeService();
    await svc.start();
    transport.feed(chunk('QUJD'));
    await svc.stop();
    expect(svc.currentState).toBe('error');
    expect(updates.at(-1)?.error).toContain('decode exploded');
  });

  it('a dropped realtime session reconnects on the next start', async () => {
    const svc = makeService();
    await svc.start();
    await svc.stop();
    // Simulate the socket dying between rounds.
    session.isConnected = false;
    session.emitState('error');
    await svc.start();
    expect(session.connectCalls).toHaveLength(2);
    expect(svc.currentState).toBe('listening');
  });

  it('cancel() during connect aborts the round — no zombie listening state', async () => {
    // Slow connect so cancel lands mid-flight.
    const realConnect = session.connect.bind(session);
    let release: () => void = () => undefined;
    session.connect = async (apiKey, options) => {
      await new Promise<void>((r) => (release = r));
      return realConnect(apiKey, options);
    };
    const svc = makeService();
    const starting = svc.start();
    svc.cancel();
    release();
    await starting;
    expect(svc.currentState).toBe('idle');
    expect(session.listening).toBe(false);
    // The cancel's suppress flag must not swallow the NEXT round's final.
    await svc.start();
    expect(svc.currentState).toBe('listening');
    const stopping = svc.stop();
    session.emitTranscript({ partial: false, text: 'second round' });
    await stopping;
    expect(transcripts).toContainEqual({ partial: false, text: 'second round' });
  });

  it('ignores start() while a round is active', async () => {
    const svc = makeService();
    await svc.start();
    await svc.start();
    expect(session.connectCalls).toHaveLength(1);
  });
});
