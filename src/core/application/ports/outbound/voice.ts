/**
 * Voice data/device port — provider-neutral audio boundary (DEC-021,
 * issue #92).
 *
 * The voice pipeline never touches audio hardware directly. It goes through
 * the pluggable {@link AudioTransport} interface so the realtime logic is
 * fully testable without a microphone or speakers. In production this is
 * backed by WebRTC / a local audio device; in tests a mock implementation
 * feeds predetermined chunks and records what would be played back.
 */

/* ================================================================== *
 * Audio data
 * ================================================================== */

/**
 * A chunk of PCM audio data captured or played back by an
 * {@link AudioTransport}.
 *
 * `pcm` is carried as a Base64-encoded PCM string — the common
 * representation at the audio boundary. Provider adapters map it to their
 * own wire protocols (e.g. a Realtime API expects Base64 PCM16 at 24 kHz
 * mono); the port itself is provider-neutral.
 */
export interface AudioChunk {
  /** PCM samples as a Base64-encoded string (the audio-boundary encoding). */
  readonly pcm: string;
  /** Sample rate in Hz (e.g. 24000). */
  readonly sampleRate: number;
  /** Number of audio channels (1 = mono). */
  readonly channels: number;
}

/* ================================================================== *
 * AudioTransport — pluggable capture / playback
 * ================================================================== */

/**
 * Pluggable audio capture/playback abstraction.
 *
 * Implementations:
 * - **Production**: a WebRTC-backed transport that reads from the local
 *   microphone and writes to the speakers.
 * - **Tests**: a mock that feeds predetermined chunks via `startCapture`
 *   and records playback calls.
 *
 * The bridge calls `startCapture` when entering the `Listening` state and
 * `stopCapture` when leaving it. Incoming AI audio is handed to `play`.
 */
export interface AudioTransport {
  /**
   * Begin capturing audio. Each captured {@link AudioChunk} is delivered to
   * `onChunk` until {@link AudioTransport.stopCapture} is called.
   */
  startCapture(onChunk: (chunk: AudioChunk) => void): void;
  /** Stop capturing audio. No-op if capture is not active. */
  stopCapture(): void;
  /** Play back a PCM chunk (AI response audio). */
  play(chunk: AudioChunk): void;
  /** Stop any ongoing playback. */
  stopPlayback(): void;
  /** Release any hardware resources held by this transport. */
  close(): void;
}

/* ================================================================== *
 * Voice session state machine
 * ================================================================== */

/**
 * Voice session states — the bridge's state machine (DEC-021).
 *
 * The canonical happy-path transition is:
 * ```
 * Idle -> Connecting -> Listening -> Processing -> Responding -> Idle
 * ```
 * Any state may transition to `Error` on a fatal fault; reconnection moves
 * back through `Connecting`.
 */
export const VoiceSessionState = {
  Idle: 'idle',
  Connecting: 'connecting',
  Listening: 'listening',
  Processing: 'processing',
  Responding: 'responding',
  Error: 'error',
} as const;

export type VoiceSessionState =
  (typeof VoiceSessionState)[keyof typeof VoiceSessionState];

/* ================================================================== *
 * Voice events
 * ================================================================== */

/**
 * A transcript of spoken text. `partial` transcripts are interim (streaming);
 * a `partial: false` transcript is the final, committed rendering.
 */
export interface TranscriptEvent {
  /** Whether this is a partial (interim) or final transcript. */
  readonly partial: boolean;
  /** The transcribed text. */
  readonly text: string;
}

/**
 * An AI response event — carries either streamed text, an audio chunk, or
 * both. `partial` events are deltas; a `partial: false` event marks the end
 * of the response.
 */
export interface ResponseEvent {
  /** Partial (delta) or final response. */
  readonly partial: boolean;
  /** Text delta / final text (if any). */
  readonly text?: string;
  /** Audio chunk (if any). */
  readonly audio?: AudioChunk;
}

/**
 * A tool call requested by the voice model. The bridge emits this when it
 * receives a `function_call` conversation item so the host can execute the
 * named tool and return the result via the bridge's tool-call output path
 * (DEC-021).
 */
export interface ToolCallEvent {
  /** Correlation id linking the call to its output. */
  readonly callId: string;
  /** Name of the tool to invoke. */
  readonly name: string;
  /** JSON-encoded arguments string. */
  readonly arguments: string;
}

/** A voice pipeline error. */
export interface VoiceErrorEvent {
  readonly message: string;
  readonly code?: string;
}

/** A state transition in the voice session. */
export interface VoiceStateChangeEvent {
  readonly from: VoiceSessionState;
  readonly to: VoiceSessionState;
}

/**
 * Union of all events emitted by the voice pipeline. The bridge fans these
 * out to the per-category callbacks (`onTranscript`, `onResponse`, etc.).
 */
export type VoiceEvent =
  | { readonly type: 'transcript'; readonly transcript: TranscriptEvent }
  | { readonly type: 'response'; readonly response: ResponseEvent }
  | { readonly type: 'error'; readonly error: VoiceErrorEvent }
  | { readonly type: 'state'; readonly state: VoiceStateChangeEvent };

/* ================================================================== *
 * Voice engine ports (issue #93)
 * ================================================================== */

/**
 * A completed speech-to-text transcription. Unlike a streaming
 * {@link TranscriptEvent}, this is a single final result — an engine
 * transcribes a full audio buffer at once.
 */
export interface TranscriptResult {
  /** Full transcribed text. */
  readonly text: string;
  /** Overall confidence in [0, 1]. */
  readonly confidence: number;
  /** Detected / forced language code, when the engine reports one. */
  readonly language?: string;
  /** Transcription wall-clock duration, when the engine reports it. */
  readonly durationMs?: number;
}

/**
 * The realtime (streaming) voice engine boundary. The application invokes
 * the concrete bridge through this port so the pipeline stays
 * provider-neutral.
 */
export interface RealtimeVoicePort {
  /** Current session state of the realtime engine. */
  readonly currentState: VoiceSessionState;
  /** Whether the realtime connection is currently open. */
  readonly isConnected: boolean;
  /** Subscribe to transcript events. Returns an unsubscribe function. */
  onTranscript(callback: (event: TranscriptEvent) => void): () => void;
  /** Subscribe to session-state changes. Returns an unsubscribe function. */
  onStateChange(callback: (event: VoiceStateChangeEvent) => void): () => void;
}

/* ================================================================== *
 * Realtime session port — lifecycle + tool calls (issue #93)
 * ================================================================== */

/**
 * A typed tool definition exposed to the voice model. This is the
 * provider-neutral shape of a function-calling tool: a name, a
 * description, and a JSON-Schema-ish parameters object. The concrete
 * engine adapter maps it onto its own wire schema (e.g. a Realtime API
 * session `tools` entry).
 */
export interface VoiceToolDefinition {
  /** Tool kind discriminator — voice surfaces expose function tools only. */
  readonly type: 'function';
  /** The name the model calls the tool by (e.g. `list_tasks`). */
  readonly name: string;
  /** Human- and model-readable description of what the tool does. */
  readonly description?: string;
  /** JSON-Schema-ish parameters object for the tool's arguments. */
  readonly parameters?: Readonly<Record<string, unknown>>;
}

/**
 * Provider-neutral realtime session configuration passed to
 * {@link RealtimeSessionPort.connect}. The engine adapter maps these onto
 * its own session-update message; fields that have no provider analogue
 * are ignored by that adapter.
 */
export interface RealtimeSessionOptions {
  /** Engine model id. */
  readonly model?: string;
  /** Voice selection for synthesized responses. */
  readonly voice?: string;
  /** System prompt / persona instructions. */
  readonly instructions?: string;
  /** Typed tool definitions the model may invoke. */
  readonly tools?: readonly VoiceToolDefinition[];
  /** Audio sample rate in Hz. */
  readonly sampleRate?: number;
  /** Audio channel count (1 = mono). */
  readonly channels?: number;
  /** Provider endpoint override (primarily for testing). */
  readonly baseUrl?: string;
  /** Auto-reconnect on unexpected close. */
  readonly autoReconnect?: boolean;
  /** Max reconnection attempts before giving up. */
  readonly maxReconnectAttempts?: number;
  /** Reconnect backoff base delay in ms. */
  readonly reconnectBaseDelayMs?: number;
}

/**
 * The full realtime voice session boundary: connection lifecycle,
 * push-to-talk capture control, and the tool-call channel — in addition
 * to the streaming surface of {@link RealtimeVoicePort}.
 *
 * Inbound voice adapters (the voice session manager) drive the engine
 * through this port; the narrower {@link RealtimeVoicePort} remains the
 * boundary the voice pipeline needs.
 */
export interface RealtimeSessionPort extends RealtimeVoicePort {
  /**
   * Open the realtime session. Resolves once the session is established
   * and configured; rejects on connection failure.
   */
  connect(apiKey: string, options?: RealtimeSessionOptions): Promise<void>;
  /** Close the session and release connection resources. */
  disconnect(): Promise<void>;
  /** Begin capturing audio (push-to-talk). */
  startListening(): void;
  /** Stop capturing and commit the input buffer. */
  stopListening(): void;
  /** Return a tool call result to the model (JSON-encoded payload). */
  sendToolCallOutput(callId: string, output: string): void;
  /** Subscribe to tool calls requested by the model. */
  onToolCall(callback: (event: ToolCallEvent) => void): () => void;
}

/**
 * The offline/batch transcription engine boundary (e.g. a local whisper
 * backend). The application calls {@link TranscriptionPort.transcribe} with
 * captured {@link AudioChunk}s and receives one final result.
 *
 * `TResult` lets a concrete engine expose a richer result type (e.g.
 * per-segment timings) while still satisfying the port — consumers that
 * only need the provider-neutral contract default to
 * {@link TranscriptResult}.
 */
export interface TranscriptionPort<
  TResult extends TranscriptResult = TranscriptResult,
> {
  /** Whether the engine has been initialized. */
  readonly isInitialized: boolean;
  /** Transcribe a batch of audio chunks into a final result. */
  transcribe(chunks: readonly AudioChunk[]): Promise<TResult>;
  /** Whether the engine is usable in this environment. */
  isAvailable(): Promise<boolean>;
  /** Release engine resources. */
  close(): Promise<void>;
}
