/**
 * CLI dependency seams (DEC-037, issue #93).
 *
 * The CLI adapter drives the typed command API but does not own the daemon
 * process lifecycle or the concrete voice engine stack — those are
 * composition concerns. The bootstrap CLI root injects implementations of
 * these interfaces (the daemon runner from `src/bootstrap/`, and a voice
 * session factory composing the inbound voice surface with outbound
 * engines).
 */
import type { VoiceSessionState } from '../../../core/application/ports/outbound/voice.js';
import type { CommandExecutor } from '../../../core/application/use-cases/tasks/command-api.js';
import type { VoicePipelineMode } from '../../../core/application/use-cases/voice/voice-pipeline.js';
import type { DaemonClient } from './client.js';

/** Status snapshot of the daemon process, as reported by the runner. */
export interface DaemonProcessStatus {
  /** Whether the daemon process is alive. */
  readonly running: boolean;
  /** PID of the daemon process, if known. */
  readonly pid?: number;
  /** Port the daemon is configured to listen on. */
  readonly port: number;
}

/**
 * The daemon process lifecycle surface the CLI needs for `start` / `stop`
 * / `status` / `voice` commands. Satisfied by the bootstrap `DaemonRunner`.
 */
export interface DaemonProcessManager {
  /** Start the daemon; resolves with its PID. */
  start(): Promise<number>;
  /** Stop the daemon; resolves whether a daemon was stopped. */
  stop(): Promise<boolean>;
  /** Probe the daemon process status. */
  status(): Promise<DaemonProcessStatus>;
}

/**
 * The voice session surface the CLI drives for `secretary voice`.
 * Satisfied by the inbound `VoiceSessionManager`.
 */
export interface VoiceSession {
  /** Connect the engine and start the voice pipeline. */
  start(): Promise<void>;
  /** Stop the pipeline, disconnect the engine, and release the transport. */
  stop(): Promise<void>;
  /** Register a transcript callback. Returns an unsubscribe function. */
  onTranscript(callback: (text: string, partial: boolean) => void): () => void;
  /** Register a pipeline mode-change callback. */
  onModeChange(callback: (mode: VoicePipelineMode) => void): () => void;
  /** Register a tool-call result callback. */
  onToolCall(callback: (name: string, success: boolean, result: unknown) => void): () => void;
  /** Register a session state-change callback. */
  onStateChange(callback: (state: VoiceSessionState) => void): () => void;
}

/**
 * Factory that composes a {@link VoiceSession} for a given API key and
 * command executor. Implemented in bootstrap, where the inbound voice
 * surface is wired to the concrete audio transport and voice engines.
 */
export type VoiceSessionFactory = (options: {
  readonly apiKey: string;
  readonly commandApi: CommandExecutor;
  /**
   * LiteLLM proxy config (DEC-034, issue #73). When present, the session
   * runs heavyweight voice tools in the Secretary loop on this model.
   */
  readonly litellm?: {
    readonly baseUrl: string;
    readonly model: string;
    readonly apiKey?: string;
  };
}) => Promise<VoiceSession>;

/** The concrete services the CLI surface requires, injected by bootstrap. */
export interface CliDependencies {
  /** WebSocket client used to send typed commands to the daemon. */
  readonly client: DaemonClient;
  /** Daemon process lifecycle manager. */
  readonly runner: DaemonProcessManager;
  /** Factory composing a voice session on demand. */
  readonly createVoiceSession: VoiceSessionFactory;
}
