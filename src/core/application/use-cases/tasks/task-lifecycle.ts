/**
 * Task lifecycle state machine (DEC-004, DEC-018).
 *
 * A Task moves through a fixed set of states:
 *   `created -> delegated -> running -> attention-needed / blocked
 *    -> running -> completed -> reviewed / accepted`
 * plus `failed` and `cancelled` terminal states.
 *
 * Design rules enforced by this module:
 * - Every transition is validated against an explicit transition table.
 *   Illegal transitions throw `IllegalTransitionError`.
 * - A worker process terminating successfully does NOT equal task
 *   completion — the task stays `running` or moves to `attention-needed`
 *   until a human reviews it (PRODUCT_DESIGN.md "Task Lifecycle"). The
 *   `completed` state requires an explicit `reviewed` or `accepted`
 *   transition to close.
 * - Every successful transition appends a `SupervisorEvent` to the
 *   immutable event journal via `EventRepository.insert` (DEC-012) before
 *   the task state is considered persisted. The event `kind` is derived
 *   from the transition (e.g. `created->delegated` emits `AgentStarted`,
 *   `running->completed` emits `AgentCompleted`, `running->failed` emits
 *   `AgentFailed`, any `->cancelled` emits `AgentStopped`).
 * - Cancellation and failure are reachable from any non-terminal state.
 */
import type {
  EntityId,
  Event,
  ISODateString,
  SupervisorEventKind,
  Task,
} from '../../../domain/types.js';
import { TaskState } from '../../../domain/enums.js';
import type {
  EventJournalPort,
  TaskRepositoryPort,
} from '../../ports/outbound/repositories.js';

/**
 * Error thrown when a requested state transition is not permitted by the
 * transition table, or when the supplied `fromState` does not match the
 * task's current persisted state.
 */
export class IllegalTransitionError extends Error {
  readonly taskId: EntityId;
  readonly fromState: string;
  readonly toState: string;

  constructor(taskId: EntityId, fromState: string, toState: string, reason: string) {
    super(
      `Illegal task transition for task "${taskId}": ${fromState} -> ${toState}. ${reason}`,
    );
    this.name = 'IllegalTransitionError';
    this.taskId = taskId;
    this.fromState = fromState;
    this.toState = toState;
  }
}

/**
 * Terminal states — once reached, no further transitions are permitted
 * (including cancellation/failure).
 */
const TERMINAL_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  TaskState.Accepted,
  TaskState.Failed,
  TaskState.Cancelled,
]);

/**
 * The explicit transition table. Each key is a source state; the value is
 * the set of states reachable from it in a single guarded transition.
 *
 * This combines the per-state rules from PRODUCT_DESIGN.md "Task Lifecycle"
 * with the global cancellation/failure paths (any non-terminal state may
 * transition to `cancelled` or `failed`).
 */
const TRANSITION_TABLE: Readonly<Record<TaskState, readonly TaskState[]>> = {
  [TaskState.Created]: [
    TaskState.Delegated,
    TaskState.Cancelled,
    TaskState.Failed,
  ],
  [TaskState.Delegated]: [
    TaskState.Running,
    TaskState.Cancelled,
    TaskState.Failed,
  ],
  [TaskState.Running]: [
    TaskState.AttentionNeeded,
    TaskState.Blocked,
    TaskState.Completed,
    TaskState.Failed,
    TaskState.Cancelled,
  ],
  [TaskState.AttentionNeeded]: [
    TaskState.Running,
    TaskState.Blocked,
    TaskState.Failed,
    TaskState.Cancelled,
  ],
  [TaskState.Blocked]: [
    TaskState.Running,
    TaskState.Failed,
    TaskState.Cancelled,
  ],
  [TaskState.Completed]: [
    TaskState.Reviewed,
    TaskState.Accepted,
    TaskState.Failed,
    TaskState.Cancelled,
  ],
  [TaskState.Reviewed]: [
    TaskState.Accepted,
    TaskState.Failed,
    TaskState.Cancelled,
  ],
  [TaskState.Accepted]: [],
  [TaskState.Failed]: [],
  [TaskState.Cancelled]: [],
};

/**
 * Mapping from a concrete transition (`${from}->${to}`) to the canonical
 * `SupervisorEventKind` emitted into the journal.
 *
 * General rules:
 * - `-> cancelled` always emits `AgentStopped`.
 * - `-> failed` always emits `AgentFailed`.
 * - `created -> delegated` emits `AgentStarted` (delegation begins).
 * - `delegated -> running` emits `AgentProgress` (the agent begins work).
 * - `running -> completed` emits `AgentCompleted`.
 * - `running -> attention-needed` emits `ApprovalRequested` (human attention).
 * - `running -> blocked` / `attention-needed -> blocked` emits `AgentBlocked`.
 * - resuming to `running` (`attention-needed`/`blocked -> running`) emits
 *   `AgentProgress`.
 * - `completed -> reviewed` emits `AgentProgress` (review begins).
 * - `completed -> accepted` / `reviewed -> accepted` emits `AgentCompleted`
 *   (final closure).
 */
const TRANSITION_EVENT_KIND: Readonly<Record<string, SupervisorEventKind>> = {
  // created
  'created->delegated': 'AgentStarted',
  // delegated
  'delegated->running': 'AgentProgress',
  // running
  'running->attention-needed': 'ApprovalRequested',
  'running->blocked': 'AgentBlocked',
  'running->completed': 'AgentCompleted',
  // attention-needed
  'attention-needed->running': 'AgentProgress',
  'attention-needed->blocked': 'AgentBlocked',
  // blocked
  'blocked->running': 'AgentProgress',
  // completed
  'completed->reviewed': 'AgentProgress',
  'completed->accepted': 'AgentCompleted',
  // reviewed
  'reviewed->accepted': 'AgentCompleted',
};

/**
 * Resolve the canonical event kind for a transition. Cancellation and
 * failure are handled generically; everything else comes from the explicit
 * mapping above.
 */
function eventKindForTransition(from: TaskState, to: TaskState): SupervisorEventKind {
  if (to === TaskState.Cancelled) {
    return 'AgentStopped';
  }
  if (to === TaskState.Failed) {
    return 'AgentFailed';
  }
  const key = `${from}->${to}`;
  const kind = TRANSITION_EVENT_KIND[key];
  if (kind === undefined) {
    // This should never happen for a transition that passed the table check,
    // but guard against a missing mapping so failures are loud, not silent.
    throw new Error(`No event kind mapping for transition ${key}.`);
  }
  return kind;
}

/** Generates a reasonably unique id without a crypto dependency. */
function generateId(prefix: string): EntityId {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

/**
 * Context supplied to a transition, carrying the identifiers needed to emit
 * a well-formed journal event.
 */
export interface TransitionContext {
  /** Session (run) the transition occurs within — required for the event FK. */
  readonly sessionId: EntityId;
  /** Agent performing the transition, if known. */
  readonly agentId?: EntityId;
  /** Additional structured payload merged into the emitted event. */
  readonly payload?: Readonly<Record<string, unknown>>;
}

/**
 * Result of a successful transition: the updated task and the journal event
 * that was appended.
 */
export interface TransitionResult {
  readonly task: Task;
  readonly event: Event;
}

/**
 * The Task lifecycle state machine.
 *
 * Guards every state change against the transition table, persists the new
 * state via `TaskRepository.update`, and appends a `SupervisorEvent` to the
 * immutable journal via `EventRepository.insert` (DEC-012).
 */
export class TaskStateMachine {
  private readonly tasks: TaskRepositoryPort;
  private readonly events: EventJournalPort;

  constructor(tasks: TaskRepositoryPort, events: EventJournalPort) {
    this.tasks = tasks;
    this.events = events;
  }

  /**
   * Return the set of states reachable from `from` in a single guarded
   * transition. Returns an empty array for terminal states.
   */
  allowedTransitions(from: TaskState): readonly TaskState[] {
    return TRANSITION_TABLE[from] ?? [];
  }

  /**
   * Whether a transition from `from` to `to` is permitted by the table.
   */
  isAllowed(from: TaskState, to: TaskState): boolean {
    const allowed = this.allowedTransitions(from);
    return allowed.includes(to);
  }

  /**
   * Execute a guarded state transition for a task.
   *
   * Validates that:
   * 1. The task exists in storage.
   * 2. The task's current persisted state matches `fromState`.
   * 3. The `fromState -> toState` transition is permitted by the table.
   *
   * On success, persists the new state via `TaskRepository.update` and
   * appends a `SupervisorEvent` to the journal via `EventRepository.insert`.
   *
   * @throws {IllegalTransitionError} if the transition is illegal or the
   *   current state does not match `fromState`.
   * @throws {Error} if the task does not exist.
   */
  transition(
    taskId: EntityId,
    fromState: TaskState,
    toState: TaskState,
    context: TransitionContext,
  ): TransitionResult {
    const task = this.tasks.getById(taskId);
    if (task === null) {
      throw new Error(`Task not found: ${taskId}`);
    }

    if (task.state !== fromState) {
      throw new IllegalTransitionError(
        taskId,
        fromState,
        toState,
        `Current state is "${task.state}", not "${fromState}".`,
      );
    }

    if (TERMINAL_STATES.has(fromState)) {
      throw new IllegalTransitionError(
        taskId,
        fromState,
        toState,
        `"${fromState}" is a terminal state and cannot transition further.`,
      );
    }

    if (!this.isAllowed(fromState, toState)) {
      throw new IllegalTransitionError(
        taskId,
        fromState,
        toState,
        `Transition "${fromState} -> ${toState}" is not in the transition table.`,
      );
    }

    const kind = eventKindForTransition(fromState, toState);
    const timestamp: ISODateString = new Date().toISOString();

    const updatedTask: Task = {
      ...task,
      state: toState,
      updatedAt: timestamp,
    };

    const event: Event = {
      id: generateId('event'),
      sessionId: context.sessionId,
      taskId: taskId,
      timestamp,
      kind,
      payload: {
        fromState,
        toState,
        agentId: context.agentId ?? null,
        ...context.payload,
      },
    };

    // Persist the new state and append the journal event. Both repositories
    // are synchronous (better-sqlite3); the journal append happens after the
    // state update so the event records the committed transition.
    this.tasks.update(updatedTask);
    this.events.insert(event);

    return { task: updatedTask, event };
  }

  /**
   * Query the current persisted state of a task.
   *
   * @throws {Error} if the task does not exist.
   */
  getCurrentState(taskId: EntityId): TaskState {
    const task = this.tasks.getById(taskId);
    if (task === null) {
      throw new Error(`Task not found: ${taskId}`);
    }
    return task.state;
  }

  /**
   * Retrieve the full transition history for a task by querying the event
   * journal. Returns every event recorded for the task in chronological
   * order (DEC-012).
   */
  getTransitionHistory(taskId: EntityId): readonly Event[] {
    return this.events.listByTask(taskId);
  }
}
