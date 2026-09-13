/**
 * Voice session manager — the inbound voice surface that drives the typed
 * command API from spoken interaction (DEC-021, DEC-002, issue #93).
 *
 * {@link VoiceSessionManager} owns the lifecycle of a {@link VoicePipeline}
 * within the host process. It:
 * - Connects an injected {@link RealtimeSessionPort} engine configured with
 *   the typed Secretary tool definitions.
 * - Routes {@link ToolCallEvent}s from the voice model to
 *   {@link CommandExecutor.execute}, returning the result as a tool call
 *   output.
 * - Surfaces spoken transcripts and state changes via callbacks for the
 *   CLI / desktop to display.
 * - Enforces DEC-010/DEC-011: the voice model only sees typed tool
 *   definitions, never arbitrary shell access. All tool calls go through
 *   the same typed command API as the CLI.
 *
 * The manager is runtime-agnostic: the engine, the
 * {@link AudioTransport} (mic capture / playback), and the transcription
 * engine are injected — concrete combinations are composed in
 * `src/bootstrap/voice-session.ts`; tests inject fakes.
 */
import type {
  AudioTransport,
  RealtimeSessionOptions,
  RealtimeSessionPort,
  ToolCallEvent,
  TranscriptionPort,
  VoiceToolDefinition,
} from '../../../core/application/ports/outbound/voice.js';
import { VoiceSessionState } from '../../../core/application/ports/outbound/voice.js';
import type { CommandExecutor } from '../../../core/application/use-cases/tasks/command-api.js';
import { VoicePipeline } from '../../../core/application/use-cases/voice/voice-pipeline.js';
import type { VoicePipelineMode } from '../../../core/application/use-cases/voice/voice-pipeline.js';
import {
  buildDefaultVoiceTools,
  DEFAULT_VOICE_INSTRUCTIONS,
  mapToolCallToCommand,
} from './voice-tools.js';

export type { CommandExecutor } from '../../../core/application/use-cases/tasks/command-api.js';

/** Callback fired when a spoken transcript is received. */
export type VoiceTranscriptCallback = (text: string, partial: boolean) => void;

/** Callback fired when the pipeline mode changes. */
export type VoiceModeCallback = (mode: VoicePipelineMode) => void;

/** Callback fired when a tool call is executed and its result is returned. */
export type VoiceToolCallCallback = (name: string, success: boolean, result: unknown) => void;

/** Callback fired when the voice session state changes. */
export type VoiceStateCallback = (state: VoiceSessionState) => void;

/** Options for constructing a {@link VoiceSessionManager}. */
export interface VoiceSessionManagerOptions {
  /** The provider API key for the realtime session. */
  readonly apiKey: string;
  /** Audio transport (mic capture / playback) — closed on {@link stop}. */
  readonly audioTransport: AudioTransport;
  /** The realtime voice engine, composed by the caller. */
  readonly bridge: RealtimeSessionPort;
  /** Transcription engine for the local fallback path. */
  readonly whisperAdapter: TranscriptionPort;
  /** The typed command API — tool calls are routed here. */
  readonly commandApi: CommandExecutor;
  /** Realtime session options (model, voice, instructions, ...). */
  readonly bridgeOptions?: Omit<RealtimeSessionOptions, 'tools'>;
  /** Override the default tool definitions. */
  readonly tools?: readonly VoiceToolDefinition[];
}

/**
 * Manages the voice session lifecycle within the host process.
 *
 * Typical usage (composition root):
 * ```ts
 * const manager = new VoiceSessionManager({
 *   apiKey: process.env.OPENAI_API_KEY,
 *   audioTransport: new StdinAudioTransport(),
 *   bridge: new RealtimeBridge(audioTransport, defaultSocketFactory),
 *   whisperAdapter: new WhisperAdapter(new WhisperCppBackend()),
 *   commandApi: daemon.commandApi,
 * });
 * await manager.start();
 * manager.onTranscript((text, partial) => console.log(text));
 * // ... later
 * await manager.stop();
 * ```
 */
export class VoiceSessionManager {
  private readonly options: VoiceSessionManagerOptions;
  private pipeline: VoicePipeline | null = null;

  private readonly transcriptCallbacks: VoiceTranscriptCallback[] = [];
  private readonly modeCallbacks: VoiceModeCallback[] = [];
  private readonly toolCallCallbacks: VoiceToolCallCallback[] = [];
  private readonly stateCallbacks: VoiceStateCallback[] = [];

  constructor(options: VoiceSessionManagerOptions) {
    this.options = options;
  }

  /** Current pipeline mode ('realtime', 'whisper', or 'offline'). */
  get currentMode(): VoicePipelineMode | null {
    return this.pipeline?.currentMode ?? null;
  }

  /** Whether the realtime connection is currently open. */
  get realtimeConnected(): boolean {
    return this.options.bridge.isConnected;
  }

  /**
   * Start the voice session: connect the engine to the realtime API and
   * start the pipeline in realtime mode.
   */
  async start(): Promise<void> {
    const bridge = this.options.bridge;
    const tools = this.options.tools ?? buildDefaultVoiceTools();
    const sessionOptions: RealtimeSessionOptions = {
      ...this.options.bridgeOptions,
      tools,
      instructions: this.options.bridgeOptions?.instructions ?? DEFAULT_VOICE_INSTRUCTIONS,
    };

    // Wire engine callbacks.
    bridge.onTranscript((event) => {
      for (const cb of this.transcriptCallbacks) {
        cb(event.text, event.partial);
      }
    });
    bridge.onStateChange((event) => {
      for (const cb of this.stateCallbacks) {
        cb(event.to);
      }
    });
    bridge.onToolCall((event) => {
      void this.handleToolCall(event);
    });

    // Connect the realtime session.
    await bridge.connect(this.options.apiKey, sessionOptions);

    // Construct and start the pipeline.
    this.pipeline = new VoicePipeline(bridge, this.options.whisperAdapter);
    this.pipeline.onTranscript((event) => {
      // The pipeline forwards both realtime and whisper transcripts.
      // The bridge callback above already handles realtime; this catches
      // whisper-mode transcripts.
      if (event.source === 'whisper') {
        for (const cb of this.transcriptCallbacks) {
          cb(event.text, event.partial);
        }
      }
    });
    this.pipeline.onModeChange((mode) => {
      for (const cb of this.modeCallbacks) {
        cb(mode);
      }
    });
    await this.pipeline.start();
  }

  /**
   * Begin capturing audio (push-to-talk). Audio is sent to the realtime
   * engine.
   */
  startListening(): void {
    this.options.bridge.startListening();
  }

  /**
   * Stop capturing audio and commit the input buffer. In PTT mode this
   * triggers the model's response.
   */
  stopListening(): void {
    this.options.bridge.stopListening();
  }

  /**
   * Shut down the voice session: stop the pipeline, disconnect the engine,
   * and close the audio transport.
   */
  async stop(): Promise<void> {
    this.pipeline?.stop();
    this.pipeline = null;
    await this.options.bridge.disconnect();
    this.options.audioTransport.close();
  }

  /** Register a transcript callback. Returns an unsubscribe function. */
  onTranscript(callback: VoiceTranscriptCallback): () => void {
    this.transcriptCallbacks.push(callback);
    return () => this.removeItem(this.transcriptCallbacks, callback);
  }

  /** Register a mode-change callback. Returns an unsubscribe function. */
  onModeChange(callback: VoiceModeCallback): () => void {
    this.modeCallbacks.push(callback);
    return () => this.removeItem(this.modeCallbacks, callback);
  }

  /** Register a tool-call callback. Returns an unsubscribe function. */
  onToolCall(callback: VoiceToolCallCallback): () => void {
    this.toolCallCallbacks.push(callback);
    return () => this.removeItem(this.toolCallCallbacks, callback);
  }

  /** Register a state-change callback. Returns an unsubscribe function. */
  onStateChange(callback: VoiceStateCallback): () => void {
    this.stateCallbacks.push(callback);
    return () => this.removeItem(this.stateCallbacks, callback);
  }

  /* ---------------------------------------------------------------- *
   * Tool call routing
   * ---------------------------------------------------------------- */

  /**
   * Handle a tool call from the voice model: map it to a typed
   * {@link Command}, execute it via the command API, and return the result
   * to the engine as a tool call output.
   *
   * Per DEC-011, the voice model never executes arbitrary commands — only
   * the typed tools defined in {@link buildDefaultVoiceTools}. Unknown tool
   * names return an error without executing anything.
   */
  private async handleToolCall(event: ToolCallEvent): Promise<void> {
    const { callId, name, arguments: argsJson } = event;
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(argsJson) as Record<string, unknown>;
    } catch {
      this.options.bridge.sendToolCallOutput(
        callId,
        JSON.stringify({ error: 'Invalid JSON arguments' }),
      );
      this.notifyToolCall(name, false, { error: 'Invalid JSON arguments' });
      return;
    }

    const command = mapToolCallToCommand(name, args);
    if (command === null) {
      const errorMsg = `Unknown tool: ${name}`;
      this.options.bridge.sendToolCallOutput(callId, JSON.stringify({ error: errorMsg }));
      this.notifyToolCall(name, false, { error: errorMsg });
      return;
    }

    try {
      const response = await this.options.commandApi.execute(command);
      const result = response.ok ? response : { ok: false, error: (response as { error?: string }).error ?? 'Unknown error' };
      this.options.bridge.sendToolCallOutput(callId, JSON.stringify(result));
      this.notifyToolCall(name, response.ok, result);
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      this.options.bridge.sendToolCallOutput(callId, JSON.stringify({ error: errorMsg }));
      this.notifyToolCall(name, false, { error: errorMsg });
    }
  }

  private notifyToolCall(name: string, success: boolean, result: unknown): void {
    for (const cb of this.toolCallCallbacks) {
      cb(name, success, result);
    }
  }

  private removeItem<T>(list: T[], item: T): void {
    const idx = list.indexOf(item);
    if (idx >= 0) {
      list.splice(idx, 1);
    }
  }
}
