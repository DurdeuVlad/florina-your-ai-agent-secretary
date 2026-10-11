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
import type { SupervisorEvent, ContextMaintenanceMode } from '../../../domain/events.js';

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
  /**
   * Project the task belongs to (DEC-004). Scopes secret injection at
   * spawn time (issue #293) — secrets granted to a different project are
   * never injected into this run.
   */
  readonly projectId?: string;
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
   * Honored by adapters that spawn a local process per run (claude-code,
   * agy); adapters whose process is spawned at `connect()` (ACP, PTY) or
   * that drive a separately-managed runtime (Codex app-server WebSocket,
   * remote APIs) cannot apply per-run env and ignore it. Values are never
   * forwarded off-machine — the remote federation adapter does not carry
   * them into delegated payloads.
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
 * Static session-reuse capabilities an adapter declares (issue #341,
 * Agent Supervision Campaign M2). These are provider *capabilities*, not
 * assumptions: scheduling code (session pool, nudge loop, task queue)
 * must read them honestly and degrade rather than fake support.
 *
 * - `sendMessage` — a follow-up user message can be delivered into an
 *   existing live session (multi-turn).
 * - `resume` — a new run can continue a prior provider session with its
 *   context intact (provider-side continuation, e.g. thread resume).
 * - `compact` — the provider can compact/summarize its own context
 *   window without losing session continuity.
 */
export interface AgentSessionCapabilities {
  readonly sendMessage: boolean;
  readonly resume: boolean;
  readonly compact: boolean;
}

/** Every capability denied — the honest default for adapters without support. */
export const NO_SESSION_CAPABILITIES: AgentSessionCapabilities = {
  sendMessage: false,
  resume: false,
  compact: false,
} as const;

/**
 * How {@link AgentRuntimePort.maintainContext} preserved context:
 * the provider compacted its own window, a new run was started carrying
 * a caller-composed digest, or the adapter cannot maintain context at
 * all (the caller degrades to spawn-fresh — never a fake result). The
 * union is canonically declared in the domain (journaled by
 * `ContextMaintained`/`SessionReused` events, issue #342) and
 * re-exported here for adapter consumers.
 */
export type { ContextMaintenanceMode } from '../../../domain/events.js';

/** What the caller supplies when asking an adapter to maintain context. */
export interface MaintainContextRequest {
  /**
   * The carry-over digest composed by the caller — the Task Capsule
   * (issue #76) for the task the session belongs to. The adapter never
   * summarizes context itself; it applies this caller-composed digest.
   */
  readonly carryover: string;
  /**
   * The SessionConfig to use when the mode requires a restarted run —
   * its `objective` is the fresh delegation the digest accompanies.
   */
  readonly restartConfig: SessionConfig;
}

/** Result of a {@link AgentRuntimePort.maintainContext} call. */
export interface MaintainContextResult {
  readonly mode: ContextMaintenanceMode;
  /**
   * The Florina run/session id the caller should bind for the new task —
   * `restartConfig.sessionId` for both successful modes: a restarted run
   * is a new session outright, and a compacted provider session serves
   * the new task under the new run id (provider continuity ≠ run
   * identity; each task keeps its own journaled session). Absent for
   * `unsupported`.
   */
  readonly sessionId?: string;
  /** Honest detail when the mode is `unsupported` (or a fallback ran). */
  readonly detail?: string;
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
   * Static session-reuse capabilities this adapter honestly supports
   * (issue #341). Declared per adapter, never inferred: a provider that
   * cannot compact, resume, or accept follow-up messages reports `false`
   * so callers degrade to spawn-fresh instead of faking continuity.
   */
  readonly capabilities: AgentSessionCapabilities;

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

  /**
   * Deliver a follow-up user message into an existing live session —
   * gated by `capabilities.sendMessage` (issue #341). Present only on
   * adapters whose transport genuinely supports multi-turn input.
   *
   * @returns `true` when the provider accepted the message; `false` when
   *   the session is gone, the transport rejected it, or the adapter is
   *   not in a state to deliver.
   */
  sendMessage?(sessionId: string, message: string): Promise<boolean>;

  /**
   * Preserve session context between tasks — gated by
   * `capabilities.compact`/`capabilities.resume` (issue #341). The
   * adapter compacts the provider window where supported, else restarts
   * a run seeded with the caller-composed carry-over digest (the Task
   * Capsule — never a bespoke adapter summarizer). Adapters that can do
   * neither return `unsupported` so the caller degrades to spawn-fresh.
   *
   * Event plumbing for a restarted run is owned by the session use case
   * (M2.2); this method only reports which mode was applied.
   */
  maintainContext?(
    sessionId: string,
    request: MaintainContextRequest,
  ): Promise<MaintainContextResult>;

  /** Tear down the provider connection and release all resources. */
  disconnect(): Promise<void>;
}

/** @deprecated Use {@link AgentRuntimePort}; retained for compatibility. */
export type AgentAdapter = AgentRuntimePort;
