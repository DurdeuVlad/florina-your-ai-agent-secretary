/**
 * Typed command API for the Secretary daemon (issue #19, DEC-002, DEC-026).
 *
 * Voice and CLI share the same typed command API — voice is never a parallel
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
import type { AdapterFidelityTier } from '../domain/enums.js';
import { TaskState } from '../domain/enums.js';
import type { TaskState as TaskStateType } from '../domain/enums.js';
import type { Approval, Session, Task } from '../domain/types.js';
import type {
  AgentStartedEvent,
  AgentStoppedEvent,
  SupervisorEvent,
} from '../domain/events.js';
import type { AttentionItem } from '../attention/attention-item.js';
import type {
  AttentionInbox,
  AttentionInboxFilter,
} from '../attention/attention-inbox.js';
import type { EventBus } from './event-stream.js';
import type {
  TaskStateMachine,
  TransitionContext,
} from './task-lifecycle.js';
import type { MetricsCollector, MetricsSnapshot } from './metrics.js';
import type { WorktreeManager } from './worktree.js';
import { DirtyWorktreeError } from './worktree.js';
import type { EventRepository } from '../storage/repositories/event.js';

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
  | AcknowledgeItemCommand
  | ResolveItemCommand
  | EscalateItemCommand
  | QueryMetricsCommand
  | QueryTaskCommand
  | ListTasksCommand
  | PruneWorktreeCommand
  | ShutdownCommand;

/** Ordered list of all valid command `kind` discriminants. */
export const COMMAND_KINDS: readonly string[] = [
  'start-task',
  'stop-task',
  'approve',
  'query-inbox',
  'ack-item',
  'resolve-item',
  'escalate-item',
  'query-metrics',
  'query-task',
  'list-tasks',
  'prune-worktree',
  'shutdown',
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

export interface MetricsResponse {
  readonly ok: boolean;
  readonly snapshot: MetricsSnapshot | null;
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
  | MetricsResponse
  | TaskResponse
  | TaskListResponse
  | PruneResponse
  | ShutdownResponse
  | UnknownCommandResponse;

/* ================================================================== *
 * Dependency interfaces (structural — easy to mock in tests)
 * ================================================================== */

/**
 * Minimal task data-access interface needed by {@link CommandApi}.
 *
 * The real {@link TaskRepository} satisfies `getById`; `listAll` is not yet
 * on the repository but is required for the `list-tasks` command. A thin
 * adapter can bridge the two in production; tests provide an in-memory mock.
 */
export interface TaskStore {
  getById(taskId: string): Task | null;
  listAll(): readonly Task[];
}

/**
 * Minimal approval data-access interface needed by {@link CommandApi}.
 * The real {@link ApprovalRepository} satisfies both methods.
 */
export interface ApprovalStore {
  getById(approvalId: string): Approval | null;
  update(approval: Approval): void;
}

/**
 * Minimal session data-access interface needed by {@link CommandApi}.
 * The real {@link SessionRepository} satisfies `insert`.
 */
export interface SessionStore {
  insert(session: Session): void;
}

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
  readonly eventBus: EventBus;
  readonly taskStateMachine: TaskStateMachine;
  readonly attentionInbox: AttentionInbox;
  readonly metricsCollector: MetricsCollector;
  readonly worktreeManager: WorktreeManager;
  readonly eventRepository: EventRepository;
  readonly taskStore: TaskStore;
  readonly approvalStore: ApprovalStore;
  readonly sessionStore: SessionStore;
  /** Optional callback invoked when the `shutdown` command is received. */
  readonly onShutdown?: () => void;
}

/* ================================================================== *
 * CommandApi
 * ================================================================== */

/**
 * Typed command API shared by every surface (CLI, voice, desktop, remote).
 *
 * Construct with a {@link CommandApiDeps} object, then call
 * {@link CommandApi.execute} with a {@link Command}. Each handler validates
 * input, performs the action against the injected dependencies, and returns
 * a typed {@link Response}.
 */
export class CommandApi {
  private readonly eventBus: EventBus;
  private readonly taskStateMachine: TaskStateMachine;
  private readonly attentionInbox: AttentionInbox;
  private readonly metricsCollector: MetricsCollector;
  private readonly worktreeManager: WorktreeManager;
  private readonly eventRepository: EventRepository;
  private readonly taskStore: TaskStore;
  private readonly approvalStore: ApprovalStore;
  private readonly sessionStore: SessionStore;
  private readonly onShutdown?: () => void;

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
      return { ok: false, taskId: cmd.taskId, sessionId: '', error: `Task not found: ${cmd.taskId}` };
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

    // Persist the session row before transitioning so the events table FK
    // (session_id → sessions.id) is satisfied when the state machine appends
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
      return {
        ok: false,
        taskId: cmd.taskId,
        sessionId: '',
        error: `Failed to create session: ${errorMessage(err)}`,
      };
    }

    try {
      if (currentState === TaskState.Created) {
        this.taskStateMachine.transition(cmd.taskId, TaskState.Created, TaskState.Delegated, ctx);
      } else if (currentState === TaskState.Delegated) {
        this.taskStateMachine.transition(
          cmd.taskId,
          TaskState.Delegated,
          TaskState.Running,
          ctx,
        );
      } else {
        return {
          ok: false,
          taskId: cmd.taskId,
          sessionId: '',
          error: `Task is in state "${currentState}" and cannot be started`,
        };
      }
    } catch (err) {
      return {
        ok: false,
        taskId: cmd.taskId,
        sessionId: '',
        error: `Failed to start task: ${errorMessage(err)}`,
      };
    }

    // Publish an AgentStarted event on the live event bus.
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
  private async handleAcknowledgeItem(
    cmd: AcknowledgeItemCommand,
  ): Promise<ItemMutationResponse> {
    if (!cmd.itemId) {
      return { ok: false, itemId: '', error: 'itemId is required' };
    }
    const found = this.attentionInbox.acknowledge(cmd.itemId);
    if (!found) {
      return { ok: false, itemId: cmd.itemId, error: `Attention item not found: ${cmd.itemId}` };
    }
    return { ok: true, itemId: cmd.itemId };
  }

  /** resolve-item: resolve an attention item. */
  private async handleResolveItem(
    cmd: ResolveItemCommand,
  ): Promise<ItemMutationResponse> {
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
  private async handleEscalateItem(
    cmd: EscalateItemCommand,
  ): Promise<ItemMutationResponse> {
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
    // The `since` parameter is reserved for future time-filtered queries.
    // The current MetricsCollector returns a point-in-time snapshot.
    void cmd.since;
    const snapshot = this.metricsCollector.snapshot();
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
}

/* ================================================================== *
 * Internal helpers
 * ================================================================== */

/** Terminal task states — no further transitions permitted. */
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
