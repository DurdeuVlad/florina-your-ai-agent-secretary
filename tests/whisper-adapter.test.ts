import { describe, it, expect, expectTypeOf, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RealtimeBridge } from '../src/voice/realtime-bridge.js';
import type { RealtimeSocket, SocketFactory } from '../src/voice/realtime-bridge.js';
import type { AudioChunk, AudioTransport } from '../src/voice/audio-types.js';
import {
  WhisperCppBackend,
  parseWhisperJsonOutput,
  buildWhisperArgs,
  DEFAULT_WHISPER_CLI_OPTIONS,
  ProcessNotFoundError,
  ProcessTimeoutError,
  type ProcessRunner,
  type ProcessResult,
  type WhisperBackend,
  type WhisperCliOptions,
  type WhisperResult,
} from '../src/voice/whisper-backend.js';
import {
  WhisperAdapter,
  segmentConfidence,
  overallConfidence,
  concatAudioChunks,
  type WhisperAdapterOptions,
  type TranscriptResult,
  type TranscriptSegment,
} from '../src/voice/whisper-adapter.js';
import {
  VoicePipeline,
  type PipelineTranscriptEvent,
} from '../src/voice/voice-pipeline.js';
import type { ServerMessage } from '../src/voice/realtime-message.js';

/* ================================================================== *
 * Mock AudioTransport
 * ================================================================== */

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

class MockSocket implements RealtimeSocket {
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<Listener>>();
  closed = false;

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
    void code;
    void reason;
    this.closed = true;
    this.readyState = 3;
  }

  emitOpen(): void {
    this.emit('open');
  }

  emitMessage(msg: ServerMessage): void {
    this.emit('message', JSON.stringify(msg));
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

function mockFactory(sockets: MockSocket[]): SocketFactory {
  return () => {
    const socket = new MockSocket();
    sockets.push(socket);
    return socket;
  };
}

/* ================================================================== *
 * Mock WhisperBackend
 * ================================================================== */

/**
 * In-memory WhisperBackend for testing. Records calls and returns canned
 * results without spawning any process.
 */
class MockWhisperBackend implements WhisperBackend {
  initialized = false;
  closed = false;
  readonly initCalls: { modelPath: string; options: WhisperCliOptions }[] = [];
  readonly transcribeCalls: Buffer[] = [];
  available = true;
  /**
   * Optional gate promise that `transcribe` awaits before resolving. Used by
   * the concurrency test to keep the first call in-flight while a second is
   * queued. Set to `null` (default) for immediate resolution.
   */
  transcribeGate: Promise<void> | null = null;
  nextResult: WhisperResult = {
    language: 'en',
    text: 'hello world',
    segments: [
      {
        id: 0,
        start: 0,
        end: 1.5,
        text: 'hello world',
        tokens: [1, 2, 3],
        temperature: 0,
        avg_logprob: -0.2,
        compression_ratio: 1.1,
        no_speech_prob: 0.01,
      },
    ],
  };
  transcribeError: Error | null = null;

  async initialize(modelPath: string, options: WhisperCliOptions): Promise<void> {
    this.initCalls.push({ modelPath, options });
    this.initialized = true;
  }

  async transcribe(audioData: Buffer): Promise<WhisperResult> {
    this.transcribeCalls.push(audioData);
    if (this.transcribeGate !== null) {
      await this.transcribeGate;
    }
    if (this.transcribeError !== null) {
      throw this.transcribeError;
    }
    return this.nextResult;
  }

  async isAvailable(): Promise<boolean> {
    return this.available && this.initialized;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.initialized = false;
  }
}

/* ================================================================== *
 * Mock ProcessRunner
 * ================================================================== */

class MockProcessRunner implements ProcessRunner {
  readonly runCalls: {
    command: string;
    args: readonly string[];
    stdin?: string;
    timeoutMs?: number;
  }[] = [];
  nextStdout = '';
  nextStderr = '';
  nextExitCode = 0;
  nextError: Error | null = null;

  async run(
    command: string,
    args: readonly string[],
    stdinData?: string,
    timeoutMs?: number,
  ): Promise<ProcessResult> {
    this.runCalls.push({ command, args, stdin: stdinData, timeoutMs });
    if (this.nextError !== null) {
      throw this.nextError;
    }
    return {
      stdout: this.nextStdout,
      stderr: this.nextStderr,
      exitCode: this.nextExitCode,
    };
  }
}

/* ================================================================== *
 * Helpers
 * ================================================================== */

function makeChunk(pcm = 'AAAA'): AudioChunk {
  return { pcm, sampleRate: 24000, channels: 1 };
}

function sampleWhisperJson(text = 'hello world'): string {
  return JSON.stringify({
    result: {
      language: 'en',
      text,
      segments: [
        {
          id: 0,
          start: 0,
          end: 1.5,
          text,
          tokens: [1, 2, 3],
          temperature: 0,
          avg_logprob: -0.2,
          compression_ratio: 1.1,
          no_speech_prob: 0.01,
        },
      ],
    },
  });
}

/* ================================================================== *
 * whisper-backend: JSON parsing + CLI args
 * ================================================================== */

describe('whisper-backend', () => {
  describe('parseWhisperJsonOutput', () => {
    it('parses valid whisper.cpp JSON output', () => {
      const result = parseWhisperJsonOutput(sampleWhisperJson('hello world'));
      expect(result.language).toBe('en');
      expect(result.text).toBe('hello world');
      expect(result.segments).toHaveLength(1);
      expect(result.segments[0].text).toBe('hello world');
      expect(result.segments[0].avg_logprob).toBe(-0.2);
    });

    it('parses output with multiple segments', () => {
      const raw = JSON.stringify({
        result: {
          language: 'fr',
          text: 'bonjour le monde',
          segments: [
            {
              id: 0,
              start: 0,
              end: 1,
              text: 'bonjour',
              tokens: [1],
              temperature: 0,
              avg_logprob: -0.1,
              compression_ratio: 1,
              no_speech_prob: 0,
            },
            {
              id: 1,
              start: 1,
              end: 2,
              text: 'le monde',
              tokens: [2, 3],
              temperature: 0,
              avg_logprob: -0.3,
              compression_ratio: 1.2,
              no_speech_prob: 0.05,
            },
          ],
        },
      });
      const result = parseWhisperJsonOutput(raw);
      expect(result.segments).toHaveLength(2);
      expect(result.segments[1].text).toBe('le monde');
    });

    it('throws on invalid JSON', () => {
      expect(() => parseWhisperJsonOutput('not json')).toThrow(/invalid JSON/);
    });

    it('throws when "result" envelope is missing', () => {
      expect(() => parseWhisperJsonOutput('{}')).toThrow(/missing "result"/);
    });

    it('throws when "text" is missing', () => {
      expect(() =>
        parseWhisperJsonOutput(JSON.stringify({ result: { language: 'en' } })),
      ).toThrow(/missing "text"/);
    });

    it('throws when "segments" is not an array', () => {
      expect(() =>
        parseWhisperJsonOutput(
          JSON.stringify({ result: { language: 'en', text: 'hi', segments: 5 } }),
        ),
      ).toThrow(/missing "segments"/);
    });

    it('fills defaults for missing optional segment fields', () => {
      const raw = JSON.stringify({
        result: {
          language: 'en',
          text: 'hi',
          segments: [{ id: 0, start: 0, end: 1, text: 'hi' }],
        },
      });
      const result = parseWhisperJsonOutput(raw);
      expect(result.segments[0].tokens).toEqual([]);
      expect(result.segments[0].avg_logprob).toBe(0);
    });
  });

  describe('buildWhisperArgs', () => {
    it('builds args with model, language, beam size, and audio path', () => {
      const opts: WhisperCliOptions = {
        model: '/models/ggml-base.en.bin',
        language: 'en',
        beamSize: 7,
        speedUp: false,
        outputJson: true,
      };
      const args = buildWhisperArgs(opts, '/tmp/audio.wav');
      expect(args).toContain('-m');
      expect(args).toContain('/models/ggml-base.en.bin');
      expect(args).toContain('-l');
      expect(args).toContain('en');
      expect(args).toContain('-bs');
      expect(args).toContain('7');
      expect(args).toContain('-oj');
      expect(args).toContain('-f');
      expect(args).toContain('/tmp/audio.wav');
      expect(args).not.toContain('-su');
    });

    it('includes -su when speedUp is true', () => {
      const args = buildWhisperArgs(
        { ...DEFAULT_WHISPER_CLI_OPTIONS, model: 'm', speedUp: true },
        'audio.wav',
      );
      expect(args).toContain('-su');
    });

    it('omits -oj when outputJson is false', () => {
      const args = buildWhisperArgs(
        { ...DEFAULT_WHISPER_CLI_OPTIONS, model: 'm', outputJson: false },
        'audio.wav',
      );
      expect(args).not.toContain('-oj');
    });
  });
});

/* ================================================================== *
 * WhisperAdapter (with MockWhisperBackend)
 * ================================================================== */

describe('WhisperAdapter', () => {
  let backend: MockWhisperBackend;
  let adapter: WhisperAdapter;

  beforeEach(() => {
    backend = new MockWhisperBackend();
    adapter = new WhisperAdapter(backend);
  });

  describe('initialize / transcribe / close lifecycle', () => {
    it('initialize loads the model via the backend', async () => {
      const opts: WhisperAdapterOptions = {
        language: 'en',
        beamSize: 5,
        speedUp: false,
      };
      await adapter.initialize('/models/base.bin', opts);
      expect(adapter.isInitialized).toBe(true);
      expect(backend.initCalls).toHaveLength(1);
      expect(backend.initCalls[0].modelPath).toBe('/models/base.bin');
      expect(backend.initCalls[0].options.language).toBe('en');
      expect(backend.initCalls[0].options.beamSize).toBe(5);
      expect(backend.initCalls[0].options.outputJson).toBe(true);
    });

    it('transcribe returns a TranscriptResult with confidence and segments', async () => {
      await adapter.initialize('/models/base.bin');
      const result = await adapter.transcribe([
        makeChunk('AAAA'),
        makeChunk('BBBB'),
      ]);
      expect(result.text).toBe('hello world');
      expect(result.language).toBe('en');
      expect(result.segments).toHaveLength(1);
      expect(result.segments[0].text).toBe('hello world');
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
      expect(backend.transcribeCalls).toHaveLength(1);
      expect(backend.transcribeCalls[0].length).toBeGreaterThan(0);
    });

    it('transcribe throws if not initialized', async () => {
      await expect(adapter.transcribe([makeChunk()])).rejects.toThrow(
        /not initialized/,
      );
    });

    it('close releases the backend and requires re-initialization', async () => {
      await adapter.initialize('/models/base.bin');
      await adapter.close();
      expect(adapter.isInitialized).toBe(false);
      expect(backend.closed).toBe(true);
      await expect(adapter.transcribe([makeChunk()])).rejects.toThrow(
        /not initialized/,
      );
    });
  });

  describe('isAvailable', () => {
    it('returns false before initialization', async () => {
      expect(await adapter.isAvailable()).toBe(false);
    });

    it('returns true after initialization when backend is available', async () => {
      await adapter.initialize('/models/base.bin');
      expect(await adapter.isAvailable()).toBe(true);
    });

    it('returns false when backend reports unavailable', async () => {
      await adapter.initialize('/models/base.bin');
      backend.available = false;
      expect(await adapter.isAvailable()).toBe(false);
    });
  });

  describe('error handling', () => {
    it('propagates backend transcribe errors', async () => {
      await adapter.initialize('/models/base.bin');
      backend.transcribeError = new Error('binary not found');
      await expect(adapter.transcribe([makeChunk()])).rejects.toThrow(
        'binary not found',
      );
    });

    it('propagates backend initialize errors', async () => {
      const failBackend = new MockWhisperBackend();
      failBackend.initialize = async (): Promise<void> => {
        throw new Error('model unreadable');
      };
      const failAdapter = new WhisperAdapter(failBackend);
      await expect(failAdapter.initialize('/bad.bin')).rejects.toThrow(
        'model unreadable',
      );
    });
  });

  describe('edge cases', () => {
    it('serializes concurrent transcribe calls (second waits for first)', async () => {
      await adapter.initialize('/models/base.bin');
      // Gate the first call so it stays in-flight while the second is queued.
      let resolveGate!: () => void;
      backend.transcribeGate = new Promise<void>((resolve) => {
        resolveGate = resolve;
      });
      const p1 = adapter.transcribe([makeChunk('AAAA')]);
      const p2 = adapter.transcribe([makeChunk('BBBB')]);
      // Only the first call should have reached the backend; the second is
      // waiting in the serialization queue.
      await vi.waitFor(() => expect(backend.transcribeCalls).toHaveLength(1));
      // Allow the first call to complete; the second should then run.
      resolveGate();
      const [r1, r2] = await Promise.all([p1, p2]);
      expect(backend.transcribeCalls).toHaveLength(2);
      expect(r1.text).toBe('hello world');
      expect(r2.text).toBe('hello world');
    });

    it('a failed transcribe does not block subsequent calls', async () => {
      await adapter.initialize('/models/base.bin');
      backend.transcribeError = new Error('transcribe failed');
      await expect(adapter.transcribe([makeChunk()])).rejects.toThrow(
        'transcribe failed',
      );
      // The chain should have recovered — a second call must still work.
      backend.transcribeError = null;
      const result = await adapter.transcribe([makeChunk()]);
      expect(result.text).toBe('hello world');
      expect(backend.transcribeCalls).toHaveLength(2);
    });

    it('transcribe handles an empty audio buffer gracefully', async () => {
      await adapter.initialize('/models/base.bin');
      const result = await adapter.transcribe([]);
      expect(result.text).toBe('');
      expect(result.confidence).toBe(0);
      expect(result.segments).toHaveLength(0);
      expect(result.language).toBe('');
      // The backend should not be invoked for an empty buffer.
      expect(backend.transcribeCalls).toHaveLength(0);
    });
  });

  describe('confidence derivation', () => {
    it('segmentConfidence converts logprob to [0,1] probability', () => {
      const conf = segmentConfidence({
        id: 0,
        start: 0,
        end: 1,
        text: 'hi',
        tokens: [],
        temperature: 0,
        avg_logprob: 0,
        compression_ratio: 1,
        no_speech_prob: 0,
      });
      expect(conf).toBeCloseTo(1, 5);
    });

    it('segmentConfidence discounts silence probability', () => {
      const conf = segmentConfidence({
        id: 0,
        start: 0,
        end: 1,
        text: 'hi',
        tokens: [],
        temperature: 0,
        avg_logprob: 0,
        compression_ratio: 1,
        no_speech_prob: 0.5,
      });
      expect(conf).toBeCloseTo(0.5, 5);
    });

    it('segmentConfidence penalises high compression ratio', () => {
      const conf = segmentConfidence({
        id: 0,
        start: 0,
        end: 1,
        text: 'hi',
        tokens: [],
        temperature: 0,
        avg_logprob: 0,
        compression_ratio: 4,
        no_speech_prob: 0,
      });
      expect(conf).toBeCloseTo(0.25, 5);
    });

    it('overallConfidence returns 0 for no segments', () => {
      expect(overallConfidence([])).toBe(0);
    });

    it('overallConfidence weights by segment duration', () => {
      const segments = [
        {
          id: 0,
          start: 0,
          end: 2,
          text: 'a',
          tokens: [],
          temperature: 0,
          avg_logprob: 0,
          compression_ratio: 1,
          no_speech_prob: 0,
        },
        {
          id: 1,
          start: 2,
          end: 3,
          text: 'b',
          tokens: [],
          temperature: 0,
          avg_logprob: -1,
          compression_ratio: 1,
          no_speech_prob: 0,
        },
      ];
      const overall = overallConfidence(segments);
      const expected = (2 * 1 + 1 * Math.exp(-1)) / 3;
      expect(overall).toBeCloseTo(expected, 4);
    });
  });

  describe('concatAudioChunks', () => {
    it('concatenates base64 PCM chunks into one buffer', () => {
      const buf = concatAudioChunks([makeChunk('AAAA'), makeChunk('BBBB')]);
      expect(buf.length).toBe(6);
    });

    it('returns an empty buffer for no chunks', () => {
      expect(concatAudioChunks([]).length).toBe(0);
    });
  });
});

/* ================================================================== *
 * WhisperCppBackend (via MockProcessRunner + real temp files)
 * ================================================================== */

describe('WhisperCppBackend (via MockProcessRunner)', () => {
  let tempDir: string;
  let modelPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'florina-whisper-test-'));
    modelPath = join(tempDir, 'model.bin');
    await writeFile(modelPath, 'fake-model');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('transcribe spawns the binary and parses JSON output', async () => {
    const runner = new MockProcessRunner();
    runner.nextStdout = sampleWhisperJson('transcribed text');
    const backend = new WhisperCppBackend({ runner, tempDir });
    await backend.initialize(modelPath, {
      ...DEFAULT_WHISPER_CLI_OPTIONS,
      model: modelPath,
    });
    const result = await backend.transcribe(Buffer.from('audio'));
    expect(result.text).toBe('transcribed text');
    expect(runner.runCalls).toHaveLength(1);
    expect(runner.runCalls[0].command).toBe('whisper-cli');
    expect(runner.runCalls[0].args).toContain(modelPath);
  });

  it('throws when the model file does not exist', async () => {
    const runner = new MockProcessRunner();
    const backend = new WhisperCppBackend({ runner, tempDir });
    await expect(
      backend.initialize(join(tempDir, 'nope.bin'), {
        ...DEFAULT_WHISPER_CLI_OPTIONS,
        model: join(tempDir, 'nope.bin'),
      }),
    ).rejects.toThrow(/model not found/);
  });

  it('throws ProcessNotFoundError when the binary is missing', async () => {
    const runner = new MockProcessRunner();
    runner.nextError = new ProcessNotFoundError('whisper-cli');
    const backend = new WhisperCppBackend({ runner, tempDir });
    await backend.initialize(modelPath, {
      ...DEFAULT_WHISPER_CLI_OPTIONS,
      model: modelPath,
    });
    await expect(backend.transcribe(Buffer.from('audio'))).rejects.toThrow(
      /Binary not found/,
    );
  });

  it('throws on non-zero exit code', async () => {
    const runner = new MockProcessRunner();
    runner.nextStdout = '';
    runner.nextStderr = 'model load failed';
    runner.nextExitCode = 1;
    const backend = new WhisperCppBackend({ runner, tempDir });
    await backend.initialize(modelPath, {
      ...DEFAULT_WHISPER_CLI_OPTIONS,
      model: modelPath,
    });
    await expect(backend.transcribe(Buffer.from('audio'))).rejects.toThrow(
      /exited with code 1/,
    );
  });

  it('throws on invalid JSON output', async () => {
    const runner = new MockProcessRunner();
    runner.nextStdout = 'garbage';
    const backend = new WhisperCppBackend({ runner, tempDir });
    await backend.initialize(modelPath, {
      ...DEFAULT_WHISPER_CLI_OPTIONS,
      model: modelPath,
    });
    await expect(backend.transcribe(Buffer.from('audio'))).rejects.toThrow(
      /invalid JSON/,
    );
  });

  it('throws ProcessTimeoutError via runner timeout', async () => {
    const runner = new MockProcessRunner();
    runner.nextError = new ProcessTimeoutError('whisper-cli', 100);
    const backend = new WhisperCppBackend({ runner, tempDir });
    await backend.initialize(modelPath, {
      ...DEFAULT_WHISPER_CLI_OPTIONS,
      model: modelPath,
    });
    await expect(backend.transcribe(Buffer.from('audio'))).rejects.toThrow(
      /timed out/,
    );
  });

  it('isAvailable returns true after initialization', async () => {
    const backend = new WhisperCppBackend({
      runner: new MockProcessRunner(),
      tempDir,
    });
    expect(await backend.isAvailable()).toBe(false);
    await backend.initialize(modelPath, {
      ...DEFAULT_WHISPER_CLI_OPTIONS,
      model: modelPath,
    });
    expect(await backend.isAvailable()).toBe(true);
  });

  it('close clears initialized state', async () => {
    const backend = new WhisperCppBackend({
      runner: new MockProcessRunner(),
      tempDir,
    });
    await backend.initialize(modelPath, {
      ...DEFAULT_WHISPER_CLI_OPTIONS,
      model: modelPath,
    });
    await backend.close();
    expect(await backend.isAvailable()).toBe(false);
  });
});

/* ================================================================== *
 * VoicePipeline — failover + recovery + unified transcript
 * ================================================================== */

describe('VoicePipeline', () => {
  let audio: MockAudioTransport;
  let sockets: MockSocket[];
  let factory: SocketFactory;
  let bridge: RealtimeBridge;
  let whisperBackend: MockWhisperBackend;
  let whisperAdapter: WhisperAdapter;
  let pipeline: VoicePipeline;

  beforeEach(() => {
    audio = new MockAudioTransport();
    sockets = [];
    factory = mockFactory(sockets);
    bridge = new RealtimeBridge(audio, factory);
    whisperBackend = new MockWhisperBackend();
    whisperAdapter = new WhisperAdapter(whisperBackend);
    pipeline = new VoicePipeline(bridge, whisperAdapter, {
      recoveryIntervalMs: 50,
    });
  });

  /** Drive the bridge through a successful connect (open + session.created). */
  async function connectBridge(): Promise<void> {
    const connectPromise = bridge.connect('test-key');
    sockets[0].emitOpen();
    sockets[0].emitMessage({
      type: 'session.created',
      session: { id: 'sess-1' } as never,
    });
    await connectPromise;
  }

  it('starts in realtime mode and reports state', async () => {
    await connectBridge();
    await pipeline.start();
    expect(pipeline.currentMode).toBe('realtime');
    const state = pipeline.getState();
    expect(state.mode).toBe('realtime');
    expect(state.realtimeConnected).toBe(true);
    expect(state.whisperAvailable).toBe(false);
  });

  it('forwards realtime transcripts through the unified callback', async () => {
    await connectBridge();
    await pipeline.start();
    const events: PipelineTranscriptEvent[] = [];
    pipeline.onTranscript((e) => events.push(e));
    sockets[0].emitMessage({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'hello from realtime',
    });
    expect(events).toHaveLength(1);
    expect(events[0].source).toBe('realtime');
    expect(events[0].text).toBe('hello from realtime');
    expect(events[0].partial).toBe(false);
  });

  it('fails over to whisper on realtime disconnect', async () => {
    await connectBridge();
    await pipeline.start();
    const modeChanges: string[] = [];
    pipeline.onModeChange((m) => modeChanges.push(m));
    // Simulate an unexpected close (not intentional disconnect). The
    // failover is debounced, so wait for the mode switch to settle.
    sockets[0].emitClose(1006, 'abnormal');
    await vi.waitFor(() => expect(pipeline.currentMode).toBe('whisper'));
    expect(modeChanges).toContain('whisper');
  });

  it('does not fail over when autoFailover is disabled', async () => {
    pipeline = new VoicePipeline(bridge, whisperAdapter, {
      autoFailover: false,
      recoveryIntervalMs: 50,
    });
    await connectBridge();
    await pipeline.start();
    sockets[0].emitClose(1006, 'abnormal');
    expect(pipeline.currentMode).toBe('realtime');
  });

  it('recovers back to realtime on reconnect', async () => {
    await connectBridge();
    await pipeline.start();
    // Disconnect -> whisper (debounced).
    sockets[0].emitClose(1006, 'abnormal');
    await vi.waitFor(() => expect(pipeline.currentMode).toBe('whisper'));
    // Reconnect: the bridge schedules a reconnect internally; drive the new
    // socket open + session.created. The bridge's reconnect uses the same
    // factory, so sockets[1] is the new connection.
    await vi.waitFor(() => expect(sockets.length).toBeGreaterThanOrEqual(2));
    sockets[1].emitOpen();
    sockets[1].emitMessage({
      type: 'session.created',
      session: { id: 'sess-2' } as never,
    });
    // The pipeline should recover to realtime once the bridge is connected.
    await vi.waitFor(() => expect(pipeline.currentMode).toBe('realtime'));
  });

  it('emits whisper transcripts via transcribeWithWhisper', async () => {
    await whisperAdapter.initialize('/models/base.bin');
    await pipeline.start();
    const events: PipelineTranscriptEvent[] = [];
    pipeline.onTranscript((e) => events.push(e));
    await pipeline.transcribeWithWhisper([makeChunk()]);
    expect(events).toHaveLength(1);
    expect(events[0].source).toBe('whisper');
    expect(events[0].text).toBe('hello world');
    expect(events[0].partial).toBe(false);
    expect(events[0].confidence).toBeGreaterThan(0);
  });

  it('preserves the WhisperAdapter result type through the generic pipeline', async () => {
    await whisperAdapter.initialize('/models/base.bin');
    const inferred = new VoicePipeline(bridge, whisperAdapter);
    // Compile-time proof: constructing the pipeline with WhisperAdapter infers
    // its richer TranscriptResult — required `segments` and `language`.
    expectTypeOf(inferred.transcribeWithWhisper).returns.resolves
      .toEqualTypeOf<TranscriptResult>();
    const result = await inferred.transcribeWithWhisper([makeChunk()]);
    expect(result.segments[0].text).toBe('hello world');
    expect(result.language).toBe('en');
    const segment: TranscriptSegment = result.segments[0];
    expect(segment.confidence).toBeGreaterThan(0);
  });

  it('switchToWhisper forces whisper mode', async () => {
    await connectBridge();
    await pipeline.start();
    pipeline.switchToWhisper();
    expect(pipeline.currentMode).toBe('whisper');
  });

  it('stop moves to offline mode and unwires callbacks', async () => {
    await connectBridge();
    await pipeline.start();
    const events: PipelineTranscriptEvent[] = [];
    pipeline.onTranscript((e) => events.push(e));
    pipeline.stop();
    expect(pipeline.currentMode).toBe('offline');
    // After stop, realtime transcripts are no longer forwarded.
    sockets[0].emitMessage({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'ignored',
    });
    expect(events).toHaveLength(0);
  });

  it('getState reflects whisper availability after initialization', async () => {
    await connectBridge();
    await pipeline.start();
    await whisperAdapter.initialize('/models/base.bin');
    const state = pipeline.getState();
    expect(state.whisperAvailable).toBe(true);
  });

  it('rapid switchToWhisper -> attemptRecovery is safe', async () => {
    await connectBridge();
    await pipeline.start();
    // Rapid back-to-back manual mode switches must not throw or leave the
    // pipeline in an inconsistent state.
    expect(() => {
      pipeline.switchToWhisper();
      pipeline.attemptRecovery();
      pipeline.switchToWhisper();
      pipeline.attemptRecovery();
    }).not.toThrow();
    // Bridge is connected, so the last attemptRecovery recovers to realtime.
    expect(pipeline.currentMode).toBe('realtime');
  });

  it('does not start the recovery probe when autoRecover is disabled', async () => {
    pipeline = new VoicePipeline(bridge, whisperAdapter, {
      autoRecover: false,
      recoveryIntervalMs: 50,
    });
    await connectBridge();
    await pipeline.start();
    const modeChanges: string[] = [];
    pipeline.onModeChange((m) => modeChanges.push(m));
    // Disconnect — should fail over to whisper but NOT start a recovery timer.
    sockets[0].emitClose(1006, 'abnormal');
    await vi.waitFor(() => expect(pipeline.currentMode).toBe('whisper'));
    // Wait well beyond the recovery interval; with autoRecover disabled the
    // pipeline must not probe, so it stays in whisper even if the bridge
    // reconnects on its own.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(pipeline.currentMode).toBe('whisper');
    expect(modeChanges).not.toContain('realtime');
  });

  it('debounces rapid connect/disconnect flapping', async () => {
    await connectBridge();
    await pipeline.start();
    // Rapid close -> reconnect-open -> close should be coalesced: only the
    // most recent state transition within the debounce window wins.
    sockets[0].emitClose(1006, 'abnormal');
    // Immediately drive a reconnect (new socket) before the debounce fires.
    await vi.waitFor(() => expect(sockets.length).toBeGreaterThanOrEqual(2));
    sockets[1].emitOpen();
    sockets[1].emitMessage({
      type: 'session.created',
      session: { id: 'sess-2' } as never,
    });
    // After the dust settles the pipeline should end in realtime (connected).
    await vi.waitFor(() => expect(pipeline.currentMode).toBe('realtime'));
  });
});
