/**
 * Type definitions for the OpenAI Realtime API WebSocket protocol (DEC-021).
 *
 * Covers the subset of the protocol used by the {@link RealtimeBridge}:
 * - Client -> Server: `session.update`, `input_audio_buffer.append`,
 *   `input_audio_buffer.commit`, `response.create`.
 * - Server -> Client: `session.created`, `session.updated`,
 *   `input_audio_buffer.committed`, `response.output_audio.delta`,
 *   `response.output_audio.done`, `response.text.delta`,
 *   `response.text.done`, `error`.
 *
 * Also includes input-audio transcription events, which the bridge maps to
 * {@link TranscriptEvent}s. These are optional but part of the same protocol.
 *
 * Message encoder/decoder helpers serialize {@link ClientMessage}s to the
 * JSON wire format and parse inbound frames into typed {@link ServerMessage}s.
 */

/* ================================================================== *
 * Session configuration
 * ================================================================== */

/**
 * A function/tool definition passed to the Realtime session so spoken intent
 * can trigger typed tool calls against the local daemon API (DEC-021). The
 * voice model never executes arbitrary shell commands — only these typed
 * tools, which the bridge routes to {@link CommandApi.execute}.
 */
export interface RealtimeTool {
  readonly type: 'function';
  readonly name: string;
  readonly description?: string;
  /** JSON-Schema-ish parameters object. */
  readonly parameters?: Readonly<Record<string, unknown>>;
}

/**
 * Turn-detection strategy. `server_vad` lets the server detect speech
 * boundaries automatically; `none` is manual / push-to-talk (the bridge
 * commits the input buffer explicitly on `stopListening`).
 */
export type TurnDetection =
  | { readonly type: 'none' }
  | { readonly type: 'server_vad'; readonly threshold?: number };

/**
 * Realtime session configuration sent in `session.update` and echoed back in
 * `session.created` / `session.updated`.
 */
export interface RealtimeSessionConfig {
  readonly instructions?: string;
  readonly voice?: string;
  readonly turn_detection?: TurnDetection;
  readonly tools?: readonly RealtimeTool[];
  readonly tool_choice?: 'auto' | 'none' | 'required';
  readonly modalities?: readonly ('text' | 'audio')[];
  readonly input_audio_format?: 'pcm16' | 'g711_ulaw' | 'g711_alaw';
  readonly output_audio_format?: 'pcm16' | 'g711_ulaw' | 'g711_alaw';
  /** Enable server-side transcription of the user's input audio. */
  readonly input_audio_transcription?: { readonly model?: string };
}

/** A session config plus the server-assigned session id. */
export interface RealtimeSession extends RealtimeSessionConfig {
  readonly id: string;
}

/* ================================================================== *
 * Client -> Server messages
 * ================================================================== */

/** Update the session configuration (instructions, voice, tools, VAD, ...). */
export interface SessionUpdateMessage {
  readonly type: 'session.update';
  readonly session: RealtimeSessionConfig;
}

/** Append a Base64 PCM16 chunk to the server-side input audio buffer. */
export interface InputAudioBufferAppendMessage {
  readonly type: 'input_audio_buffer.append';
  /** Base64-encoded PCM16 audio chunk. */
  readonly audio: string;
}

/** Commit the pending input audio buffer (end of user speech for PTT). */
export interface InputAudioBufferCommitMessage {
  readonly type: 'input_audio_buffer.commit';
}

/** Request the model to generate a response (used in manual / PTT mode). */
export interface ResponseCreateMessage {
  readonly type: 'response.create';
  readonly response?: {
    readonly modalities?: readonly ('text' | 'audio')[];
    readonly instructions?: string;
  };
}

/**
 * Discriminated union of all client -> server messages the bridge sends.
 */
export type ClientMessage =
  | SessionUpdateMessage
  | InputAudioBufferAppendMessage
  | InputAudioBufferCommitMessage
  | ResponseCreateMessage;

/** Ordered list of valid client message `type` discriminants. */
export const CLIENT_MESSAGE_TYPES: readonly string[] = [
  'session.update',
  'input_audio_buffer.append',
  'input_audio_buffer.commit',
  'response.create',
] as const;

/* ================================================================== *
 * Server -> Client messages
 * ================================================================== */

/** The server created a new realtime session. */
export interface SessionCreatedMessage {
  readonly type: 'session.created';
  readonly session: RealtimeSession;
}

/** The server applied a session.update. */
export interface SessionUpdatedMessage {
  readonly type: 'session.updated';
  readonly session: RealtimeSession;
}

/** The input audio buffer was committed (acknowledges `input_audio_buffer.commit`). */
export interface InputAudioBufferCommittedMessage {
  readonly type: 'input_audio_buffer.committed';
}

/** A delta of AI response output audio (Base64 PCM16). */
export interface ResponseOutputAudioDeltaMessage {
  readonly type: 'response.output_audio.delta';
  /** Base64-encoded PCM16 audio delta. */
  readonly delta: string;
  readonly item_id?: string;
  readonly output_index?: number;
  readonly content_index?: number;
}

/** The AI response output audio stream completed. */
export interface ResponseOutputAudioDoneMessage {
  readonly type: 'response.output_audio.done';
  readonly item_id?: string;
  readonly output_index?: number;
  readonly content_index?: number;
}

/** A delta of AI response text. */
export interface ResponseTextDeltaMessage {
  readonly type: 'response.text.delta';
  readonly delta: string;
  readonly item_id?: string;
  readonly output_index?: number;
  readonly content_index?: number;
}

/** The AI response text stream completed. */
export interface ResponseTextDoneMessage {
  readonly type: 'response.text.done';
  readonly text: string;
  readonly item_id?: string;
  readonly output_index?: number;
  readonly content_index?: number;
}

/** A streaming delta of the user's input-audio transcription. */
export interface InputAudioTranscriptionDeltaMessage {
  readonly type: 'conversation.item.input_audio_transcription.delta';
  readonly delta: string;
  readonly item_id?: string;
}

/** The user's input-audio transcription completed. */
export interface InputAudioTranscriptionCompletedMessage {
  readonly type: 'conversation.item.input_audio_transcription.completed';
  readonly transcript: string;
  readonly item_id?: string;
}

/** A server-side error. */
export interface ErrorMessage {
  readonly type: 'error';
  readonly error: {
    readonly type: string;
    readonly code?: string;
    readonly message: string;
    readonly param?: string;
  };
}

/**
 * Discriminated union of all server -> client messages the bridge handles.
 */
export type ServerMessage =
  | SessionCreatedMessage
  | SessionUpdatedMessage
  | InputAudioBufferCommittedMessage
  | ResponseOutputAudioDeltaMessage
  | ResponseOutputAudioDoneMessage
  | ResponseTextDeltaMessage
  | ResponseTextDoneMessage
  | InputAudioTranscriptionDeltaMessage
  | InputAudioTranscriptionCompletedMessage
  | ErrorMessage;

/** Ordered list of valid server message `type` discriminants. */
export const SERVER_MESSAGE_TYPES: readonly string[] = [
  'session.created',
  'session.updated',
  'input_audio_buffer.committed',
  'response.output_audio.delta',
  'response.output_audio.done',
  'response.text.delta',
  'response.text.done',
  'conversation.item.input_audio_transcription.delta',
  'conversation.item.input_audio_transcription.completed',
  'error',
] as const;

/* ================================================================== *
 * Encoder / decoder helpers
 * ================================================================== */

/**
 * Encode a {@link ClientMessage} into the JSON wire format expected by the
 * Realtime API.
 */
export function encodeClientMessage(msg: ClientMessage): string {
  return JSON.stringify(msg);
}

/**
 * Decode an inbound WebSocket frame into a typed {@link ServerMessage}.
 *
 * Returns `null` if the frame is not valid JSON or does not carry a known
 * server message `type`. The bridge ignores `null` results.
 *
 * @param data raw frame payload (string or Buffer).
 */
export function decodeServerMessage(data: string | Buffer): ServerMessage | null {
  const text = typeof data === 'string' ? data : data.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') {
    return null;
  }
  const type = (parsed as { type?: unknown }).type;
  if (typeof type !== 'string') {
    return null;
  }
  if (!SERVER_MESSAGE_TYPES.includes(type)) {
    return null;
  }
  return parsed as ServerMessage;
}
