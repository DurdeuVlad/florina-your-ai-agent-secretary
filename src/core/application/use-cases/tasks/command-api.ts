/**
 * Typed command API for the Secretary daemon (issue #19, DEC-002, DEC-026).
 *
 * Voice and CLI share the same typed command API â€” voice is never a parallel
 * orchestration system (PRODUCT_DESIGN.md "Voice Experience"). Every surface
 * (CLI, desktop, voice, remote) calls the same {@link CommandApi.execute}
 * method with a typed {@link Command} and receives a typed {@link Response}.
 *
 * Design rules enforced by this module:
 * - The `Command` union is a discriminated union on the `kind` field so the
 *   compiler exhaustiveness-checks every handler.
 * - Each command variant has a matching {@link Response} variant. Responses
 *   carry an `ok` flag and, on failure, a human-readable `error` string.
 * - {@link CommandApi.execute} dispatches to a private handler per `kind`.
 *   Unknown commands (only possible at runtime) return an error response.
 * - Each handler validates input before performing the action. Invalid input
 *   returns `ok: false` rather than throwing.
 * - Authorization is enforced identically regardless of which surface issued
 *   the command (DEC-002, DEC-011).
 */
import type { AdapterFidelityTier } from '../../../domain/enums.js';
import { TaskState } from '../../../domain/enums.js';
import type { TaskState as TaskStateType } from '../../../domain/enums.js';
import type { Approval, Session, Task } from '../../../domain/types.js';
import type {
  AgentStartedEvent,
  AgentStoppedEvent,
  SupervisorEvent,
} from '../../../domain/events.js';
import type {
  AttentionItem,
  AttentionItemKind,
  AttentionItemPriority,
} from '../attention/attention-item.js';
import {
  createAttentionItem,
  ATTENTION_ITEM_KINDS,
  PRIORITY_ORDER,
} from '../attention/attention-item.js';
import type { AttentionInbox, AttentionInboxFilter } from '../attention/attention-inbox.js';
import type { CompletionDigest } from '../attention/completion-digest.js';
import type { EventPublisherPort } from '../../ports/outbound/event-stream.js';
import type {
  AgentRuntimePort,
  SessionConfig as AdapterSessionConfig,
} from '../../ports/outbound/agent-runtime.js';
import type { AgentRuntimeRegistryPort } from '../../ports/outbound/runtime-registry.js';
import type {
  ApprovalRepositoryPort,
  CompletionDigestRepositoryPort,
  EventJournalPort,
  SessionRepositoryPort,
  TaskRepositoryPort,
} from '../../ports/outbound/repositories.js';
import { DirtyWorktreeError, type WorktreePort } from '../../ports/outbound/worktree.js';
import type { TaskStateMachine, TransitionContext } from './task-lifecycle.js';
import type { MetricsCollector, MetricsSnapshot } from '../metrics.js';
import type { ContextHealthSnapshot } from '../context/context-health-monitor.js';
import type {
  AttentionMetricsReport,
  MetricsQueryOptions,
  MetricsQueryService,
} from '../attention/attention-metrics.js';
import type { SessionManager } from './session-manager.js';

/* ================================================================== *
 * Shared types
 * ================================================================== */

/**
 * Configuration for starting a task session (part of the `start-task`
 * command). Carries the information needed to spawn an agent session in the
 * task's worktree.
 */
export interface SessionConfig {
  /** Working directory (worktree path) the agent runs in. */
  readonly workingDir: string;
  /** Model identifier the agent should use, if known. */
  readonly model?: string;
  /** Autonomy / approval policy in effect, if known. */
  readonly autonomyLevel?: string;
  /** Adapter fidelity tier of the agent (defaults to `B`). */
  readonly adapterFidelityTier?: AdapterFidelityTier;
  /**
   * Prompt override for the adapter session. When omitted, the task's
   * `objective` is sent. Failover uses this to prime a new provider with a
   * Task-Capsule briefing without mutating the task's recorded objective
   * (issue #64).
   */
  readonly prompt?: string;
}

/**
 * Filter criteria for the `query-inbox` command. Re-uses the inbox's own
 * filter type so the command API and inbox stay in sync.
 */
export type InboxFilter = AttentionInboxFilter;

/**
 * Serializable snapshot of an {@link AttentionItem} returned by inbox
 * queries. All fields are readonly and use primitive/string types so the
 * snapshot is trivially JSON-serializable for any client surface.
 */
export interface AttentionItemSnapshot {
  readonly id: string;
  readonly taskId: string;
  readonly kind: string;
  readonly priority: string;
  readonly status: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * Serializable snapshot of a {@link Task} returned by task queries.
 * Includes an `eventCount` derived from the event journal so clients can
 * show activity without loading the full event stream.
 */
export interface TaskSnapshot {
  readonly id: string;
  readonly projectId: string;
  readonly objective: string;
  readonly state: string;
  readonly agentIds: readonly string[];
  readonly sessionIds: readonly string[];
  readonly worktreePath?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Number of events recorded in the journal for this task. */
  readonly eventCount: number;
}

/* ================================================================== *
 * Command union (discriminated by `kind`)
 * ================================================================== */

/** Start (delegate) a task to an agent, creating a new session. */
export interface StartTaskCommand {
  readonly kind: 'start-task';
  readonly taskId: string;
  readonly agentId: string;
  readonly sessionConfig: SessionConfig;
}

/** Stop (cancel) a running task. */
export interface StopTaskCommand {
  readonly kind: 'stop-task';
  readonly taskId: string;
  readonly reason?: string;
}

/** Grant or deny a pending approval. */
export interface ApproveCommand {
  readonly kind: 'approve';
  readonly taskId: string;
  readonly approvalId: string;
  readonly decision: 'grant' | 'deny';
  readonly note?: string;
}

/** Query the attention inbox, optionally filtered. */
export interface QueryInboxCommand {
  readonly kind: 'query-inbox';
  readonly filter?: InboxFilter;
}

/**
 * Raise a new attention item — how managers and daemon subsystems ask the
 * human a question (DEC-006/014, issue #63). The item lands in the inbox as
 * `Pending`; the deterministic attention engine owns escalation from there.
 */
export interface RaiseAttentionCommand {
  readonly kind: 'raise-attention';
  readonly taskId: string;
  /** What the human needs to decide or answer. */
  readonly summary: string;
  /** Optional longer context for the item payload. */
  readonly details?: string;
  /** Item kind (defaults to `Custom`). */
  readonly itemKind?: AttentionItemKind;
  /** Initial priority (defaults to `Medium`). */
  readonly priority?: AttentionItemPriority;
  /** Who raised it — recorded in the payload for audit (e.g. `manager`). */
  readonly source?: string;
}

/** Acknowledge an attention item (mark as seen). */
export interface AcknowledgeItemCommand {
  readonly kind: 'ack-item';
  readonly itemId: string;
}

/** Resolve an attention item (mark as handled). */
export interface ResolveItemCommand {
  readonly kind: 'resolve-item';
  readonly itemId: string;
}

/** Escalate an attention item (boost to Critical priority). */
export interface EscalateItemCommand {
  readonly kind: 'escalate-item';
  readonly itemId: string;
}

/** Query the current metrics snapshot. */
export interface QueryMetricsCommand {
  readonly kind: 'query-metrics';
  /** Epoch-milliseconds lower bound (reserved for future time-filtering). */
  readonly since?: number;
  /** Epoch-milliseconds upper bound (inclusive). */
  readonly until?: number;
  /** Restrict the attention-metrics report to a project. */
  readonly projectId?: string;
  /** Restrict the attention-metrics report to a single task. */
  readonly taskId?: string;
}

/** Query a single task by id. */
export interface QueryTaskCommand {
  readonly kind: 'query-task';
  readonly taskId: string;
}

/** List tasks, optionally filtered by status. */
export interface ListTasksCommand {
  readonly kind: 'list-tasks';
  readonly status?: TaskStateType;
}

/** Prune a task's git worktree (only if clean). */
export interface PruneWorktreeCommand {
  readonly kind: 'prune-worktree';
  readonly taskId: string;
}

/** Signal the daemon to shut down. */
export interface ShutdownCommand {
  readonly kind: 'shutdown';
}

/**
 * Query per-agent context health (DEC-035, issue #77).
 *
 * When `agentId` is present the response contains at most that agent's
 * snapshot; otherwise every tracked agent is returned. Powers
 * `secretary status` and the desktop fleet view.
 */
export interface QueryContextHealthCommand {
  readonly kind: 'context-health';
  readonly agentId?: string;
}

/** Query the latest completion digest for a task (issue #37). */
export interface GetDigestCommand {
  readonly kind: 'get-digest';
  readonly taskId: string;
}

/**
 * Create a pull request for a task's branch (issue #27).
 *
 * Invoked by the side-by-side digest & diff viewer's "Create PR" action. The
 * daemon resolves the task's worktree/branch and initiates PR creation. The
 * `title` and `body` are optional; when omitted the head commit message is
 * used as the title.
 */
export interface CreatePrCommand {
  readonly kind: 'create-pr';
  readonly taskId: string;
  /** Optional PR title (defaults to the head commit subject). */
  readonly title?: string;
  /** Optional PR body/description. */
  readonly body?: string;
}

/**
 * The canonical discriminated union of all commands (DEC-026).
 *
 * The `kind` field is the discriminant; {@link CommandApi.execute} switches
 * on it to dispatch to the correct handler.
 */
export type Command =
  | StartTaskCommand
  | StopTaskCommand
  | ApproveCommand
  | QueryInboxCommand
  | RaiseAttentionCommand
  | AcknowledgeItemCommand
  | ResolveItemCommand
  | EscalateItemCommand
  | QueryMetricsCommand
  | QueryTaskCommand
  | ListTasksCommand
  | PruneWorktreeCommand
  | ShutdownCommand
  | QueryContextHealthCommand
  | GetDigestCommand
  | CreatePrCommand;

/** Ordered list of all valid command `kind` discriminants. */
export const COMMAND_KINDS: readonly string[] = [
  'start-task',
  'stop-task',
  'approve',
  'query-inbox',
  'raise-attention',
  'ack-item',
  'resolve-item',
  'escalate-item',
  'query-metrics',
  'query-task',
  'list-tasks',
  'prune-worktree',
  'shutdown',
  'context-health',
  'get-digest',
  'create-pr',
] as const;

/* ================================================================== *
 * Response union
 * ================================================================== */

export interface StartTaskResponse {
  readonly ok: boolean;
  readonly taskId: string;
  readonly sessionId: string;
  readonly error?: string;
}

export interface StopTaskResponse {
  readonly ok: boolean;
  readonly taskId: string;
  readonly error?: string;
}

export interface ApproveResponse {
  readonly ok: boolean;
  readonly approvalId: string;
  readonly error?: string;
}

export interface InboxResponse {
  readonly ok: boolean;
  readonly items: AttentionItemSnapshot[];
}

export interface ItemMutationResponse {
  readonly ok: boolean;
  readonly itemId: string;
  readonly error?: string;
}

/** Response to `raise-attention` — carries the created item id. */
export type RaiseAttentionResponse = ItemMutationResponse;

export interface MetricsResponse {
  readonly ok: boolean;
  readonly snapshot: MetricsSnapshot | null;
  /**
   * Attention Compression Ratio and supplemental metrics report (DEC-015,
   * issue #18). Present only when a `metricsQueryService` is wired into the
   * {@link CommandApiDeps}.
   */
  readonly attentionMetrics?: AttentionMetricsReport;
}

export interface TaskResponse {
  readonly ok: boolean;
  readonly task: TaskSnapshot | null;
}

export interface TaskListResponse {
  readonly ok: boolean;
  readonly tasks: TaskSnapshot[];
}

export interface PruneResponse {
  readonly ok: boolean;
  readonly taskId: string;
  readonly error?: string;
}

export interface ShutdownResponse {
  readonly ok: boolean;
}

/** Response to a `get-digest` command (issue #37). */
export interface DigestResponse {
  readonly ok: boolean;
  readonly digest: CompletionDigest | null;
  readonly error?: string;
}

/**
 * Response to a `create-pr` command (issue #27).
 *
 * On success, `branch` is the branch the PR targets and `headCommit` is the
 * head SHA. `prUrl` is populated when the hosting provider returns a URL.
 */
export interface CreatePrResponse {
  readonly ok: boolean;
  readonly taskId: string;
  readonly branch?: string;
  readonly headCommit?: string;
  readonly prUrl?: string;
  readonly error?: string;
}

/** Response to `context-health` — per-agent health snapshots (issue #77). */
export interface ContextHealthResponse {
  readonly ok: boolean;
  readonly snapshots: readonly ContextHealthSnapshot[];
}

/** Generic error response for unknown / malformed commands. */
export interface UnknownCommandResponse {
  readonly ok: false;
  readonly error: string;
}

/**
 * Union of every response variant. {@link CommandApi.execute} returns a
 * member of this union; the caller knows which variant to expect based on
 * the command `kind` they sent.
 */
export type Response =
  | StartTaskResponse
  | StopTaskResponse
  | ApproveResponse
  | InboxResponse
  | ItemMutationResponse
  | RaiseAttentionResponse
  | MetricsResponse
  | TaskResponse
  | TaskListResponse
  | PruneResponse
  | ShutdownResponse
  | DigestResponse
  | CreatePrResponse
  | ContextHealthResponse
  | UnknownCommandResponse;

/* ================================================================== *
 * Dependency interfaces (structural â€” easy to mock in tests)
 * ================================================================== */

/**
 * Read-side projection of the context-health monitor (DEC-035, issue
 * #77). The command API only reads snapshots — tracking and emission
 * stay inside the monitor.
 */
export interface ContextHealthReadPort {
  snapshot(agentId: string): ContextHealthSnapshot | undefined;
  listSnapshots(): ContextHealthSnapshot[];
}

/**
 * Minimal task data-access interface needed by {@link CommandApi}.
 *
 * A narrowed projection of the core {@link TaskRepositoryPort}: the real
 * `TaskRepository` satisfies it, and tests provide an in-memory mock.
 */
export type TaskStore = Pick<TaskRepositoryPort, 'getById' | 'listAll' | 'update'>;

/**
 * Minimal approval data-access interface needed by {@link CommandApi}.
 * A narrowed projection of the core {@link ApprovalRepositoryPort}; the
 * real `ApprovalRepository` satisfies both methods.
 */
export type ApprovalStore = Pick<ApprovalRepositoryPort, 'getById' | 'update'>;

/**
 * Minimal session data-access interface needed by {@link CommandApi}.
 * A narrowed projection of the core {@link SessionRepositoryPort}; the
 * real `SessionRepository` satisfies both methods. `delete` is used to
 * roll back an inserted session row when a subsequent step in `start-task`
 * fails before any journal events reference the session.
 */
export type SessionStore = Pick<SessionRepositoryPort, 'insert' | 'delete'>;

/**
 * Dependencies injected into {@link CommandApi}.
 *
 * The six core dependencies match the issue specification. `taskStore`,
 * `approvalStore`, and `sessionStore` are added because `query-task`,
 * `list-tasks`, `prune-worktree`, `approve`, and `start-task` require direct
 * data access not exposed by the other deps. `onShutdown` is an optional
 * callback invoked when the `shutdown` command is received.
 */
export interface CommandApiDeps {
  readonly eventBus: EventPublisherPort;
  readonly taskStateMachine: TaskStateMachine;
  readonly attentionInbox: AttentionInbox;
  readonly metricsCollector: MetricsCollector;
  readonly worktreeManager: WorktreePort;
  readonly eventRepository: EventJournalPort;
  readonly taskStore: TaskStore;
  readonly approvalStore: ApprovalStore;
  readonly sessionStore: SessionStore;
  /** Optional callback invoked when the `shutdown` command is received. */
  readonly onShutdown?: () => void;
  /**
   * Optional adapter registry. When present (along with `sessionManager`),
   * `start-task` looks up an adapter by `agentId` and starts an agent
   * session that pipes normalized events onto the EventBus (issue #35).
   */
  readonly adapterRegistry?: AgentRuntimeRegistryPort;
  /**
   * Optional session manager. When present, `start-task` uses it to manage
   * the adapter lifecycle and `stop-task` uses it to cancel/disconnect the
   * active session (issue #35).
   */
  readonly sessionManager?: SessionManager;
  /**
   * Optional completion-digest repository. When present, the `get-digest`
   * command queries it for the latest digest for a task (issue #37).
   */
  readonly completionDigestRepository?: CompletionDigestRepositoryPort<CompletionDigest>;
  /**
   * Optional attention-metrics query service (DEC-015, issue #18). When
   * present, `query-metrics` computes the ACR + supplemental metrics report
   * for the requested time window / project / task and returns it as
   * `attentionMetrics` on the {@link MetricsResponse}.
   */
  readonly metricsQueryService?: MetricsQueryService;
  /**
   * Read-side of the context-health monitor (DEC-035, issue #77). When
   * wired, `context-health` commands return per-agent window-fill
   * snapshots; when absent the command returns an empty list.
   */
  readonly contextHealth?: ContextHealthReadPort;
}

/* ================================================================== *
 * CommandApi
 * ================================================================== */

/**
 * Minimal structural surface of the typed command API — the system's
 * driving port (DEC-002, DEC-037). Every inbound surface (CLI, voice,
 * desktop, MCP) ultimately funnels typed {@link Command}s through an
 * object shaped like this: the daemon's {@link CommandApi} itself, or a
 * transport proxy that forwards commands to it.
 */
export interface CommandExecutor {
  execute(command: Command): Promise<Response>;
}

/**
 * Typed command API shared by every surface (CLI, voice, desktop, remote).
 *
 * Construct with a {@link CommandApiDeps} object, then call
 * {@link CommandApi.execute} with a {@link Command}. Each handler validates
 * input, performs the action against the injected dependencies, and returns
 * a typed {@link Response}.
 */
export class CommandApi {
  private readonly eventBus: EventPublisherPort;
  private readonly taskStateMachine: TaskStateMachine;
  private readonly attentionInbox: AttentionInbox;
  private readonly metricsCollector: MetricsCollector;
  private readonly worktreeManager: WorktreePort;
  private readonly eventRepository: EventJournalPort;
  private readonly taskStore: TaskStore;
  private readonly approvalStore: ApprovalStore;
  private readonly sessionStore: SessionStore;
  private readonly onShutdown?: () => void;
  private readonly adapterRegistry?: AgentRuntimeRegistryPort;
  private readonly sessionManager?: SessionManager;
  private readonly completionDigestRepository?: CompletionDigestRepositoryPort<CompletionDigest>;
  private readonly metricsQueryService?: MetricsQueryService;
  private readonly contextHealth?: ContextHealthReadPort;

  /** Whether a `shutdown` command has been received. */
  private shutdownRequested = false;

  constructor(deps: CommandApiDeps) {
    this.eventBus = deps.eventBus;
    this.taskStateMachine = deps.taskStateMachine;
    this.attentionInbox = deps.attentionInbox;
    this.metricsCollector = deps.metricsCollector;
    this.worktreeManager = deps.worktreeManager;
    this.eventRepository = deps.eventRepository;
    this.taskStore = deps.taskStore;
    this.approvalStore = deps.approvalStore;
    this.sessionStore = deps.sessionStore;
    this.onShutdown = deps.onShutdown;
    this.adapterRegistry = deps.adapterRegistry;
    this.sessionManager = deps.sessionManager;
    this.completionDigestRepository = deps.completionDigestRepository;
    this.metricsQueryService = deps.metricsQueryService;
    this.contextHealth = deps.contextHealth;
  }

  /** Whether a `shutdown` command has been received. */
  get isShutdownRequested(): boolean {
    return this.shutdownRequested;
  }

  /**
   * Dispatch a {@link Command} to the appropriate handler and return a
   * typed {@link Response}.
   *
   * Unknown command kinds (only possible at runtime) return an
   * {@link UnknownCommandResponse}.
   */
  async execute(command: Command): Promise<Response> {
    switch (command.kind) {
      case 'start-task':
        return this.handleStartTask(command);
      case 'stop-task':
        return this.handleStopTask(command);
      case 'approve':
        return this.handleApprove(command);
      case 'query-inbox':
        return this.handleQueryInbox(command);
      case 'raise-attention':
        return this.handleRaiseAttention(command);
      case 'ack-item':
        return this.handleAcknowledgeItem(command);
      case 'resolve-item':
        return this.handleResolveItem(command);
      case 'escalate-item':
        return this.handleEscalateItem(command);
      case 'query-metrics':
        return this.handleQueryMetrics(command);
      case 'query-task':
        return this.handleQueryTask(command);
      case 'list-tasks':
        return this.handleListTasks(command);
      case 'prune-worktree':
        return this.handlePruneWorktree(command);
      case 'shutdown':
        return this.handleShutdown(command);
      case 'context-health':
        return this.handleContextHealth(command);
      case 'get-digest':
        return this.handleGetDigest(command);
      case 'create-pr':
        return this.handleCreatePr(command);
      default:
        return {
          ok: false,
          error: `Unknown command kind: ${(command as { kind?: string }).kind ?? '<missing>'}`,
        };
    }
  }

  /* ---------------------------------------------------------------- *
   * Handlers
   * ---------------------------------------------------------------- */

  /** start-task: delegate a task to an agent and create a session. */
  private async handleStartTask(cmd: StartTaskCommand): Promise<StartTaskResponse> {
    if (!cmd.taskId) {
      return { ok: false, taskId: '', sessionId: '', error: 'taskId is required' };
    }
    if (!cmd.agentId) {
      return { ok: false, taskId: cmd.taskId, sessionId: '', error: 'agentId is required' };
    }
    if (!cmd.sessionConfig?.workingDir) {
      return {
        ok: false,
        taskId: cmd.taskId,
        sessionId: '',
        error: 'sessionConfig.workingDir is required',
      };
    }

    const task = this.taskStore.getById(cmd.taskId);
    if (task === null) {
      return {
        ok: false,
        taskId: cmd.taskId,
        sessionId: '',
        error: `Task not found: ${cmd.taskId}`,
      };
    }

    // Determine the transition based on the current state.
    let currentState: TaskStateType;
    try {
      currentState = this.taskStateMachine.getCurrentState(cmd.taskId);
    } catch {
      return {
        ok: false,
        taskId: cmd.taskId,
        sessionId: '',
        error: `Task not found: ${cmd.taskId}`,
      };
    }

    // Validate the state transition is possible before any side effects.
    // This ensures we fail fast without mutating DB state or starting an
    // adapter session that would then need to be rolled back.
    // `blocked` and `attention-needed` are resumable states: a parked
    // (quota-exhausted) or attention-flagged task starts again by
    // transitioning to `running` (issue #64 failover/park-resume).
    const startable =
      currentState === TaskState.Created ||
      currentState === TaskState.Delegated ||
      currentState === TaskState.Blocked ||
      currentState === TaskState.AttentionNeeded;
    if (!startable) {
      return {
        ok: false,
        taskId: cmd.taskId,
        sessionId: '',
        error: `Task is in state "${currentState}" and cannot be started`,
      };
    }

    const sessionId = generateId('session');
    const ctx: TransitionContext = {
      sessionId,
      agentId: cmd.agentId,
      payload: {
        agentId: cmd.agentId,
        workingDir: cmd.sessionConfig.workingDir,
        model: cmd.sessionConfig.model ?? null,
      },
    };

    // --- Start the adapter session FIRST (if configured) ---
    // If the adapter fails to start, no DB state has been mutated, so the
    // task remains in its original state and the caller can retry with a
    // different agent or after fixing the adapter (issue #35 audit fix).
    if (this.adapterRegistry && this.sessionManager) {
      let adapter: AgentRuntimePort;
      try {
        adapter = this.adapterRegistry.create(cmd.agentId);
      } catch (err) {
        return {
          ok: false,
          taskId: cmd.taskId,
          sessionId: '',
          error: `Unknown or unavailable adapter for agent "${cmd.agentId}": ${errorMessage(err)}`,
        };
      }
      const adapterSessionConfig: AdapterSessionConfig = {
        taskId: cmd.taskId,
        sessionId,
        agentId: cmd.agentId,
        workingDir: cmd.sessionConfig.workingDir,
        objective: cmd.sessionConfig.prompt ?? task.objective,
        model: cmd.sessionConfig.model,
        autonomyLevel: cmd.sessionConfig.autonomyLevel,
      };
      const sessionResult = await this.sessionManager.startSession(
        cmd.taskId,
        cmd.agentId,
        adapter,
        adapterSessionConfig,
      );
      if (!sessionResult.ok) {
        return {
          ok: false,
          taskId: cmd.taskId,
          sessionId: '',
          error: sessionResult.error ?? 'Failed to start adapter session',
        };
      }
    }

    // --- Persist the session row ---
    // Insert before transitioning so the events table FK
    // (session_id â†’ sessions.id) is satisfied when the state machine appends
    // the transition event to the journal (DEC-012).
    const session: Session = {
      id: sessionId,
      taskId: cmd.taskId,
      agentId: cmd.agentId,
      status: 'running',
      startedAt: new Date().toISOString(),
      eventIds: [],
      deliverableIds: [],
      capsuleId: generateId('capsule'),
    };
    try {
      this.sessionStore.insert(session);
    } catch (err) {
      await this.rollbackAdapterSession(cmd.taskId);
      return {
        ok: false,
        taskId: cmd.taskId,
        sessionId: '',
        error: `Failed to create session: ${errorMessage(err)}`,
      };
    }

    // --- Update the task to record the new session and agent ---
    // so that subsequent commands (e.g. stop-task) can resolve the correct
    // sessionId/agentId from the task row.
    try {
      this.taskStore.update({
        ...task,
        sessionIds: [...task.sessionIds, sessionId],
        agentIds: task.agentIds.includes(cmd.agentId)
          ? task.agentIds
          : [...task.agentIds, cmd.agentId],
      });
    } catch (err) {
      this.rollbackSessionRow(sessionId);
      await this.rollbackAdapterSession(cmd.taskId);
      return {
        ok: false,
        taskId: cmd.taskId,
        sessionId: '',
        error: `Failed to update task: ${errorMessage(err)}`,
      };
    }

    // --- Transition the task state ---
    // The state machine appends a journal event (with session_id FK) and
    // updates the task row. If it throws, no journal event was written, so
    // the session row can be safely deleted.
    try {
      if (currentState === TaskState.Created) {
        this.taskStateMachine.transition(cmd.taskId, TaskState.Created, TaskState.Delegated, ctx);
      } else {
        this.taskStateMachine.transition(cmd.taskId, currentState, TaskState.Running, ctx);
      }
    } catch (err) {
      // Revert the task update to remove the phantom sessionId/agentId.
      this.taskStore.update(task);
      this.rollbackSessionRow(sessionId);
      await this.rollbackAdapterSession(cmd.taskId);
      return {
        ok: false,
        taskId: cmd.taskId,
        sessionId: '',
        error: `Failed to start task: ${errorMessage(err)}`,
      };
    }

    // --- Publish an AgentStarted event on the live event bus ---
    const event: AgentStartedEvent = {
      type: 'AgentStarted',
      timestamp: new Date().toISOString(),
      taskId: cmd.taskId,
      sessionId,
      agentId: cmd.agentId,
      adapterFidelityTier: cmd.sessionConfig.adapterFidelityTier ?? 'B',
      objective: task.objective,
      workingDir: cmd.sessionConfig.workingDir,
      model: cmd.sessionConfig.model,
      autonomyLevel: cmd.sessionConfig.autonomyLevel,
    };
    this.eventBus.publish(event);

    return { ok: true, taskId: cmd.taskId, sessionId };
  }

  /**
   * Roll back an adapter session by stopping it via the session manager.
   * Used when a subsequent step in `start-task` fails after the adapter
   * session was already started. Best-effort: errors are swallowed so the
   * caller's error is not masked.
   */
  private async rollbackAdapterSession(taskId: string): Promise<void> {
    if (this.sessionManager) {
      try {
        await this.sessionManager.stopSession(taskId);
      } catch {
        /* best-effort â€” don't mask the original error */
      }
    }
  }

  /**
   * Remove a session row that was inserted but never referenced by any
   * journal event (e.g. the state machine transition failed before
   * appending an event). Best-effort: errors are swallowed.
   */
  private rollbackSessionRow(sessionId: string): void {
    try {
      this.sessionStore.delete(sessionId);
    } catch {
      /* best-effort â€” the row may be orphaned but won't cause issues */
    }
  }

  /** stop-task: cancel a running task. */
  private async handleStopTask(cmd: StopTaskCommand): Promise<StopTaskResponse> {
    if (!cmd.taskId) {
      return { ok: false, taskId: '', error: 'taskId is required' };
    }

    const task = this.taskStore.getById(cmd.taskId);
    if (task === null) {
      return { ok: false, taskId: cmd.taskId, error: `Task not found: ${cmd.taskId}` };
    }

    let currentState: TaskStateType;
    try {
      currentState = this.taskStateMachine.getCurrentState(cmd.taskId);
    } catch {
      return { ok: false, taskId: cmd.taskId, error: `Task not found: ${cmd.taskId}` };
    }

    if (isTerminalState(currentState)) {
      return {
        ok: false,
        taskId: cmd.taskId,
        error: `Task is already in terminal state "${currentState}"`,
      };
    }

    const sessionId = task.sessionIds[task.sessionIds.length - 1] ?? 'unknown';
    const agentId = task.agentIds[task.agentIds.length - 1] ?? 'unknown';
    const ctx: TransitionContext = {
      sessionId,
      agentId,
      payload: { reason: cmd.reason ?? 'user' },
    };

    try {
      this.taskStateMachine.transition(cmd.taskId, currentState, TaskState.Cancelled, ctx);
    } catch (err) {
      return {
        ok: false,
        taskId: cmd.taskId,
        error: `Failed to stop task: ${errorMessage(err)}`,
      };
    }

    // Publish an AgentStopped event on the live event bus.
    const event: AgentStoppedEvent = {
      type: 'AgentStopped',
      timestamp: new Date().toISOString(),
      taskId: cmd.taskId,
      sessionId,
      agentId,
      adapterFidelityTier: 'B',
      reason: 'user',
      details: cmd.reason,
    };
    this.eventBus.publish(event);

    // Tear down the adapter session (issue #35). Best-effort: the task
    // state transition already succeeded, so a missing or failing session
    // stop does not change the response. The session manager cancels the
    // adapter run and disconnects it.
    if (this.sessionManager) {
      await this.sessionManager.stopSession(cmd.taskId);
    }

    return { ok: true, taskId: cmd.taskId };
  }

  /** approve: grant or deny a pending approval. */
  private async handleApprove(cmd: ApproveCommand): Promise<ApproveResponse> {
    if (!cmd.taskId) {
      return { ok: false, approvalId: '', error: 'taskId is required' };
    }
    if (!cmd.approvalId) {
      return { ok: false, approvalId: '', error: 'approvalId is required' };
    }
    if (cmd.decision !== 'grant' && cmd.decision !== 'deny') {
      return {
        ok: false,
        approvalId: cmd.approvalId,
        error: `Invalid decision: "${cmd.decision}" (must be "grant" or "deny")`,
      };
    }

    const approval = this.approvalStore.getById(cmd.approvalId);
    if (approval === null) {
      return {
        ok: false,
        approvalId: cmd.approvalId,
        error: `Approval not found: ${cmd.approvalId}`,
      };
    }

    if (approval.taskId !== cmd.taskId) {
      return {
        ok: false,
        approvalId: cmd.approvalId,
        error: `Approval ${cmd.approvalId} does not belong to task ${cmd.taskId}`,
      };
    }

    const updated: Approval = {
      ...approval,
      granted: cmd.decision === 'grant',
      grantedAt: new Date().toISOString(),
    };

    try {
      this.approvalStore.update(updated);
    } catch (err) {
      return {
        ok: false,
        approvalId: cmd.approvalId,
        error: `Failed to update approval: ${errorMessage(err)}`,
      };
    }

    if (cmd.decision === 'grant') {
      this.metricsCollector.recordApprovalGranted(cmd.taskId);
    } else {
      this.metricsCollector.recordApprovalDenied(cmd.taskId);
    }

    return { ok: true, approvalId: cmd.approvalId };
  }

  /** query-inbox: list attention items, optionally filtered. */
  private async handleQueryInbox(cmd: QueryInboxCommand): Promise<InboxResponse> {
    const items = this.attentionInbox.list(cmd.filter);
    return { ok: true, items: items.map(toAttentionItemSnapshot) };
  }

  /** ack-item: acknowledge an attention item. */
  private async handleAcknowledgeItem(cmd: AcknowledgeItemCommand): Promise<ItemMutationResponse> {
    if (!cmd.itemId) {
      return { ok: false, itemId: '', error: 'itemId is required' };
    }
    const found = this.attentionInbox.acknowledge(cmd.itemId);
    if (!found) {
      return { ok: false, itemId: cmd.itemId, error: `Attention item not found: ${cmd.itemId}` };
    }
    return { ok: true, itemId: cmd.itemId };
  }

  /**
   * raise-attention: surface a question or decision to the human.
   *
   * Used by manager agents (`secretary_request_human_input`) and daemon
   * subsystems to create inbox items through the typed command path rather
   * than a side channel (DEC-002/014, issue #63).
   */
  private async handleRaiseAttention(cmd: RaiseAttentionCommand): Promise<RaiseAttentionResponse> {
    if (!cmd.taskId) {
      return { ok: false, itemId: '', error: 'taskId is required' };
    }
    if (!cmd.summary || cmd.summary.trim().length === 0) {
      return { ok: false, itemId: '', error: 'summary is required' };
    }
    const itemKind = cmd.itemKind ?? 'Custom';
    if (!ATTENTION_ITEM_KINDS.includes(itemKind)) {
      return { ok: false, itemId: '', error: `unknown attention item kind: ${itemKind}` };
    }
    const priority = cmd.priority ?? 'Medium';
    if (!PRIORITY_ORDER.includes(priority)) {
      return { ok: false, itemId: '', error: `unknown attention priority: ${priority}` };
    }
    const item = createAttentionItem({
      taskId: cmd.taskId,
      kind: itemKind,
      priority,
      payload: {
        summary: cmd.summary,
        details: cmd.details ?? null,
        ...(cmd.source !== undefined ? { source: cmd.source } : {}),
      },
    });
    this.attentionInbox.add(item);
    return { ok: true, itemId: item.id };
  }

  /** resolve-item: resolve an attention item. */
  private async handleResolveItem(cmd: ResolveItemCommand): Promise<ItemMutationResponse> {
    if (!cmd.itemId) {
      return { ok: false, itemId: '', error: 'itemId is required' };
    }
    const found = this.attentionInbox.resolve(cmd.itemId);
    if (!found) {
      return { ok: false, itemId: cmd.itemId, error: `Attention item not found: ${cmd.itemId}` };
    }
    return { ok: true, itemId: cmd.itemId };
  }

  /** escalate-item: escalate an attention item to Critical priority. */
  private async handleEscalateItem(cmd: EscalateItemCommand): Promise<ItemMutationResponse> {
    if (!cmd.itemId) {
      return { ok: false, itemId: '', error: 'itemId is required' };
    }
    const found = this.attentionInbox.escalate(cmd.itemId);
    if (!found) {
      return { ok: false, itemId: cmd.itemId, error: `Attention item not found: ${cmd.itemId}` };
    }
    return { ok: true, itemId: cmd.itemId };
  }

  /** query-metrics: return the current metrics snapshot. */
  private async handleQueryMetrics(cmd: QueryMetricsCommand): Promise<MetricsResponse> {
    const snapshot = this.metricsCollector.snapshot();

    // When a metrics query service is wired, also compute the ACR +
    // supplemental metrics report (DEC-015) for the requested window /
    // project / task. All computation is deterministic and LLM-free.
    if (this.metricsQueryService !== undefined) {
      const opts: MetricsQueryOptions = {
        ...(cmd.since !== undefined ? { since: new Date(cmd.since).toISOString() } : {}),
        ...(cmd.until !== undefined ? { until: new Date(cmd.until).toISOString() } : {}),
        ...(cmd.projectId !== undefined ? { projectId: cmd.projectId } : {}),
        ...(cmd.taskId !== undefined ? { taskId: cmd.taskId } : {}),
      };
      const attentionMetrics = this.metricsQueryService.query(opts);
      return { ok: true, snapshot, attentionMetrics };
    }

    return { ok: true, snapshot };
  }

  /** query-task: return a single task snapshot by id. */
  private async handleQueryTask(cmd: QueryTaskCommand): Promise<TaskResponse> {
    if (!cmd.taskId) {
      return { ok: false, task: null };
    }
    const task = this.taskStore.getById(cmd.taskId);
    if (task === null) {
      return { ok: false, task: null };
    }
    const eventCount = this.eventRepository.listByTask(cmd.taskId).length;
    return { ok: true, task: toTaskSnapshot(task, eventCount) };
  }

  /** list-tasks: list all tasks, optionally filtered by status. */
  private async handleListTasks(cmd: ListTasksCommand): Promise<TaskListResponse> {
    let tasks = this.taskStore.listAll();
    if (cmd.status !== undefined) {
      tasks = tasks.filter((t) => t.state === cmd.status);
    }
    return {
      ok: true,
      tasks: tasks.map((t) => toTaskSnapshot(t, this.eventRepository.listByTask(t.id).length)),
    };
  }

  /** prune-worktree: prune a task's git worktree (only if clean). */
  private async handlePruneWorktree(cmd: PruneWorktreeCommand): Promise<PruneResponse> {
    if (!cmd.taskId) {
      return { ok: false, taskId: '', error: 'taskId is required' };
    }
    const task = this.taskStore.getById(cmd.taskId);
    if (task === null) {
      return { ok: false, taskId: cmd.taskId, error: `Task not found: ${cmd.taskId}` };
    }
    if (!task.worktreePath) {
      return {
        ok: false,
        taskId: cmd.taskId,
        error: `Task ${cmd.taskId} has no worktree path`,
      };
    }
    try {
      this.worktreeManager.pruneWorktree(task.worktreePath);
    } catch (err) {
      if (err instanceof DirtyWorktreeError) {
        return {
          ok: false,
          taskId: cmd.taskId,
          error: `Worktree is dirty and cannot be pruned: ${err.worktreePath}`,
        };
      }
      return {
        ok: false,
        taskId: cmd.taskId,
        error: `Failed to prune worktree: ${errorMessage(err)}`,
      };
    }
    return { ok: true, taskId: cmd.taskId };
  }

  /** shutdown: signal the daemon to shut down. */
  private async handleShutdown(_cmd: ShutdownCommand): Promise<ShutdownResponse> {
    this.shutdownRequested = true;
    this.onShutdown?.();
    return { ok: true };
  }

  /**
   * context-health: per-agent window-fill snapshots (DEC-035, issue #77).
   *
   * When no monitor is wired the response is an empty list — the command
   * itself is still well-formed so `secretary status` degrades cleanly.
   */
  private async handleContextHealth(
    cmd: QueryContextHealthCommand,
  ): Promise<ContextHealthResponse> {
    if (this.contextHealth === undefined) {
      return { ok: true, snapshots: [] };
    }
    if (cmd.agentId !== undefined) {
      const snapshot = this.contextHealth.snapshot(cmd.agentId);
      return { ok: true, snapshots: snapshot === undefined ? [] : [snapshot] };
    }
    return { ok: true, snapshots: this.contextHealth.listSnapshots() };
  }

  /** get-digest: return the latest completion digest for a task (issue #37). */
  private async handleGetDigest(cmd: GetDigestCommand): Promise<DigestResponse> {
    if (!cmd.taskId) {
      return { ok: false, digest: null, error: 'taskId is required' };
    }
    if (!this.completionDigestRepository) {
      return {
        ok: false,
        digest: null,
        error: 'Completion digest repository is not configured',
      };
    }
    try {
      const digest = this.completionDigestRepository.findByTaskId(cmd.taskId);
      return { ok: true, digest };
    } catch (err) {
      return {
        ok: false,
        digest: null,
        error: `Failed to query digest: ${errorMessage(err)}`,
      };
    }
  }

  /**
   * create-pr: initiate pull-request creation for a task's branch (issue #27).
   *
   * Validates the task exists and has a worktree, resolves the branch and head
   * commit, and returns them so the caller (renderer/CLI) can complete PR
   * creation with the hosting provider. The actual push/PR-creation step is
   * delegated to an authorized downstream integration; this handler does not
   * perform network actions or widen permissions (DEC-011).
   */
  private async handleCreatePr(cmd: CreatePrCommand): Promise<CreatePrResponse> {
    if (!cmd.taskId) {
      return { ok: false, taskId: '', error: 'taskId is required' };
    }
    const task = this.taskStore.getById(cmd.taskId);
    if (task === null) {
      return { ok: false, taskId: cmd.taskId, error: `Task not found: ${cmd.taskId}` };
    }
    if (!task.worktreePath) {
      return {
        ok: false,
        taskId: cmd.taskId,
        error: `Task has no worktree: ${cmd.taskId}`,
      };
    }
    try {
      const status = this.worktreeManager.worktreeStatus(task.worktreePath);
      return {
        ok: true,
        taskId: cmd.taskId,
        branch: status.branch,
        headCommit: status.baseCommit,
      };
    } catch (err) {
      return {
        ok: false,
        taskId: cmd.taskId,
        error: `Failed to resolve worktree status: ${errorMessage(err)}`,
      };
    }
  }
}

/* ================================================================== *
 * Internal helpers
 * ================================================================== */

/** Terminal task states â€” no further transitions permitted. */
const TERMINAL_STATES: ReadonlySet<TaskStateType> = new Set<TaskStateType>([
  TaskState.Accepted,
  TaskState.Failed,
  TaskState.Cancelled,
]);

/** Whether a task state is terminal. */
function isTerminalState(state: TaskStateType): boolean {
  return TERMINAL_STATES.has(state);
}

/** Generate a reasonably unique id without a crypto dependency. */
function generateId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

/** Extract a human-readable message from an unknown error. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Map an {@link AttentionItem} to a serializable snapshot. */
function toAttentionItemSnapshot(item: AttentionItem): AttentionItemSnapshot {
  return {
    id: item.id,
    taskId: item.taskId,
    kind: item.kind,
    priority: item.priority,
    status: item.status,
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
    payload: item.payload,
  };
}

/** Map a {@link Task} to a serializable snapshot with an event count. */
function toTaskSnapshot(task: Task, eventCount: number): TaskSnapshot {
  return {
    id: task.id,
    projectId: task.projectId,
    objective: task.objective,
    state: task.state,
    agentIds: [...task.agentIds],
    sessionIds: [...task.sessionIds],
    worktreePath: task.worktreePath,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    eventCount,
  };
}

/**
 * Type-level mapping from a {@link Command} variant to its expected
 * {@link Response} variant. Useful for callers that want compile-time
 * narrowing of the response based on the command they sent.
 *
 * @example
 * const res = await api.execute({ kind: 'shutdown' } as ShutdownCommand);
 * // res is narrowed to ShutdownResponse
 */
export type CommandResponse<C extends Command> = C extends StartTaskCommand
  ? StartTaskResponse
  : C extends StopTaskCommand
    ? StopTaskResponse
    : C extends ApproveCommand
      ? ApproveResponse
      : C extends QueryInboxCommand
        ? InboxResponse
        : C extends RaiseAttentionCommand
          ? RaiseAttentionResponse
          : C extends AcknowledgeItemCommand
            ? ItemMutationResponse
            : C extends ResolveItemCommand
              ? ItemMutationResponse
              : C extends EscalateItemCommand
                ? ItemMutationResponse
                : C extends QueryMetricsCommand
                  ? MetricsResponse
                  : C extends QueryTaskCommand
                    ? TaskResponse
                    : C extends ListTasksCommand
                      ? TaskListResponse
                      : C extends PruneWorktreeCommand
                        ? PruneResponse
                        : C extends ShutdownCommand
                          ? ShutdownResponse
                          : C extends QueryContextHealthCommand
                            ? ContextHealthResponse
                            : C extends GetDigestCommand
                              ? DigestResponse
                              : C extends CreatePrCommand
                                ? CreatePrResponse
                                : Response;

/**
 * Narrowing wrapper around {@link CommandApi.execute} that returns the
 * response typed as {@link CommandResponse} for the given command.
 *
 * This is a convenience function for callers that want the response narrowed
 * to the specific variant matching their command.
 */
export async function executeCommand<C extends Command>(
  api: CommandApi,
  command: C,
): Promise<CommandResponse<C>> {
  return (await api.execute(command)) as CommandResponse<C>;
}

// Re-export SupervisorEvent for the publish call type-checking.
// (The import is used in the EventBus.publish call signature.)
export type { SupervisorEvent };
