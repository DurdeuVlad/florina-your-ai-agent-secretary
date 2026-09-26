/**
 * Agent runtime port — the core-owned contract every agent adapter
 * implements (DEC-013, DEC-019).
 *
 * Adapters normalize heterogeneous agent observations into the canonical
 * {@link SupervisorEvent} schema and stream them to the daemon. The daemon
 * owns the event journal and the live fan-out; adapters never touch storage
 * or WebSocket connections directly.
 */
import type { AdapterFidelityTier } from '../../../domain/enums.js';
import type { SupervisorEvent } from '../../../domain/events.js';

/** Connection state tracked by every adapter. */
export type AdapterConnectionState = 'disconnected' | 'connecting' | 'connected';

/**
 * Configuration for a single agent run (session).
 *
 * Passed to {@link AgentRuntimePort.startRun} when a task is delegated to an
 * adapter. Carries the identifiers and runtime context the adapter needs to
 * normalize events with the correct envelope fields.
 */
export interface SessionConfig {
  /** Identifier of the Task this run belongs to (DEC-004). */
  readonly taskId: string;
  /** Identifier of the Session (run) being started. */
  readonly sessionId: string;
  /** Identifier of the agent that will execute the run. */
  readonly agentId: string;
  /** Working directory (worktree) the agent runs in. */
  readonly workingDir: string;
  /** The objective delegated to the agent. */
  readonly objective: string;
  /** Optional model identifier the agent should use. */
  readonly model?: string;
  /** Optional autonomy/approval policy in effect. */
  readonly autonomyLevel?: string;
  /**
   * MCP servers the agent session should register at launch (DEC-018,
   * issue #63) — e.g. the Florina's manager tool server for
   * manager-role tasks. Provider-agnostic: adapters that support MCP
   * registration (ACP `session/new`) translate the spec into their
   * wire format; adapters that cannot register MCP servers ignore it.
   */
  readonly mcpServers?: readonly McpServerSpec[];
  /**
   * Environment variables injected into the agent session (e.g. from secrets vault,
   * issue #172). Keys and values injected at spawn time without leaking to journals.
   */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Provider-agnostic MCP server registration carried in
 * {@link SessionConfig.mcpServers}. The Florina's own server is always
 * streamable HTTP; `headers` carry scoping context such as the
 * `x-florina-project` project id.
 */
export interface McpServerSpec {
  /** Registration name the agent sees (e.g. `florina`). */
  readonly name: string;
  /** HTTP(S) URL the agent connects to. */
  readonly url: string;
  /** Optional HTTP headers sent with each MCP request. */
  readonly headers?: Readonly<Record<string, string>>;
}

/** Result of starting a run: the session id and whether the run began. */
export interface StartRunResult {
  /** The session id of the started run. */
  readonly sessionId: string;
  /** Whether the run was successfully started. */
  readonly started: boolean;
}

/**
 * The contract every agent adapter implements.
 *
 * Lifecycle:
 * 1. `connect()` — establish the provider connection (app-server, CLI
 *    subprocess, PTY, ...).
 * 2. `startRun(taskId, sessionConfig)` — begin a delegated run.
 * 3. `streamEvents()` — async iterable of normalized `SupervisorEvent`s.
 * 4. `cancel(sessionId)` — stop a running session.
 * 5. `disconnect()` — tear down the provider connection.
 */
export interface AgentRuntimePort {
  /** Stable identifier for this adapter (e.g. `codex`, `claude-code`, `stub`). */
  readonly id: string;

  /**
   * The fidelity tier (A–E) this adapter declares. The attention engine
   * uses this to decide auto-approve eligibility (DEC-013).
   */
  readonly fidelityTier: AdapterFidelityTier;

  /** Current connection state of the adapter. */
  readonly connectionState: AdapterConnectionState;

  /**
   * Establish the provider connection (app-server handshake, CLI spawn, PTY
   * open, ...). Must be called before `startRun`.
   */
  connect(): Promise<void>;

  /**
   * Begin a delegated run for a task. Returns the session id and whether the
   * run was successfully started.
   *
   * @param taskId - Identifier of the Task being delegated.
   * @param sessionConfig - Runtime context for the run.
   */
  startRun(taskId: string, sessionConfig: SessionConfig): Promise<StartRunResult>;

  /**
   * Stream normalized `SupervisorEvent`s for active runs. The async iterable
   * completes when all active runs finish (or the adapter disconnects).
   */
  streamEvents(): AsyncIterable<SupervisorEvent>;

  /**
   * Cancel a running session. The adapter should stop the underlying agent
   * process and emit a terminal `AgentStopped` event.
   *
   * @param sessionId - The session to cancel.
   */
  cancel(sessionId: string): Promise<void>;

  /** Tear down the provider connection and release all resources. */
  disconnect(): Promise<void>;
}

/** @deprecated Use {@link AgentRuntimePort}; retained for compatibility. */
export type AgentAdapter = AgentRuntimePort;
