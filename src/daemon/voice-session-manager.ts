/**
 * Voice session manager — wires the voice pipeline into the daemon (DEC-021,
 * DEC-002, issue #41).
 *
 * {@link VoiceSessionManager} owns the lifecycle of a {@link VoicePipeline}
 * within the daemon process. It:
 * - Constructs a {@link RealtimeBridge} with the typed Secretary tool
 *   definitions mapped to the daemon's {@link CommandApi}.
 * - Routes {@link ToolCallEvent}s from the Realtime model to
 *   {@link CommandApi.execute}, returning the result as a tool call output.
 * - Surfaces spoken transcripts and state changes via callbacks for the CLI /
 *   desktop to display.
 * - Enforces DEC-010/DEC-011: the voice model only sees typed tool
 *   definitions, never arbitrary shell access. All tool calls go through the
 *   same typed command API as the CLI.
 *
 * The manager is runtime-agnostic: it depends on an injectable
 * {@link AudioTransport} (mic capture / playback) and {@link SocketFactory}
 * (WebSocket to OpenAI Realtime). In production these are backed by real
 * hardware / network; in tests they are mocked.
 */
import type { AudioTransport, ToolCallEvent } from '../voice/audio-types.js';
import { VoiceSessionState } from '../voice/audio-types.js';
import type { RealtimeBridge, RealtimeBridgeOptions } from '../voice/realtime-bridge.js';
import type { RealtimeTool } from '../voice/realtime-message.js';
import { VoicePipeline } from '../voice/voice-pipeline.js';
import type { VoicePipelineMode } from '../voice/voice-pipeline.js';
import type { WhisperAdapter } from '../voice/whisper-adapter.js';
import type { Command, Response } from './command-api.js';

/** Structural interface for the command execution surface the voice manager needs. */
export interface CommandExecutor {
  execute(command: Command): Promise<Response>;
}

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
  /** The OpenAI API key for the Realtime API. */
  readonly apiKey: string;
  /** Audio transport (mic capture / playback). */
  readonly audioTransport: AudioTransport;
  /** Whisper adapter for the local fallback path. */
  readonly whisperAdapter: WhisperAdapter;
  /** The daemon's typed command API — tool calls are routed here. */
  readonly commandApi: CommandExecutor;
  /** Realtime bridge options (model, voice, instructions, ...). */
  readonly bridgeOptions?: Omit<RealtimeBridgeOptions, 'tools'>;
  /** Override the default tool definitions. */
  readonly tools?: readonly RealtimeTool[];
  /** Override the RealtimeBridge constructor (for testing). */
  readonly bridgeFactory?: (
    audioTransport: AudioTransport,
    socketFactory: import('../voice/realtime-bridge.js').SocketFactory,
  ) => RealtimeBridge;
  /** Override the socket factory (for testing). */
  readonly socketFactory?: import('../voice/realtime-bridge.js').SocketFactory;
}

/** Default system instructions for the Secretary voice persona. */
export const DEFAULT_VOICE_INSTRUCTIONS = `You are Agent Secretary, an attention broker for coding agents.
The developer delegates work to coding agents and you route their attention.
Use the provided tools to query status, list tasks, check the inbox, and approve or deny requests.
Keep responses concise. When the developer asks for status, use get_inbox or list_tasks.
When they say "approve", use approve_permission. When they say "deny", use deny_permission.
Never make up information — always use the tools.`;

/**
 * Build the default typed tool definitions exposed to the Realtime model
 * (DEC-021). These map directly to {@link CommandApi.execute} commands.
 *
 * The voice model never executes arbitrary shell commands — only these typed
 * tools, which the manager routes to the daemon's command API (DEC-011).
 */
export function buildDefaultVoiceTools(): readonly RealtimeTool[] {
  return [
    {
      type: 'function',
      name: 'get_inbox',
      description: 'Get the current attention inbox — items that need the developer\'s attention.',
      parameters: {
        type: 'object',
        properties: {
          priority: {
            type: 'string',
            description: 'Filter by priority: Critical, High, Medium, or Low.',
          },
          status: {
            type: 'string',
            description: 'Filter by status: Pending, Acknowledged, Resolved, or Escalated.',
          },
        },
      },
    },
    {
      type: 'function',
      name: 'list_tasks',
      description: 'List all tasks, optionally filtered by status.',
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            description: 'Filter by task state: Created, Delegated, Running, Waiting, Completed, Failed, Cancelled.',
          },
        },
      },
    },
    {
      type: 'function',
      name: 'query_task',
      description: 'Get details for a specific task by its id.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'The task identifier.' },
        },
        required: ['taskId'],
      },
    },
    {
      type: 'function',
      name: 'get_metrics',
      description: 'Get the current metrics snapshot (attention compression ratio, etc.).',
      parameters: {
        type: 'object',
        properties: {
          since: { type: 'number', description: 'Epoch-milliseconds lower bound.' },
        },
      },
    },
    {
      type: 'function',
      name: 'approve_permission',
      description: 'Grant a pending approval request for a task.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'The task that has the pending approval.' },
          approvalId: { type: 'string', description: 'The approval request id.' },
          note: { type: 'string', description: 'Optional note explaining the grant.' },
        },
        required: ['taskId', 'approvalId'],
      },
    },
    {
      type: 'function',
      name: 'deny_permission',
      description: 'Deny a pending approval request for a task.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'The task that has the pending approval.' },
          approvalId: { type: 'string', description: 'The approval request id.' },
          note: { type: 'string', description: 'Optional note explaining the denial.' },
        },
        required: ['taskId', 'approvalId'],
      },
    },
    {
      type: 'function',
      name: 'get_digest',
      description: 'Get the completion digest for a task (summary of what the agent delivered).',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'The task id.' },
        },
        required: ['taskId'],
      },
    },
  ] as const;
}

/**
 * Manages the voice session lifecycle within the daemon.
 *
 * Typical usage:
 * ```ts
 * const manager = new VoiceSessionManager({
 *   apiKey: process.env.OPENAI_API_KEY,
 *   audioTransport: new StdinAudioTransport(),
 *   whisperAdapter: new WhisperAdapter(...),
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
  private bridge: RealtimeBridge | null = null;
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
    return this.bridge?.isConnected ?? false;
  }

  /**
   * Start the voice session: construct the bridge, connect to the Realtime
   * API, and start the pipeline in realtime mode.
   */
  async start(): Promise<void> {
    const tools = this.options.tools ?? buildDefaultVoiceTools();
    const bridgeOptions: RealtimeBridgeOptions = {
      ...this.options.bridgeOptions,
      tools,
      instructions: this.options.bridgeOptions?.instructions ?? DEFAULT_VOICE_INSTRUCTIONS,
    };

    // Construct the RealtimeBridge. Lazy-import to avoid pulling the ws
    // dependency into the type-check path when the voice manager is not used.
    const { RealtimeBridge: Bridge, defaultSocketFactory } = await import('../voice/realtime-bridge.js');
    const socketFactory = this.options.socketFactory ?? defaultSocketFactory;
    if (this.options.bridgeFactory) {
      this.bridge = this.options.bridgeFactory(this.options.audioTransport, socketFactory);
    } else {
      this.bridge = new Bridge(this.options.audioTransport, socketFactory);
    }

    // Wire bridge callbacks.
    this.bridge.onTranscript((event) => {
      for (const cb of this.transcriptCallbacks) {
        cb(event.text, event.partial);
      }
    });
    this.bridge.onStateChange((event) => {
      for (const cb of this.stateCallbacks) {
        cb(event.to);
      }
    });
    this.bridge.onToolCall((event) => {
      void this.handleToolCall(event);
    });

    // Connect to the Realtime API.
    await this.bridge.connect(this.options.apiKey, bridgeOptions);

    // Construct and start the pipeline.
    this.pipeline = new VoicePipeline(this.bridge, this.options.whisperAdapter);
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
   * Begin capturing audio (push-to-talk). Audio is sent to the Realtime API.
   */
  startListening(): void {
    this.bridge?.startListening();
  }

  /**
   * Stop capturing audio and commit the input buffer. In PTT mode this
   * triggers the model's response.
   */
  stopListening(): void {
    this.bridge?.stopListening();
  }

  /**
   * Shut down the voice session: stop the pipeline, disconnect the bridge,
   * and close the audio transport.
   */
  async stop(): Promise<void> {
    this.pipeline?.stop();
    this.pipeline = null;
    if (this.bridge) {
      this.bridge.disconnect();
      this.bridge = null;
    }
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
   * Handle a tool call from the Realtime model: map it to a typed
   * {@link Command}, execute it via the daemon's {@link CommandApi}, and
   * return the result to the bridge as a tool call output.
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
      this.bridge?.sendToolCallOutput(callId, JSON.stringify({ error: 'Invalid JSON arguments' }));
      this.notifyToolCall(name, false, { error: 'Invalid JSON arguments' });
      return;
    }

    const command = mapToolCallToCommand(name, args);
    if (command === null) {
      const errorMsg = `Unknown tool: ${name}`;
      this.bridge?.sendToolCallOutput(callId, JSON.stringify({ error: errorMsg }));
      this.notifyToolCall(name, false, { error: errorMsg });
      return;
    }

    try {
      const response = await this.options.commandApi.execute(command);
      const result = response.ok ? response : { ok: false, error: (response as { error?: string }).error ?? 'Unknown error' };
      this.bridge?.sendToolCallOutput(callId, JSON.stringify(result));
      this.notifyToolCall(name, response.ok, result);
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      this.bridge?.sendToolCallOutput(callId, JSON.stringify({ error: errorMsg }));
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

/**
 * Map a voice tool call (name + parsed args) to a typed {@link Command}.
 *
 * Returns `null` for unrecognized tool names so the caller can return an
 * error to the Realtime model without executing anything (DEC-011).
 */
export function mapToolCallToCommand(
  toolName: string,
  args: Record<string, unknown>,
): Command | null {
  switch (toolName) {
    case 'get_inbox': {
      const filter: Record<string, unknown> = {};
      if (typeof args['priority'] === 'string') filter['priority'] = args['priority'];
      if (typeof args['status'] === 'string') filter['status'] = args['status'];
      return {
        kind: 'query-inbox',
        filter: Object.keys(filter).length > 0 ? filter : undefined,
      } as Command;
    }
    case 'list_tasks':
      return {
        kind: 'list-tasks',
        status: typeof args['status'] === 'string' ? (args['status'] as never) : undefined,
      } as Command;
    case 'query_task':
      if (typeof args['taskId'] !== 'string') return null;
      return { kind: 'query-task', taskId: args['taskId'] } as Command;
    case 'get_metrics':
      return {
        kind: 'query-metrics',
        since: typeof args['since'] === 'number' ? args['since'] : undefined,
      } as Command;
    case 'approve_permission': {
      if (typeof args['taskId'] !== 'string' || typeof args['approvalId'] !== 'string') return null;
      return {
        kind: 'approve',
        taskId: args['taskId'],
        approvalId: args['approvalId'],
        decision: 'grant',
        note: typeof args['note'] === 'string' ? args['note'] : undefined,
      } as Command;
    }
    case 'deny_permission': {
      if (typeof args['taskId'] !== 'string' || typeof args['approvalId'] !== 'string') return null;
      return {
        kind: 'approve',
        taskId: args['taskId'],
        approvalId: args['approvalId'],
        decision: 'deny',
        note: typeof args['note'] === 'string' ? args['note'] : undefined,
      } as Command;
    }
    case 'get_digest':
      if (typeof args['taskId'] !== 'string') return null;
      return { kind: 'get-digest', taskId: args['taskId'] } as Command;
    default:
      return null;
  }
}
