import { describe, it, expect, beforeEach, vi } from 'vitest';

import { RealtimeBridge } from '../src/voice/realtime-bridge.js';
import type { RealtimeSocket, SocketFactory } from '../src/voice/realtime-bridge.js';
import type { AudioChunk, AudioTransport } from '../src/voice/audio-types.js';
import { VoiceSessionState } from '../src/voice/audio-types.js';
import {
  decodeServerMessage,
  encodeClientMessage,
  type ClientMessage,
  type ServerMessage,
} from '../src/voice/realtime-message.js';

/* ================================================================== *
 * Mock AudioTransport
 * ================================================================== */

/**
 * In-memory AudioTransport for testing. Records captured-chunk delivery
 * callback and every playback call so tests can assert on them.
 */
class MockAudioTransport implements AudioTransport {
  private captureCallback: ((chunk: AudioChunk) => void) | null = null;
  readonly played: AudioChunk[] = [];
  captureStarted = false;
  captureStopped = false;
  playbackStopped = false;
  closed = false;

  startCapture(onChunk: (chunk: AudioChunk) => void): void {
    this.captureStarted = true;
    this.captureCallback = onChunk;
  }

  stopCapture(): void {
    this.captureStopped = true;
    this.captureCallback = null;
  }

  /** Test helper: simulate the transport producing a captured audio chunk. */
  feedChunk(chunk: AudioChunk): void {
    if (this.captureCallback) {
      this.captureCallback(chunk);
    }
  }

  play(chunk: AudioChunk): void {
    this.played.push(chunk);
  }

  stopPlayback(): void {
    this.playbackStopped = true;
  }

  close(): void {
    this.closed = true;
  }
}

/* ================================================================== *
 * Mock WebSocket (RealtimeSocket)
 * ================================================================== */

type Listener = (...args: unknown[]) => void;

/**
 * Fake WebSocket implementing the RealtimeSocket interface. Tests drive it
 * by calling `emitOpen`, `emitMessage`, `emitClose`, `emitError`, and inspect
 * `sent` for outbound messages.
 */
class MockSocket implements RealtimeSocket {
  readonly OPEN = 1;
  readyState = 1; // OPEN by default
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<Listener>>();
  closed = false;
  closeCode: number | undefined;
  closeReason: string | undefined;

  on(event: string, listener: Listener): this {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return this;
  }

  off(event: string, listener: Listener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = 3; // CLOSED
  }

  /* --- test drivers --- */

  emitOpen(): void {
    this.emit('open');
  }

  emitMessage(msg: ServerMessage): void {
    this.emit('message', JSON.stringify(msg));
  }

  emitRaw(data: string): void {
    this.emit('message', data);
  }

  emitClose(code = 1000, reason = ''): void {
    this.readyState = 3;
    this.emit('close', code, reason);
  }

  emitError(err: unknown): void {
    this.emit('error', err);
  }

  private emit(event: string, ...args: unknown[]): void {
    const set = this.listeners.get(event);
    if (set) {
      for (const listener of set) {
        listener(...args);
      }
    }
  }
}

/* ================================================================== *
 * Test factory + helpers
 * ================================================================== */

/** Socket factory that returns a fresh MockSocket and records it. */
function mockFactory(sockets: MockSocket[]): SocketFactory {
  return () => {
    const socket = new MockSocket();
    sockets.push(socket);
    return socket;
  };
}

function makeChunk(pcm = 'AAAA'): AudioChunk {
  return { pcm, sampleRate: 24000, channels: 1 };
}

/** Collect all sent client messages on a socket. */
function allSent(socket: MockSocket): ClientMessage[] {
  return socket.sent.map((s) => JSON.parse(s) as ClientMessage);
}

/* ================================================================== *
 * Tests
 * ================================================================== */

describe('RealtimeBridge', () => {
  let audio: MockAudioTransport;
  let sockets: MockSocket[];
  let factory: SocketFactory;
  let bridge: RealtimeBridge;

  beforeEach(() => {
    audio = new MockAudioTransport();
    sockets = [];
    factory = mockFactory(sockets);
    bridge = new RealtimeBridge(audio, factory);
  });

  /* ---------------------------------------------------------------- *
   * Message encoding / decoding
   * ---------------------------------------------------------------- */

  describe('message encoding / decoding', () => {
    it('encodes a client message to JSON wire format', () => {
      const msg = encodeClientMessage({
        type: 'input_audio_buffer.append',
        audio: 'BASE64',
      });
      const parsed = JSON.parse(msg) as ClientMessage;
      expect(parsed.type).toBe('input_audio_buffer.append');
      expect((parsed as { audio: string }).audio).toBe('BASE64');
    });

    it('decodes a known server message', () => {
      const raw = JSON.stringify({
        type: 'response.text.done',
        text: 'hello',
      });
      const msg = decodeServerMessage(raw);
      expect(msg).not.toBeNull();
      expect(msg?.type).toBe('response.text.done');
    });

    it('decodes a Buffer payload', () => {
      const raw = JSON.stringify({ type: 'error', error: { type: 'server', message: 'boom' } });
      const msg = decodeServerMessage(Buffer.from(raw, 'utf8'));
      expect(msg?.type).toBe('error');
    });

    it('returns null for invalid JSON', () => {
      expect(decodeServerMessage('not-json')).toBeNull();
    });

    it('returns null for unknown message type', () => {
      expect(decodeServerMessage(JSON.stringify({ type: 'unknown.event' }))).toBeNull();
    });

    it('returns null for non-object payload', () => {
      expect(decodeServerMessage(JSON.stringify('hello'))).toBeNull();
    });
  });

  /* ---------------------------------------------------------------- *
   * connect / disconnect lifecycle
   * ---------------------------------------------------------------- */

  describe('connect / disconnect lifecycle', () => {
    it('connects, sends session.update, and resolves', async () => {
      const promise = bridge.connect('sk-test', {
        instructions: 'You are the Florina',
        voice: 'shimmer',
      });
      const socket = sockets[0];
      socket.emitOpen();
      await promise;

      expect(bridge.isConnected).toBe(true);
      // First message after open is session.update.
      const messages = allSent(socket);
      const update = messages.find((m) => m.type === 'session.update');
      expect(update).toBeDefined();
      expect(update?.type).toBe('session.update');
      if (update?.type === 'session.update') {
        expect(update.session.instructions).toBe('You are the Florina');
        expect(update.session.voice).toBe('shimmer');
        expect(update.session.turn_detection).toEqual({ type: 'none' });
        expect(update.session.input_audio_format).toBe('pcm16');
      }
    });

    it('transitions Idle -> Connecting -> Idle on successful connect', async () => {
      const states: string[] = [];
      bridge.onStateChange((e) => states.push(`${e.from}->${e.to}`));

      expect(bridge.currentState).toBe(VoiceSessionState.Idle);
      const promise = bridge.connect('sk-test');
      expect(bridge.currentState).toBe(VoiceSessionState.Connecting);
      sockets[0].emitOpen();
      await promise;
      // session.created/updated drives the final Idle transition.
      sockets[0].emitMessage({ type: 'session.created', session: { id: 's1' } });
      expect(bridge.currentState).toBe(VoiceSessionState.Idle);
      expect(states).toContain('idle->connecting');
      expect(states).toContain('connecting->idle');
    });

    it('rejects when the socket errors before open', async () => {
      const promise = bridge.connect('sk-test');
      sockets[0].emitError(new Error('ECONNREFUSED'));
      await expect(promise).rejects.toThrow('ECONNREFUSED');
      expect(bridge.currentState).toBe(VoiceSessionState.Error);
    });

    it('rejects a second connect while already connected', async () => {
      const p1 = bridge.connect('sk-test');
      sockets[0].emitOpen();
      await p1;
      await expect(bridge.connect('sk-test')).rejects.toThrow('already connected');
    });

    it('disconnect closes the socket and returns to Idle', async () => {
      const p = bridge.connect('sk-test');
      sockets[0].emitOpen();
      await p;
      const socket = sockets[0];

      const p2 = bridge.disconnect();
      socket.emitClose();
      await p2;

      expect(socket.closed).toBe(true);
      expect(bridge.currentState).toBe(VoiceSessionState.Idle);
      expect(bridge.isConnected).toBe(false);
    });
  });

  /* ---------------------------------------------------------------- *
   * startListening / stopListening
   * ---------------------------------------------------------------- */

  describe('startListening / stopListening', () => {
    async function connect(): Promise<MockSocket> {
      const p = bridge.connect('sk-test');
      sockets[0].emitOpen();
      await p;
      sockets[0].emitMessage({ type: 'session.created', session: { id: 's1' } });
      return sockets[0];
    }

    it('starts audio capture and transitions to Listening', async () => {
      const socket = await connect();
      bridge.startListening();

      expect(bridge.isListening).toBe(true);
      expect(bridge.currentState).toBe(VoiceSessionState.Listening);
      expect(audio.captureStarted).toBe(true);
      // No audio sent yet (no chunks fed).
      expect(socket.sent.filter((s) => s.includes('input_audio_buffer.append'))).toHaveLength(0);
    });

    it('sends input_audio_buffer.append for each captured chunk', async () => {
      const socket = await connect();
      bridge.startListening();
      audio.feedChunk(makeChunk('CHUNK1'));
      audio.feedChunk(makeChunk('CHUNK2'));

      const appends = allSent(socket).filter((m) => m.type === 'input_audio_buffer.append');
      expect(appends).toHaveLength(2);
      if (appends[0]?.type === 'input_audio_buffer.append') {
        expect(appends[0].audio).toBe('CHUNK1');
      }
      if (appends[1]?.type === 'input_audio_buffer.append') {
        expect(appends[1].audio).toBe('CHUNK2');
      }
    });

    it('stopListening commits the buffer and requests a response', async () => {
      const socket = await connect();
      bridge.startListening();
      bridge.stopListening();

      expect(bridge.isListening).toBe(false);
      expect(audio.captureStopped).toBe(true);
      const types = allSent(socket).map((m) => m.type);
      expect(types).toContain('input_audio_buffer.commit');
      expect(types).toContain('response.create');
      expect(bridge.currentState).toBe(VoiceSessionState.Processing);
    });

    it('throws when starting to listen without a connection', () => {
      expect(() => bridge.startListening()).toThrow('not connected');
    });

    it('is a no-op when stopListening is called while not listening', async () => {
      await connect();
      const before = bridge.currentState;
      bridge.stopListening();
      expect(bridge.currentState).toBe(before);
    });
  });

  /* ---------------------------------------------------------------- *
   * PTT mode — audio only sent while listening
   * ---------------------------------------------------------------- */

  describe('PTT mode', () => {
    async function connect(): Promise<MockSocket> {
      const p = bridge.connect('sk-test');
      sockets[0].emitOpen();
      await p;
      sockets[0].emitMessage({ type: 'session.created', session: { id: 's1' } });
      return sockets[0];
    }

    it('does not send audio when not listening', async () => {
      const socket = await connect();
      // Feed a chunk via the transport while NOT listening — capture isn't
      // started, so the callback is null and nothing is sent.
      audio.feedChunk(makeChunk('NOPE'));
      const appends = allSent(socket).filter((m) => m.type === 'input_audio_buffer.append');
      expect(appends).toHaveLength(0);
    });

    it('drops late chunks captured after stopListening', async () => {
      const socket = await connect();
      bridge.startListening();
      bridge.stopListening();
      // Simulate a late chunk arriving after stop.
      audio.feedChunk(makeChunk('LATE'));
      const appends = allSent(socket).filter((m) => m.type === 'input_audio_buffer.append');
      expect(appends).toHaveLength(0);
    });

    it('only sends audio between startListening and stopListening', async () => {
      const socket = await connect();
      bridge.startListening();
      audio.feedChunk(makeChunk('A'));
      bridge.stopListening();
      audio.feedChunk(makeChunk('B'));
      const appends = allSent(socket).filter((m) => m.type === 'input_audio_buffer.append');
      expect(appends).toHaveLength(1);
      if (appends[0]?.type === 'input_audio_buffer.append') {
        expect(appends[0].audio).toBe('A');
      }
    });
  });

  /* ---------------------------------------------------------------- *
   * Transcript and response callbacks
   * ---------------------------------------------------------------- */

  describe('transcript and response callbacks', () => {
    async function connect(): Promise<MockSocket> {
      const p = bridge.connect('sk-test');
      sockets[0].emitOpen();
      await p;
      sockets[0].emitMessage({ type: 'session.created', session: { id: 's1' } });
      return sockets[0];
    }

    it('fires onTranscript for input audio transcription', async () => {
      const socket = await connect();
      const transcripts: { partial: boolean; text: string }[] = [];
      bridge.onTranscript((e) => transcripts.push({ partial: e.partial, text: e.text }));

      socket.emitMessage({
        type: 'conversation.item.input_audio_transcription.delta',
        delta: 'hello',
      });
      socket.emitMessage({
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: 'hello world',
      });

      expect(transcripts).toEqual([
        { partial: true, text: 'hello' },
        { partial: false, text: 'hello world' },
      ]);
    });

    it('fires onResponse with text deltas and final text', async () => {
      const socket = await connect();
      const responses: { partial: boolean; text?: string }[] = [];
      bridge.onResponse((e) => responses.push({ partial: e.partial, text: e.text }));

      bridge.startListening();
      bridge.stopListening(); // -> Processing
      socket.emitMessage({ type: 'response.text.delta', delta: 'Hi' });
      socket.emitMessage({ type: 'response.text.done', text: 'Hi there' });

      expect(responses).toEqual([
        { partial: true, text: 'Hi' },
        { partial: false, text: 'Hi there' },
      ]);
    });

    it('plays response audio and fires onResponse with audio chunks', async () => {
      const socket = await connect();
      const responses: { partial: boolean; audio?: AudioChunk }[] = [];
      bridge.onResponse((e) => responses.push({ partial: e.partial, audio: e.audio }));

      bridge.startListening();
      bridge.stopListening();
      socket.emitMessage({ type: 'response.output_audio.delta', delta: 'PCM1' });
      socket.emitMessage({ type: 'response.output_audio.done' });

      expect(audio.played).toHaveLength(1);
      expect(audio.played[0]?.pcm).toBe('PCM1');
      expect(responses).toHaveLength(2);
      expect(responses[0]?.partial).toBe(true);
      expect(responses[0]?.audio?.pcm).toBe('PCM1');
      expect(responses[1]?.partial).toBe(false);
    });

    it('unsubscribes callbacks via the returned function', async () => {
      const socket = await connect();
      const calls: string[] = [];
      const off = bridge.onTranscript((e) => calls.push(e.text));

      socket.emitMessage({
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: 'first',
      });
      off();
      socket.emitMessage({
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: 'second',
      });

      expect(calls).toEqual(['first']);
    });
  });

  /* ---------------------------------------------------------------- *
   * State transitions
   * ---------------------------------------------------------------- */

  describe('state machine', () => {
    it('Idle -> Connecting -> Listening -> Processing -> Responding -> Idle', async () => {
      const states: string[] = [];
      bridge.onStateChange((e) => states.push(e.to));

      const p = bridge.connect('sk-test');
      sockets[0].emitOpen();
      await p;
      sockets[0].emitMessage({ type: 'session.created', session: { id: 's1' } });
      // Idle (initial), Connecting, Idle(after session.created)
      expect(states).toEqual(['connecting', 'idle']);

      bridge.startListening();
      expect(bridge.currentState).toBe(VoiceSessionState.Listening);

      bridge.stopListening();
      expect(bridge.currentState).toBe(VoiceSessionState.Processing);

      sockets[0].emitMessage({ type: 'response.text.delta', delta: 'x' });
      expect(bridge.currentState).toBe(VoiceSessionState.Responding);

      sockets[0].emitMessage({ type: 'response.text.done', text: 'x' });
      expect(bridge.currentState).toBe(VoiceSessionState.Idle);

      expect(states).toEqual([
        'connecting',
        'idle',
        'listening',
        'processing',
        'responding',
        'idle',
      ]);
    });

    it('transitions to Error on a server error message', async () => {
      const p = bridge.connect('sk-test');
      sockets[0].emitOpen();
      await p;
      sockets[0].emitMessage({ type: 'session.created', session: { id: 's1' } });

      const errors: string[] = [];
      bridge.onError((e) => errors.push(e.message));

      sockets[0].emitMessage({
        type: 'error',
        error: { type: 'server', message: 'rate limited' },
      });

      expect(bridge.currentState).toBe(VoiceSessionState.Error);
      expect(errors).toContain('rate limited');
    });
  });

  /* ---------------------------------------------------------------- *
   * Error handling and reconnection
   * ---------------------------------------------------------------- */

  describe('error handling and reconnection', () => {
    it('emits an error event on socket error', async () => {
      const p = bridge.connect('sk-test');
      sockets[0].emitOpen();
      await p;

      const errors: string[] = [];
      bridge.onError((e) => errors.push(e.message));
      sockets[0].emitError(new Error('network glitch'));
      expect(errors).toContain('network glitch');
    });

    it('reconnects after an unexpected close', async () => {
      vi.useFakeTimers();
      const p = bridge.connect('sk-test', {
        autoReconnect: true,
        maxReconnectAttempts: 3,
        reconnectBaseDelayMs: 100,
      });
      sockets[0].emitOpen();
      await p;
      const first = sockets[0];

      // Unexpected close (not via disconnect()).
      first.emitClose(1006, 'abnormal');

      expect(bridge.currentState).toBe(VoiceSessionState.Connecting);
      // Advance the reconnect timer.
      await vi.advanceTimersByTimeAsync(150);
      expect(sockets).toHaveLength(2);
      // New socket opens and session.update is re-sent.
      sockets[1].emitOpen();
      sockets[1].emitMessage({ type: 'session.created', session: { id: 's2' } });
      expect(bridge.currentState).toBe(VoiceSessionState.Idle);
      vi.useRealTimers();
    });

    it('does not reconnect after an intentional disconnect', async () => {
      vi.useFakeTimers();
      const p = bridge.connect('sk-test', { autoReconnect: true });
      sockets[0].emitOpen();
      await p;

      const disconnectP = bridge.disconnect();
      sockets[0].emitClose();
      await disconnectP;

      await vi.advanceTimersByTimeAsync(1000);
      expect(sockets).toHaveLength(1);
      expect(bridge.currentState).toBe(VoiceSessionState.Idle);
      vi.useRealTimers();
    });

    it('gives up after max reconnection attempts and emits an error', async () => {
      vi.useFakeTimers();
      const errors: string[] = [];
      bridge.onError((e) => errors.push(e.message));

      const p = bridge.connect('sk-test', {
        autoReconnect: true,
        maxReconnectAttempts: 2,
        reconnectBaseDelayMs: 10,
      });
      sockets[0].emitOpen();
      await p;

      // First unexpected close.
      sockets[0].emitClose(1006, 'down');
      await vi.advanceTimersByTimeAsync(20);
      sockets[1].emitOpen();
      // Second unexpected close.
      sockets[1].emitClose(1006, 'down');
      await vi.advanceTimersByTimeAsync(40);
      sockets[2].emitOpen();
      // Third unexpected close — exceeds max (2) attempts.
      sockets[2].emitClose(1006, 'down');
      await vi.advanceTimersByTimeAsync(1000);

      expect(bridge.currentState).toBe(VoiceSessionState.Error);
      expect(errors.length).toBeGreaterThan(0);
      vi.useRealTimers();
    });
  });

  /* ---------------------------------------------------------------- *
   * Tool call protocol
   * ---------------------------------------------------------------- */

  describe('tool call protocol', () => {
    async function connect(): Promise<MockSocket> {
      const p = bridge.connect('sk-test');
      sockets[0].emitOpen();
      await p;
      sockets[0].emitMessage({ type: 'session.created', session: { id: 's1' } });
      return sockets[0];
    }

    it('fires onToolCall when a function_call item is created', async () => {
      const socket = await connect();
      const calls: { callId: string; name: string; arguments: string }[] = [];
      bridge.onToolCall((e) =>
        calls.push({ callId: e.callId, name: e.name, arguments: e.arguments }),
      );

      socket.emitMessage({
        type: 'conversation.item.created',
        item: {
          type: 'function_call',
          call_id: 'call_1',
          name: 'start_task',
          arguments: '{"title":"fix bug"}',
        },
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({
        callId: 'call_1',
        name: 'start_task',
        arguments: '{"title":"fix bug"}',
      });
    });

    it('does not fire onToolCall for non-function_call items', async () => {
      const socket = await connect();
      const calls: string[] = [];
      bridge.onToolCall((e) => calls.push(e.name));

      socket.emitMessage({
        type: 'conversation.item.created',
        item: { type: 'message', role: 'assistant', content: [] },
      });

      expect(calls).toHaveLength(0);
    });

    it('sendToolCallOutput sends conversation.item.create with function_call_output', async () => {
      const socket = await connect();
      bridge.sendToolCallOutput('call_1', '{"ok":true}');

      const creates = allSent(socket).filter((m) => m.type === 'conversation.item.create');
      expect(creates).toHaveLength(1);
      if (creates[0]?.type === 'conversation.item.create') {
        expect(creates[0].item.type).toBe('function_call_output');
        expect(creates[0].item.call_id).toBe('call_1');
        expect(creates[0].item.output).toBe('{"ok":true}');
      }
    });

    it('sendUserMessage creates a user message item then requests a response', async () => {
      const socket = await connect();
      bridge.sendUserMessage('The research finished: quota resets hourly.');

      const sent = allSent(socket);
      const creates = sent.filter((m) => m.type === 'conversation.item.create');
      expect(creates).toHaveLength(1);
      if (creates[0]?.type === 'conversation.item.create') {
        expect(creates[0].item.type).toBe('message');
        if (creates[0].item.type === 'message') {
          expect(creates[0].item.role).toBe('user');
          expect(creates[0].item.content[0]).toEqual({
            type: 'input_text',
            text: 'The research finished: quota resets hourly.',
          });
        }
      }
      // A response.create follows the item so the assistant speaks the result.
      const createIdx = sent.findIndex((m) => m.type === 'conversation.item.create');
      const respondIdx = sent.findIndex((m) => m.type === 'response.create');
      expect(respondIdx).toBeGreaterThan(createIdx);
    });

    it('unsubscribes onToolCall via the returned function', async () => {
      const socket = await connect();
      const calls: string[] = [];
      const off = bridge.onToolCall((e) => calls.push(e.name));

      socket.emitMessage({
        type: 'conversation.item.created',
        item: { type: 'function_call', call_id: 'c1', name: 'first', arguments: '{}' },
      });
      off();
      socket.emitMessage({
        type: 'conversation.item.created',
        item: { type: 'function_call', call_id: 'c2', name: 'second', arguments: '{}' },
      });

      expect(calls).toEqual(['first']);
    });

    it('ignores conversation.item.deleted', async () => {
      const socket = await connect();
      const before = bridge.currentState;
      socket.emitMessage({ type: 'conversation.item.deleted', item_id: 'item_1' });
      expect(bridge.currentState).toBe(before);
    });
  });

  /* ---------------------------------------------------------------- *
   * Session id tracking
   * ---------------------------------------------------------------- */

  describe('session id tracking', () => {
    it('tracks the session id from session.created', async () => {
      const p = bridge.connect('sk-test');
      sockets[0].emitOpen();
      await p;
      expect(bridge.sessionId).toBeNull();
      sockets[0].emitMessage({ type: 'session.created', session: { id: 'sess-abc' } });
      expect(bridge.sessionId).toBe('sess-abc');
    });

    it('updates the session id on session.updated', async () => {
      const p = bridge.connect('sk-test');
      sockets[0].emitOpen();
      await p;
      sockets[0].emitMessage({ type: 'session.created', session: { id: 's1' } });
      sockets[0].emitMessage({ type: 'session.updated', session: { id: 's2' } });
      expect(bridge.sessionId).toBe('s2');
    });

    it('clears the session id on disconnect', async () => {
      const p = bridge.connect('sk-test');
      sockets[0].emitOpen();
      await p;
      sockets[0].emitMessage({ type: 'session.created', session: { id: 's1' } });
      expect(bridge.sessionId).toBe('s1');

      const d = bridge.disconnect();
      sockets[0].emitClose();
      await d;
      expect(bridge.sessionId).toBeNull();
    });
  });

  /* ---------------------------------------------------------------- *
   * Interruption handling
   * ---------------------------------------------------------------- */

  describe('interrupt', () => {
    async function connect(): Promise<MockSocket> {
      const p = bridge.connect('sk-test');
      sockets[0].emitOpen();
      await p;
      sockets[0].emitMessage({ type: 'session.created', session: { id: 's1' } });
      return sockets[0];
    }

    it('sends response.cancel and returns to Idle from Responding', async () => {
      const socket = await connect();
      bridge.startListening();
      bridge.stopListening(); // -> Processing
      socket.emitMessage({ type: 'response.text.delta', delta: 'x' });
      expect(bridge.currentState).toBe(VoiceSessionState.Responding);

      bridge.interrupt();

      const types = allSent(socket).map((m) => m.type);
      expect(types).toContain('response.cancel');
      expect(bridge.currentState).toBe(VoiceSessionState.Idle);
      expect(audio.playbackStopped).toBe(true);
    });

    it('returns to Idle from Processing on interrupt', async () => {
      const socket = await connect();
      bridge.startListening();
      bridge.stopListening(); // -> Processing
      expect(bridge.currentState).toBe(VoiceSessionState.Processing);

      bridge.interrupt();

      expect(allSent(socket).some((m) => m.type === 'response.cancel')).toBe(true);
      expect(bridge.currentState).toBe(VoiceSessionState.Idle);
    });

    it('is a no-op on state when already Idle', async () => {
      const socket = await connect();
      bridge.interrupt();
      expect(bridge.currentState).toBe(VoiceSessionState.Idle);
      expect(allSent(socket).some((m) => m.type === 'response.cancel')).toBe(true);
    });
  });

  /* ---------------------------------------------------------------- *
   * Duplicate listener guard
   * ---------------------------------------------------------------- */

  describe('duplicate listener guard', () => {
    it('sends session.update only once on connect', async () => {
      const promise = bridge.connect('sk-test', {
        instructions: 'You are the Florina',
      });
      sockets[0].emitOpen();
      await promise;

      const updates = allSent(sockets[0]).filter((m) => m.type === 'session.update');
      expect(updates).toHaveLength(1);
    });
  });
});
