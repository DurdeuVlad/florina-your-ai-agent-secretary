/**
 * Realtime voice bridge — OpenAI Realtime API client (DEC-021).
 *
 * {@link RealtimeBridge} connects to the OpenAI Realtime API over WebSocket,
 * streams audio in push-to-talk (PTT) mode, and surfaces transcription and
 * AI response events via callbacks. Audio capture/playback is delegated to a
 * pluggable {@link AudioTransport} and the WebSocket is created through an
 * injectable {@link SocketFactory}, so the entire realtime logic is testable
 * without a microphone, speakers, or a real network connection.
 *
 * State machine (DEC-021):
 * ```
 * Idle -> Connecting -> Listening -> Processing -> Responding -> Idle
 * ```
 * Any state may transition to `Error`; reconnection moves back through
 * `Connecting`.
 *
 * Security (DEC-011): the voice model is given only the Florina's typed
 * tool definitions (`start_task`, `get_inbox`, `approve_permission`, ...).
 * Spoken intent triggers tool calls executed on the localhost daemon; the
 * voice model never executes arbitrary shell commands directly.
 */
import { WebSocket } from 'ws';

import type {
  AudioChunk,
  AudioTransport,
  ResponseEvent,
  ToolCallEvent,
  RealtimeSessionPort,
  TranscriptEvent,
  VoiceErrorEvent,
  VoiceSessionState,
  VoiceStateChangeEvent,
} from '../../../core/application/ports/outbound/voice.js';
import { VoiceSessionState as State } from '../../../core/application/ports/outbound/voice.js';
import type {
  ClientMessage,
  RealtimeSessionConfig,
  RealtimeTool,
  ServerMessage,
} from './realtime-message.js';
import {
  decodeServerMessage,
  encodeClientMessage,
  isFunctionCallItem,
} from './realtime-message.js';

/* ================================================================== *
 * Pluggable WebSocket transport
 * ================================================================== */

/**
 * Minimal event-driven socket interface the bridge depends on.
 *
 * `ws`'s `WebSocket` satisfies this interface, so {@link defaultSocketFactory}
 * is a trivial adapter. Tests inject a mock factory returning a fake socket.
 */
export interface RealtimeSocket {
  /** Current ready state (mirrors WebSocket.CONNECTING/OPEN/CLOSING/CLOSED). */
  readonly readyState: number;
  /** The OPEN ready-state constant (1). */
  readonly OPEN: number;
  /** Send a text frame. */
  send(data: string): void;
  /** Close the connection. */
  close(code?: number, reason?: string): void;
  /** Register an event listener. Returns `this` for chaining. */
  on(event: 'open' | 'message' | 'close' | 'error', listener: (...args: unknown[]) => void): this;
  /** Remove a previously-registered listener. Returns `this` for chaining. */
  off(event: 'open' | 'message' | 'close' | 'error', listener: (...args: unknown[]) => void): this;
}

/**
 * Factory that opens a WebSocket connection to a URL with the given headers.
 * Injected so tests can supply a mock socket instead of a real network call.
 */
export type SocketFactory = (url: string, headers: Record<string, string>) => RealtimeSocket;

/**
 * Default {@link SocketFactory} backed by the `ws` package. Used in
 * production; tests inject their own factory.
 */
export function defaultSocketFactory(url: string, headers: Record<string, string>): RealtimeSocket {
  return new WebSocket(url, { headers }) as unknown as RealtimeSocket;
}

/* ================================================================== *
 * Configuration
 * ================================================================== */

/** Default Realtime API model id. */
export const DEFAULT_REALTIME_MODEL = 'gpt-realtime';
/** GA realtime transcription model for dictation sessions (issue #161). */
export const DEFAULT_TRANSCRIPTION_MODEL = 'gpt-4o-transcribe';

/** Default audio sample rate (Realtime API expects 24 kHz). */
export const DEFAULT_SAMPLE_RATE = 24000;

/** Default number of audio channels (mono). */
export const DEFAULT_CHANNELS = 1;

/** Default base URL for the Realtime API WebSocket endpoint. */
export const DEFAULT_REALTIME_BASE_URL = 'wss://api.openai.com/v1/realtime';

/**
 * Options for a realtime session. Passed to {@link RealtimeBridge.connect}.
 */
export interface RealtimeBridgeOptions {
  /** Realtime model id (defaults to {@link DEFAULT_REALTIME_MODEL}). */
  readonly model?: string;
  /** Voice for AI responses (e.g. `alloy`, `echo`, `shimmer`). */
  readonly voice?: string;
  /** System prompt / instructions for the Florina persona. */
  readonly instructions?: string;
  /** Typed tool definitions exposed to the voice model. */
  readonly tools?: readonly RealtimeTool[];
  /** Audio sample rate (default {@link DEFAULT_SAMPLE_RATE}). */
  readonly sampleRate?: number;
  /** Audio channel count (default {@link DEFAULT_CHANNELS}). */
  readonly channels?: number;
  /** Override the Realtime API base URL (for testing). */
  readonly baseUrl?: string;
  /**
   * Transcription-only session (dictation, issue #161): `stopListening`
   * commits the input buffer WITHOUT sending `response.create`, so the
   * server transcribes the speech and never generates a reply. The
   * session returns to Idle on `input_audio_transcription.completed`.
   */
  readonly transcriptionOnly?: boolean;
  /** Auto-reconnect on unexpected close (default true). */
  readonly autoReconnect?: boolean;
  /** Max reconnection attempts before giving up (default 3). */
  readonly maxReconnectAttempts?: number;
  /** Reconnect backoff base delay in ms (default 500). */
  readonly reconnectBaseDelayMs?: number;
}

/* ================================================================== *
 * Callback types
 * ================================================================== */

export type TranscriptCallback = (event: TranscriptEvent) => void;
export type ResponseCallback = (event: ResponseEvent) => void;
export type StateChangeCallback = (event: VoiceStateChangeEvent) => void;
export type ErrorCallback = (event: VoiceErrorEvent) => void;
export type ToolCallCallback = (event: ToolCallEvent) => void;

/* ================================================================== *
 * RealtimeBridge
 * ================================================================== */

/**
 * Connects to the OpenAI Realtime API and runs a push-to-talk voice loop.
 *
 * Construct with an {@link AudioTransport} and a {@link SocketFactory}, then
 * call {@link RealtimeBridge.connect}. Use {@link RealtimeBridge.startListening}
 * / {@link RealtimeBridge.stopListening} for PTT. Register callbacks via
 * {@link RealtimeBridge.onTranscript} / {@link RealtimeBridge.onResponse} /
 * {@link RealtimeBridge.onStateChange} / {@link RealtimeBridge.onError}.
 */
export class RealtimeBridge implements RealtimeSessionPort {
  private readonly audioTransport: AudioTransport;
  private readonly socketFactory: SocketFactory;

  private socket: RealtimeSocket | null = null;
  private state: VoiceSessionState = State.Idle;
  /** Session id assigned by the server (from session.created/updated). */
  private currentSessionId: string | null = null;

  /** Stored connect args so reconnection can re-establish the session. */
  private apiKey = '';
  private options: Required<
    Omit<RealtimeBridgeOptions, 'baseUrl' | 'tools' | 'instructions' | 'voice'>
  > & {
    baseUrl: string;
    tools: readonly RealtimeTool[];
    instructions: string;
    voice: string;
  };

  /** Whether the user explicitly called disconnect() (suppresses reconnect). */
  private intentionalClose = false;
  /** Current reconnection attempt count. */
  private reconnectAttempts = 0;
  /** Function-call ids already dispatched (GA emits them twice). */
  private readonly seenToolCalls = new Set<string>();
  /** Whether audio capture is currently active (PTT). */
  private listening = false;
  /** Bound socket listeners (kept so they can be removed on disconnect). */
  private boundOpen: () => void;
  private boundMessage: (data: unknown) => void;
  private boundClose: (...args: unknown[]) => void;
  private boundError: (...args: unknown[]) => void;

  /** Registered callbacks. */
  private transcriptCallbacks: TranscriptCallback[] = [];
  private responseCallbacks: ResponseCallback[] = [];
  private stateChangeCallbacks: StateChangeCallback[] = [];
  private errorCallbacks: ErrorCallback[] = [];
  private toolCallCallbacks: ToolCallCallback[] = [];

  constructor(audioTransport: AudioTransport, socketFactory: SocketFactory) {
    this.audioTransport = audioTransport;
    this.socketFactory = socketFactory;
    this.boundOpen = this.handleOpen.bind(this);
    this.boundMessage = this.handleMessage.bind(this);
    this.boundClose = this.handleClose.bind(this);
    this.boundError = this.handleError.bind(this);
    this.options = this.normalizeOptions({});
  }

  /* ---------------------------------------------------------------- *
   * Public API
   * ---------------------------------------------------------------- */

  /** Current voice session state. */
  get currentState(): VoiceSessionState {
    return this.state;
  }

  /** Whether the bridge is currently capturing audio (PTT active). */
  get isListening(): boolean {
    return this.listening;
  }

  /** Whether a WebSocket connection is currently open. */
  get isConnected(): boolean {
    return this.socket !== null && this.socket.readyState === this.socket.OPEN;
  }

  /** The server-assigned session id, or `null` until `session.created` arrives. */
  get sessionId(): string | null {
    return this.currentSessionId;
  }

  /**
   * Establish a WebSocket connection to the OpenAI Realtime API.
   *
   * Resolves once the socket is open and the initial `session.update` has
   * been sent. Rejects on connection error.
   */
  connect(apiKey: string, options?: RealtimeBridgeOptions): Promise<void> {
    if (this.socket !== null) {
      return Promise.reject(new Error('RealtimeBridge is already connected'));
    }
    this.apiKey = apiKey;
    this.options = this.normalizeOptions(options ?? {});
    this.intentionalClose = false;
    this.reconnectAttempts = 0;
    this.seenToolCalls.clear();
    this.setState(State.Connecting);

    const url = this.buildUrl();
    const headers = this.buildHeaders();
    const socket = this.socketFactory(url, headers);
    this.socket = socket;
    socket.on('open', this.boundOpen);
    socket.on('message', this.boundMessage);
    socket.on('close', this.boundClose);
    socket.on('error', this.boundError);

    return new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        socket.off('open', onOpen);
        socket.off('error', onConnectError);
        // The persistent boundOpen handler already sent session.update; just
        // resolve the connect promise.
        resolve();
      };
      const onConnectError = (err: unknown): void => {
        socket.off('open', onOpen);
        socket.off('error', onConnectError);
        this.setState(State.Error);
        reject(toError(err));
      };
      socket.on('open', onOpen);
      socket.on('error', onConnectError);
    });
  }

  /**
   * Begin capturing audio (push-to-talk). Captured chunks are sent to the
   * Realtime API as `input_audio_buffer.append` messages. Only sends audio
   * while listening is active — the capture callback double-checks state so
   * late chunks after {@link RealtimeBridge.stopListening} are dropped.
   */
  startListening(): void {
    if (this.socket === null) {
      throw new Error('Cannot start listening: not connected');
    }
    if (this.state === State.Listening) {
      return;
    }
    this.setState(State.Listening);
    this.listening = true;
    this.audioTransport.startCapture((chunk) => {
      // PTT gate: only forward audio while actively listening.
      if (!this.listening || this.state !== State.Listening) {
        return;
      }
      this.sendAudioChunk(chunk);
    });
  }

  /**
   * Stop capturing audio and commit the input buffer. In PTT (manual) mode
   * this also sends `response.create` to trigger the model's response, then
   * transitions to `Processing`. In `transcriptionOnly` mode the commit is
   * all that is sent — the server transcribes and no reply is generated.
   */
  stopListening(): void {
    if (!this.listening) {
      return;
    }
    this.listening = false;
    this.audioTransport.stopCapture();
    this.sendMessage({ type: 'input_audio_buffer.commit' });
    // Manual / PTT mode: explicitly request a response. Dictation skips
    // this — the commit alone yields `input_audio_transcription.completed`.
    if (!this.options.transcriptionOnly) {
      this.sendMessage({ type: 'response.create' });
    }
    if (this.state === State.Listening) {
      this.setState(State.Processing);
    }
  }

  /**
   * Interrupt an in-progress AI response. Sends `response.cancel` to the
   * server, stops audio playback, and returns to `Idle`. No-op if no response
   * is in progress.
   */
  interrupt(): void {
    this.sendMessage({ type: 'response.cancel' });
    this.audioTransport.stopPlayback();
    if (this.state === State.Responding || this.state === State.Processing) {
      this.setState(State.Idle);
    }
  }

  /** Register a callback for transcription events. Returns an unsubscribe fn. */
  onTranscript(callback: TranscriptCallback): () => void {
    this.transcriptCallbacks.push(callback);
    return () => this.removeListener(this.transcriptCallbacks, callback);
  }

  /** Register a callback for AI response (audio/text) events. Returns unsubscribe. */
  onResponse(callback: ResponseCallback): () => void {
    this.responseCallbacks.push(callback);
    return () => this.removeListener(this.responseCallbacks, callback);
  }

  /** Register a callback for state transitions. Returns an unsubscribe fn. */
  onStateChange(callback: StateChangeCallback): () => void {
    this.stateChangeCallbacks.push(callback);
    return () => this.removeListener(this.stateChangeCallbacks, callback);
  }

  /** Register a callback for error events. Returns an unsubscribe fn. */
  onError(callback: ErrorCallback): () => void {
    this.errorCallbacks.push(callback);
    return () => this.removeListener(this.errorCallbacks, callback);
  }

  /**
   * Register a callback for tool call events. When the Realtime model emits a
   * `function_call` conversation item the bridge fires this callback so the
   * host can execute the tool and return the result via
   * {@link RealtimeBridge.sendToolCallOutput}. Returns an unsubscribe fn.
   */
  onToolCall(callback: ToolCallCallback): () => void {
    this.toolCallCallbacks.push(callback);
    return () => this.removeListener(this.toolCallCallbacks, callback);
  }

  /**
   * Close the WebSocket connection and release audio resources.
   *
   * Suppresses automatic reconnection. Resolves once the socket is closed.
   */
  disconnect(): Promise<void> {
    this.intentionalClose = true;
    this.listening = false;
    this.currentSessionId = null;
    this.audioTransport.stopCapture();
    this.audioTransport.stopPlayback();
    const socket = this.socket;
    if (socket === null) {
      this.setState(State.Idle);
      return Promise.resolve();
    }
    socket.off('open', this.boundOpen);
    socket.off('message', this.boundMessage);
    socket.off('close', this.boundClose);
    socket.off('error', this.boundError);
    return new Promise<void>((resolve) => {
      const onClose = (): void => {
        socket.off('close', onClose);
        resolve();
      };
      if (socket.readyState === socket.OPEN) {
        socket.on('close', onClose);
        socket.close(1000, 'client disconnect');
      } else {
        resolve();
      }
      this.socket = null;
      this.setState(State.Idle);
    });
  }

  /**
   * Send a function call output back to the server so the Realtime model can
   * continue the conversation after a tool call. The `callId` must match the
   * `call_id` from the originating {@link ToolCallEvent}; `output` should be
   * the tool result as a JSON-encoded string (DEC-021).
   */
  sendToolCallOutput(callId: string, output: string): void {
    this.sendMessage({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output },
    });
  }

  /**
   * Inject a user-role text message and request a response (issue #73).
   *
   * Long-running tool work finishes after the speech turn that triggered
   * it; the result is injected as a user message followed by
   * `response.create` so the Florina speaks again when the result is
   * ready — the original turn was never blocked.
   */
  sendUserMessage(text: string): void {
    this.sendMessage({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }],
      },
    });
    this.sendMessage({ type: 'response.create' });
  }

  /* ---------------------------------------------------------------- *
   * Socket event handlers
   * ---------------------------------------------------------------- */

  /** Socket 'open' — send the initial session configuration. */
  private handleOpen(): void {
    this.sendSessionUpdate();
  }

  /** Socket 'message' — decode and dispatch a server message. */
  private handleMessage(data: unknown): void {
    const msg = decodeServerMessage(data as string | Buffer);
    if (msg === null) {
      return;
    }
    this.dispatchServerMessage(msg);
  }

  /** Socket 'close' — handle reconnection or transition to Idle. */
  private handleClose(...args: unknown[]): void {
    const code = (args[0] as number) ?? 1000;
    const reason = (args[1] as string) ?? '';
    this.socket = null;
    this.currentSessionId = null;
    this.listening = false;
    this.audioTransport.stopCapture();
    if (this.intentionalClose) {
      this.setState(State.Idle);
      return;
    }
    // Unexpected close — attempt reconnection.
    if (this.options.autoReconnect && this.reconnectAttempts < this.options.maxReconnectAttempts) {
      this.scheduleReconnect();
    } else {
      this.emitError(`Connection closed: ${code} ${reason}`.trim());
      this.setState(State.Error);
    }
  }

  /** Socket 'error' — surface the error and let close handling do reconnect. */
  private handleError(...args: unknown[]): void {
    const err = args[0];
    this.emitError(err instanceof Error ? err.message : String(err ?? 'Socket error'));
  }

  /* ---------------------------------------------------------------- *
   * Server message dispatch
   * ---------------------------------------------------------------- */

  private dispatchServerMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'session.created':
      case 'session.updated':
        // Track the server-assigned session id.
        this.currentSessionId = msg.session.id;
        // Session is configured — ready to listen.
        if (this.state === State.Connecting) {
          this.setState(State.Idle);
        }
        break;

      case 'input_audio_buffer.committed':
        // Audio acknowledged; remain in Processing until response arrives.
        break;

      case 'conversation.item.created': {
        // A function_call item means the model wants a tool executed.
        // Dedupe: GA also reports the same call via response.output_item.done.
        if (isFunctionCallItem(msg.item) && !this.seenToolCalls.has(msg.item.call_id)) {
          this.seenToolCalls.add(msg.item.call_id);
          this.emitToolCall({
            callId: msg.item.call_id,
            name: msg.item.name,
            arguments: msg.item.arguments,
          });
        }
        break;
      }

      case 'conversation.item.deleted':
        // Item removed from the conversation history — nothing to do.
        break;

      case 'conversation.item.input_audio_transcription.delta':
        this.emitTranscript({ partial: true, text: msg.delta });
        break;

      case 'conversation.item.input_audio_transcription.completed':
        this.emitTranscript({ partial: false, text: msg.transcript });
        // Dictation: no response follows the transcript — return to Idle.
        if (this.options.transcriptionOnly && this.state === State.Processing) {
          this.setState(State.Idle);
        }
        break;

      case 'response.output_text.delta':
        this.transitionToResponding();
        this.emitResponse({ partial: true, text: msg.delta });
        this.emitTranscript({ partial: true, text: msg.delta });
        break;

      case 'response.output_text.done':
        this.emitResponse({ partial: false, text: msg.text });
        this.emitTranscript({ partial: false, text: msg.text });
        this.maybeReturnToIdle();
        break;

      case 'response.output_audio_transcript.delta':
        // Assistant speech transcript — drives captions in voice mode.
        this.emitTranscript({ partial: true, text: msg.delta });
        break;

      case 'response.output_audio_transcript.done':
        this.emitTranscript({ partial: false, text: msg.transcript });
        break;

      case 'response.output_item.done': {
        // GA also delivers completed function_call items here (in addition
        // to conversation.item.created) — dedupe by call_id.
        if (isFunctionCallItem(msg.item) && !this.seenToolCalls.has(msg.item.call_id)) {
          this.seenToolCalls.add(msg.item.call_id);
          this.emitToolCall({
            callId: msg.item.call_id,
            name: msg.item.name,
            arguments: msg.item.arguments,
          });
        }
        break;
      }

      case 'response.done':
        // Terminal regardless of which modality events streamed.
        this.maybeReturnToIdle();
        break;

      case 'response.output_audio.delta': {
        this.transitionToResponding();
        const chunk: AudioChunk = {
          pcm: msg.delta,
          sampleRate: this.options.sampleRate,
          channels: this.options.channels,
        };
        this.audioTransport.play(chunk);
        this.emitResponse({ partial: true, audio: chunk });
        break;
      }

      case 'response.output_audio.done':
        this.emitResponse({ partial: false });
        this.maybeReturnToIdle();
        break;

      case 'error':
        this.emitError(msg.error.message, msg.error.code);
        this.setState(State.Error);
        break;

      default:
        // Unknown but typed message — ignore.
        break;
    }
  }

  /* ---------------------------------------------------------------- *
   * State machine
   * ---------------------------------------------------------------- */

  private setState(next: VoiceSessionState): void {
    if (this.state === next) {
      return;
    }
    const from = this.state;
    this.state = next;
    const event: VoiceStateChangeEvent = { from, to: next };
    for (const cb of this.stateChangeCallbacks) {
      cb(event);
    }
  }

  /** Move to Responding (only if currently Processing or Listening). */
  private transitionToResponding(): void {
    if (this.state === State.Processing || this.state === State.Listening) {
      this.setState(State.Responding);
    }
  }

  /** Return to Idle once a response completes. */
  private maybeReturnToIdle(): void {
    if (this.state === State.Responding) {
      this.setState(State.Idle);
    }
  }

  /* ---------------------------------------------------------------- *
   * Outbound messages
   * ---------------------------------------------------------------- */

  private sendSessionUpdate(): void {
    const pcm = { type: 'audio/pcm' as const, rate: this.options.sampleRate };
    // GA session shape (issue #161): dictation opens a `transcription`
    // session — commits produce transcript events and nothing else.
    if (this.options.transcriptionOnly) {
      const session: RealtimeSessionConfig = {
        type: 'transcription',
        audio: {
          input: {
            format: pcm,
            transcription: { model: DEFAULT_TRANSCRIPTION_MODEL },
            turn_detection: null, // manual commit on stopListening
          },
        },
      };
      this.sendMessage({ type: 'session.update', session });
      return;
    }
    const session: RealtimeSessionConfig = {
      type: 'realtime',
      model: this.options.model,
      instructions: this.options.instructions,
      tools: this.options.tools,
      audio: {
        input: {
          format: pcm,
          transcription: { model: DEFAULT_TRANSCRIPTION_MODEL },
          turn_detection: null, // PTT — the bridge commits explicitly
        },
        output: { format: pcm, voice: this.options.voice },
      },
    };
    this.sendMessage({ type: 'session.update', session });
  }

  private sendAudioChunk(chunk: AudioChunk): void {
    this.sendMessage({ type: 'input_audio_buffer.append', audio: chunk.pcm });
  }

  private sendMessage(msg: ClientMessage): void {
    if (this.socket === null || this.socket.readyState !== this.socket.OPEN) {
      return;
    }
    this.socket.send(encodeClientMessage(msg));
  }

  /* ---------------------------------------------------------------- *
   * Reconnection
   * ---------------------------------------------------------------- */

  private scheduleReconnect(): void {
    this.reconnectAttempts += 1;
    const attempt = this.reconnectAttempts;
    const delay = this.options.reconnectBaseDelayMs * attempt;
    this.setState(State.Connecting);
    const timer = setTimeout(() => {
      // Abort if the user disconnected while waiting.
      if (this.intentionalClose) {
        return;
      }
      const url = this.buildUrl();
      const headers = this.buildHeaders();
      const socket = this.socketFactory(url, headers);
      this.socket = socket;
      socket.on('open', this.boundOpen);
      socket.on('message', this.boundMessage);
      socket.on('close', this.boundClose);
      socket.on('error', this.boundError);
    }, delay);
    // Prevent the Node.js process from staying alive solely for the timer.
    timer.unref?.();
  }

  /* ---------------------------------------------------------------- *
   * Helpers
   * ---------------------------------------------------------------- */

  private buildUrl(): string {
    const base = this.options.baseUrl;
    // Dictation dials a transcription session (issue #161): the GA API
    // requires `intent=transcription` and REJECTS a `model` query param in
    // that mode — the transcription model lives in the session.update.
    if (this.options.transcriptionOnly) {
      return `${base}?intent=transcription`;
    }
    return `${base}?model=${encodeURIComponent(this.options.model)}`;
  }

  private buildHeaders(): Record<string, string> {
    // GA realtime API — the retired beta required `OpenAI-Beta: realtime=v1`;
    // sending it now fails the handshake with `beta_api_shape_disabled`.
    return {
      Authorization: `Bearer ${this.apiKey}`,
    };
  }

  private normalizeOptions(opts: RealtimeBridgeOptions): RealtimeBridge['options'] {
    return {
      model: opts.model ?? DEFAULT_REALTIME_MODEL,
      voice: opts.voice ?? 'alloy',
      instructions: opts.instructions ?? '',
      tools: opts.tools ?? [],
      sampleRate: opts.sampleRate ?? DEFAULT_SAMPLE_RATE,
      channels: opts.channels ?? DEFAULT_CHANNELS,
      baseUrl: opts.baseUrl ?? DEFAULT_REALTIME_BASE_URL,
      autoReconnect: opts.autoReconnect ?? true,
      maxReconnectAttempts: opts.maxReconnectAttempts ?? 3,
      reconnectBaseDelayMs: opts.reconnectBaseDelayMs ?? 500,
      transcriptionOnly: opts.transcriptionOnly ?? false,
    };
  }

  private emitTranscript(event: TranscriptEvent): void {
    for (const cb of this.transcriptCallbacks) {
      cb(event);
    }
  }

  private emitResponse(event: ResponseEvent): void {
    for (const cb of this.responseCallbacks) {
      cb(event);
    }
  }

  private emitError(message: string, code?: string): void {
    const event: VoiceErrorEvent = { message, code };
    for (const cb of this.errorCallbacks) {
      cb(event);
    }
  }

  private emitToolCall(event: ToolCallEvent): void {
    for (const cb of this.toolCallCallbacks) {
      cb(event);
    }
  }

  private removeListener<T>(list: T[], item: T): void {
    const idx = list.indexOf(item);
    if (idx >= 0) {
      list.splice(idx, 1);
    }
  }
}

/* ================================================================== *
 * Internal helpers
 * ================================================================== */

function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }
  return new Error(typeof value === 'string' ? value : 'Connection failed');
}
