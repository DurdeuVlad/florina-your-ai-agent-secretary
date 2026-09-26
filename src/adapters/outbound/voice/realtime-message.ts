/**
 * Type definitions for the OpenAI Realtime API WebSocket protocol (DEC-021).
 *
 * Covers the subset of the protocol used by the {@link RealtimeBridge}:
 * - Client -> Server: `session.update`, `input_audio_buffer.append`,
 *   `input_audio_buffer.commit`, `response.create`, `response.cancel`,
 *   `conversation.item.create` (function_call_output).
 * - Server -> Client: `session.created`, `session.updated`,
 *   `input_audio_buffer.committed`, `response.output_audio.delta`,
 *   `response.output_audio.done`, `response.text.delta`,
 *   `response.text.done`, `conversation.item.created`,
 *   `conversation.item.deleted`, `error`.
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
 * commits the input buffer explicitly on `stopListening`). `null`
 * disables turn detection entirely (GA shape for manual commit).
 */
export type TurnDetection =
  { readonly type: 'none' } | { readonly type: 'server_vad'; readonly threshold?: number };

/** PCM audio format descriptor (GA realtime API). */
export interface RealtimeAudioFormat {
  readonly type: 'audio/pcm';
  /** Sample rate in Hz — the bridge runs at 24 kHz. */
  readonly rate: number;
}

/**
 * Realtime session configuration sent in `session.update` and echoed back
 * in `session.created` / `session.updated` — GA shape (issue #161). The
 * retired beta API used flat `modalities`/`input_audio_format` fields; GA
 * nests audio under `audio.input` / `audio.output` and requires the
 * session `type` discriminant (`realtime` speech-to-speech or
 * `transcription` dictation-only).
 */
export interface RealtimeSessionConfig {
  /** GA session kind — `realtime` for two-way turns, `transcription` for dictation. */
  readonly type?: 'realtime' | 'transcription';
  readonly model?: string;
  readonly instructions?: string;
  readonly tools?: readonly RealtimeTool[];
  readonly tool_choice?: 'auto' | 'none' | 'required';
  readonly audio?: {
    readonly input?: {
      readonly format?: RealtimeAudioFormat;
      /** Server-side transcription of input audio (user speech). */
      readonly transcription?: { readonly model?: string };
      readonly turn_detection?: TurnDetection | null;
    };
    readonly output?: {
      readonly format?: RealtimeAudioFormat;
      readonly voice?: string;
    };
  };
}

/** A session config plus the server-assigned session id. */
export interface RealtimeSession extends RealtimeSessionConfig {
  readonly id: string;
}

/* ================================================================== *
 * Conversation items (tool calls)
 * ================================================================== */

/**
 * A function call item produced by the Realtime model. The server delivers
 * these via `conversation.item.created` so the client can execute the named
 * tool and return its output with a `conversation.item.create` carrying a
 * {@link RealtimeFunctionCallOutput} (DEC-021).
 */
export interface RealtimeFunctionCall {
  readonly type: 'function_call';
  /** Server-assigned item id (optional on the outbound side). */
  readonly id?: string;
  /** Correlation id linking the call to its output. */
  readonly call_id: string;
  /** Name of the tool to invoke. */
  readonly name: string;
  /** JSON-encoded arguments string. */
  readonly arguments: string;
}

/**
 * The output of a function call, sent back to the server via
 * `conversation.item.create` so the model can continue the conversation.
 */
export interface RealtimeFunctionCallOutput {
  readonly type: 'function_call_output';
  /** Correlation id matching the originating {@link RealtimeFunctionCall}. */
  readonly call_id: string;
  /** Tool result as a JSON-encoded string. */
  readonly output: string;
}

/**
 * A conversation item. The bridge is primarily interested in `function_call`
 * items (to dispatch tool calls) and `function_call_output` items (to send
 * results back), but the union is left open for message items.
 */
export type RealtimeConversationItem =
  | RealtimeFunctionCall
  | RealtimeFunctionCallOutput
  | { readonly type: 'message'; readonly role: string; readonly content: readonly unknown[] }
  | { readonly type: string; readonly [key: string]: unknown };

/**
 * Type guard narrowing a {@link RealtimeConversationItem} to a
 * {@link RealtimeFunctionCall}.
 */
export function isFunctionCallItem(item: RealtimeConversationItem): item is RealtimeFunctionCall {
  return item.type === 'function_call';
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

/** Cancel an in-progress response (e.g. when the user interrupts the AI). */
export interface ResponseCancelMessage {
  readonly type: 'response.cancel';
  /** Optional response id; if omitted the currently-active response is cancelled. */
  readonly response_id?: string;
}

/**
 * A user-role text conversation item — used to inject proactive context
 * into the session (issue #73): long-running tool work reports back by
 * creating the item and requesting a response.
 */
export interface RealtimeUserTextMessage {
  readonly type: 'message';
  readonly role: 'user';
  readonly content: readonly {
    readonly type: 'input_text';
    readonly text: string;
  }[];
}

/**
 * Create a new conversation item. The bridge uses this to send a
 * {@link RealtimeFunctionCallOutput} back to the server after executing a
 * tool call (DEC-021), or a {@link RealtimeUserTextMessage} when the
 * Florina speaks again asynchronously (issue #73).
 */
export interface ConversationItemCreateMessage {
  readonly type: 'conversation.item.create';
  readonly item: RealtimeFunctionCallOutput | RealtimeUserTextMessage;
}

/**
 * Discriminated union of all client -> server messages the bridge sends.
 */
export type ClientMessage =
  | SessionUpdateMessage
  | InputAudioBufferAppendMessage
  | InputAudioBufferCommitMessage
  | ResponseCreateMessage
  | ResponseCancelMessage
  | ConversationItemCreateMessage;

/** Ordered list of valid client message `type` discriminants. */
export const CLIENT_MESSAGE_TYPES: readonly string[] = [
  'session.update',
  'input_audio_buffer.append',
  'input_audio_buffer.commit',
  'response.create',
  'response.cancel',
  'conversation.item.create',
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

/** A delta of AI response text (GA name — beta was `response.text.delta`). */
export interface ResponseTextDeltaMessage {
  readonly type: 'response.output_text.delta';
  readonly delta: string;
  readonly item_id?: string;
  readonly output_index?: number;
  readonly content_index?: number;
}

/** The AI response text stream completed (GA name — beta was `response.text.done`). */
export interface ResponseTextDoneMessage {
  readonly type: 'response.output_text.done';
  readonly text: string;
  readonly item_id?: string;
  readonly output_index?: number;
  readonly content_index?: number;
}

/** A delta of the AI's spoken-audio transcript (GA `response.output_audio_transcript.*`). */
export interface ResponseAudioTranscriptDeltaMessage {
  readonly type: 'response.output_audio_transcript.delta';
  readonly delta: string;
}

/** The AI's spoken-audio transcript completed. */
export interface ResponseAudioTranscriptDoneMessage {
  readonly type: 'response.output_audio_transcript.done';
  readonly transcript: string;
}

/** A response output item completed — GA delivers function calls here too. */
export interface ResponseOutputItemDoneMessage {
  readonly type: 'response.output_item.done';
  readonly item: RealtimeConversationItem;
}

/** The whole response finished — terminal state regardless of modality. */
export interface ResponseDoneMessage {
  readonly type: 'response.done';
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

/** A conversation item was created (e.g. a function_call from the model). */
export interface ConversationItemCreatedMessage {
  readonly type: 'conversation.item.created';
  readonly item: RealtimeConversationItem;
}

/** GA alias for `conversation.item.created` (issue #162). */
export interface ConversationItemAddedMessage {
  readonly type: 'conversation.item.added';
  readonly item: RealtimeConversationItem;
}

/**
 * A conversation item completed (issue #162): GA delivers the finished
 * `function_call` item here — with the full `arguments` — as well as in
 * `response.output_item.done`. The bridge dedupes by `call_id`.
 */
export interface ConversationItemDoneMessage {
  readonly type: 'conversation.item.done';
  readonly item: RealtimeConversationItem;
}

/** A conversation item was deleted. */
export interface ConversationItemDeletedMessage {
  readonly type: 'conversation.item.deleted';
  readonly item_id: string;
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
  | ResponseAudioTranscriptDeltaMessage
  | ResponseAudioTranscriptDoneMessage
  | ResponseOutputItemDoneMessage
  | ResponseDoneMessage
  | InputAudioTranscriptionDeltaMessage
  | InputAudioTranscriptionCompletedMessage
  | ConversationItemCreatedMessage
  | ConversationItemAddedMessage
  | ConversationItemDoneMessage
  | ConversationItemDeletedMessage
  | ErrorMessage;

/** Ordered list of valid server message `type` discriminants. */
export const SERVER_MESSAGE_TYPES: readonly string[] = [
  'session.created',
  'session.updated',
  'input_audio_buffer.committed',
  'response.output_audio.delta',
  'response.output_audio.done',
  'response.output_text.delta',
  'response.output_text.done',
  'response.output_audio_transcript.delta',
  'response.output_audio_transcript.done',
  'response.output_item.done',
  'response.done',
  'conversation.item.input_audio_transcription.delta',
  'conversation.item.input_audio_transcription.completed',
  'conversation.item.created',
  'conversation.item.added',
  'conversation.item.done',
  'conversation.item.deleted',
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
