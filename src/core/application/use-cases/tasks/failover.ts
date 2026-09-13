/**
 * Cross-provider failover service (issue #64, DEC-029).
 *
 * When a provider runs dry mid-task (quota exhausted, adapter error, or a
 * manual/preference move), this service freezes the current session, moves
 * the task to `blocked` (the journaled "waiting" state), re-routes through
 * the {@link CapacityRouter}, and resumes the task on the next provider
 * **in the same git worktree** — the Task↔worktree mapping is 1:1
 * (DEC-020/024), so all filesystem state carries over automatically.
 *
 * Context for the new provider comes from the Task Capsule: the objective,
 * prior run history, and rolled-up event summaries are folded into the
 * `start-task` prompt override, so the incoming worker is briefed without
 * mutating the task's recorded objective. Provider-native resume tokens
 * (`claude --resume`, `codex` threads, …) are an adapter concern; the
 * fallback — a capsule-primed fresh session in the same worktree — is the
 * uniform path every provider supports.
 *
 * Parking: when every candidate is exhausted, the task stays `blocked` and
 * a `TaskParked` event is journaled with the earliest known reset. It is
 * silently resumable via {@link resumeTask}/{@link resumeParkedTasks}
 * (DEC-031: parking is not a decision that needs human attention).
 *
 * All lifecycle transitions go through the {@link TaskStateMachine} and the
 * typed `start-task` command, so every freeze, park, failover, and resume is
 * journaled (DEC-012) and no path bypasses routing or policy.
 */
import type { Task, Event, EntityId } from '../../../domain/types.js';
import { TaskState } from '../../../domain/enums.js';
import type { FailoverReason } from '../../../domain/events.js';
import type {
  TaskFailedOverEvent,
  TaskParkedEvent,
  TaskResumedEvent,
} from '../../../domain/events.js';
import type {
  ContextCapsuleRepositoryPort,
  EventJournalPort,
  TaskRepositoryPort,
} from '../../ports/outbound/repositories.js';
import type { EventPublisherPort } from '../../ports/outbound/event-stream.js';
import type { CapacityRouter } from '../routing/capacity-router.js';
import type { CommandApi } from './command-api.js';
import type { SessionManager } from './session-manager.js';
import type { TaskStateMachine, TransitionContext } from './task-lifecycle.js';

/** Request to fail a running task over to another provider. */
export interface FailoverRequest {
  readonly taskId: EntityId;
  /** Why the task is moving (journaled on the `TaskFailedOver` event). */
  readonly reason: FailoverReason;
  /**
   * Provider that failed — excluded from re-routing. Defaults to the task's
   * most recently recorded agent.
   */
  readonly failedProvider?: string;
  /** Optional work-type routing hint (e.g. `worker`). */
  readonly workType?: string;
}

/** Outcome of a {@link FailoverService.failover} call. */
export type FailoverResult =
  | {
      readonly kind: 'failed-over';
      readonly taskId: EntityId;
      readonly fromProvider: string;
      readonly toProvider: string;
      readonly toModel?: string;
      readonly sessionId: EntityId;
    }
  | {
      readonly kind: 'parked';
      readonly taskId: EntityId;
      readonly resumeAt: string | null;
      readonly reason: string;
    }
  | { readonly kind: 'error'; readonly taskId: EntityId; readonly error: string };

/** Outcome of a {@link FailoverService.resumeTask} call. */
export type ResumeResult =
  | {
      readonly kind: 'resumed';
      readonly taskId: EntityId;
      readonly provider: string;
      readonly model?: string;
      readonly sessionId: EntityId;
    }
  | {
      readonly kind: 'still-parked';
      readonly taskId: EntityId;
      readonly resumeAt: string | null;
      readonly reason: string;
    }
  | { readonly kind: 'error'; readonly taskId: EntityId; readonly error: string };

export interface FailoverServiceDeps {
  readonly commandApi: CommandApi;
  readonly taskStateMachine: TaskStateMachine;
  readonly sessionManager: SessionManager;
  /**
   * The capacity router, or a factory that builds one per call. A factory
   * lets composition roots re-read the preference profile at failover time
   * so edits apply without a restart (mirrors the MCP manager factory).
   */
  readonly router: CapacityRouter | (() => CapacityRouter);
  readonly taskStore: TaskRepositoryPort;
  readonly eventBus: EventPublisherPort;
  readonly journal: EventJournalPort;
  /** Task Capsule lookup for the failover briefing; optional. */
  readonly capsuleStore?: ContextCapsuleRepositoryPort;
}

/**
 * Orchestrates provider failover and park/resume for tasks. Pure
 * application service — no transport, no process handles; adapters are
 * reached through the injected command API, session manager, and ports.
 */
export class FailoverService {
  private readonly commandApi: CommandApi;
  private readonly taskStateMachine: TaskStateMachine;
  private readonly sessionManager: SessionManager;
  private readonly router: CapacityRouter | (() => CapacityRouter);
  private readonly taskStore: TaskRepositoryPort;
  private readonly eventBus: EventPublisherPort;
  private readonly journal: EventJournalPort;
  private readonly capsuleStore?: ContextCapsuleRepositoryPort;

  constructor(deps: FailoverServiceDeps) {
    this.commandApi = deps.commandApi;
    this.taskStateMachine = deps.taskStateMachine;
    this.sessionManager = deps.sessionManager;
    this.router = deps.router;
    this.taskStore = deps.taskStore;
    this.eventBus = deps.eventBus;
    this.journal = deps.journal;
    this.capsuleStore = deps.capsuleStore;
  }

  /**
   * Freeze the task's current session and re-route it to another provider.
   *
   * Steps: resolve the failed provider → stop the adapter session →
   * transition `running`/`attention-needed` → `blocked` (journaled
   * `AgentBlocked`) → route excluding the failed provider → either restart
   * in the same worktree (`blocked` → `running`, journaled `TaskFailedOver`)
   * or leave the task parked (`TaskParked`) until capacity returns.
   */
  async failover(request: FailoverRequest): Promise<FailoverResult> {
    const task = this.taskStore.getById(request.taskId);
    if (task === null) {
      return { kind: 'error', taskId: request.taskId, error: `Task not found: ${request.taskId}` };
    }

    let currentState: Task['state'];
    try {
      currentState = this.taskStateMachine.getCurrentState(request.taskId);
    } catch (err) {
      return { kind: 'error', taskId: request.taskId, error: errorMessage(err) };
    }

    // A task may fail over from any in-flight state: `running`,
    // `attention-needed`, or `delegated` — the provider can die between
    // `start-task` and the first progress event.
    const failoverable =
      currentState === TaskState.Running ||
      currentState === TaskState.AttentionNeeded ||
      currentState === TaskState.Delegated;
    if (!failoverable) {
      return {
        kind: 'error',
        taskId: request.taskId,
        error:
          `Task is in state "${currentState}" and cannot fail over ` +
          `(expected running, attention-needed, or delegated; use resumeTask for blocked tasks)`,
      };
    }

    const fromProvider =
      request.failedProvider ?? task.agentIds[task.agentIds.length - 1] ?? 'unknown';
    const frozenSessionId = task.sessionIds[task.sessionIds.length - 1] ?? 'unknown';

    // --- Freeze: cancel + disconnect the current adapter session. ---
    // Best-effort: a hung adapter must not block the handoff; the journal
    // already records that the run ended here.
    const stopResult = await this.sessionManager.stopSession(request.taskId);
    if (!stopResult.ok && this.sessionManager.hasSession(request.taskId)) {
      return {
        kind: 'error',
        taskId: request.taskId,
        error: `Failed to freeze session: ${stopResult.error}`,
      };
    }

    // --- Block: the journaled "waiting on capacity" state. ---
    const blockCtx: TransitionContext = {
      sessionId: frozenSessionId,
      agentId: task.agentIds[task.agentIds.length - 1],
      payload: { reason: 'failover', failoverReason: request.reason, fromProvider },
    };
    try {
      this.taskStateMachine.transition(request.taskId, currentState, TaskState.Blocked, blockCtx);
    } catch (err) {
      return {
        kind: 'error',
        taskId: request.taskId,
        error: `Failed to freeze task: ${errorMessage(err)}`,
      };
    }

    // --- Re-route without the failed provider. ---
    const route = this.resolveRouter().failover({
      workType: request.workType,
      excludeProviders: [fromProvider],
      projectId: task.projectId,
    });

    if (route.kind === 'parked') {
      this.recordParked(
        request.taskId,
        frozenSessionId,
        fromProvider,
        route.reason,
        route.resumeAt,
      );
      return {
        kind: 'parked',
        taskId: request.taskId,
        resumeAt: route.resumeAt,
        reason: route.reason,
      };
    }

    // --- Resume on the new provider in the same worktree. ---
    const resumed = await this.startOnProvider(request.taskId, task, route.provider, route.model);
    if (resumed.kind === 'error') {
      // The task stays blocked — honest, retrievable via resumeTask once
      // the spawn problem is resolved. The freeze is already journaled.
      return resumed;
    }

    this.recordFailedOver(request.taskId, resumed.sessionId, {
      fromProvider,
      toProvider: route.provider,
      toModel: route.model,
      reason: request.reason,
      routingReason: route.reason,
    });
    return {
      kind: 'failed-over',
      taskId: request.taskId,
      fromProvider,
      toProvider: route.provider,
      toModel: route.model,
      sessionId: resumed.sessionId,
    };
  }

  /**
   * Resume a `blocked` (parked) task by re-routing it through the normal
   * preference order — the quota ledger decides which providers have
   * capacity again, so no explicit exclusions are needed.
   *
   * Emits a journaled `TaskResumed` event on success. Returns
   * `still-parked` when no provider has capacity yet.
   */
  async resumeTask(taskId: EntityId): Promise<ResumeResult> {
    const task = this.taskStore.getById(taskId);
    if (task === null) {
      return { kind: 'error', taskId, error: `Task not found: ${taskId}` };
    }

    let currentState: Task['state'];
    try {
      currentState = this.taskStateMachine.getCurrentState(taskId);
    } catch (err) {
      return { kind: 'error', taskId, error: errorMessage(err) };
    }
    if (currentState !== TaskState.Blocked) {
      return {
        kind: 'error',
        taskId,
        error: `Task is in state "${currentState}" and is not parked`,
      };
    }

    const route = this.resolveRouter().route({ projectId: task.projectId });
    if (route.kind === 'parked') {
      return { kind: 'still-parked', taskId, resumeAt: route.resumeAt, reason: route.reason };
    }

    const resumed = await this.startOnProvider(taskId, task, route.provider, route.model);
    if (resumed.kind === 'error') {
      return resumed;
    }

    const event: TaskResumedEvent = {
      type: 'TaskResumed',
      timestamp: new Date().toISOString(),
      taskId,
      sessionId: resumed.sessionId,
      agentId: route.provider,
      adapterFidelityTier: 'B',
      provider: route.provider,
      ...(route.model !== undefined ? { model: route.model } : {}),
    };
    this.journal.insert(this.toJournalEvent(event, resumed.sessionId));
    this.eventBus.publish(event);

    return {
      kind: 'resumed',
      taskId,
      provider: route.provider,
      model: route.model,
      sessionId: resumed.sessionId,
    };
  }

  /**
   * Resume every parked (`blocked`) task that has capacity again. Returns
   * one result per task, in task-store order.
   */
  async resumeParkedTasks(): Promise<readonly ResumeResult[]> {
    const results: ResumeResult[] = [];
    for (const task of this.taskStore.listAll()) {
      if (task.state === TaskState.Blocked) {
        results.push(await this.resumeTask(task.id));
      }
    }
    return results;
  }

  /* ---------------------------------------------------------------- *
   * Internal helpers
   * ---------------------------------------------------------------- */

  /** Resolve the router — fresh instance when a factory was injected. */
  private resolveRouter(): CapacityRouter {
    return typeof this.router === 'function' ? this.router() : this.router;
  }

  /**
   * Start the task on `provider` via the typed `start-task` command —
   * the same journaled path every spawn takes (adapter registry, session
   * row, `blocked` → `running` transition, `AgentStarted` event). The
   * session runs in the task's existing worktree and is primed with the
   * capsule briefing prompt.
   */
  private async startOnProvider(
    taskId: EntityId,
    task: Task,
    provider: string,
    model: string | undefined,
  ): Promise<
    { kind: 'started'; sessionId: EntityId } | { kind: 'error'; taskId: EntityId; error: string }
  > {
    if (task.worktreePath === undefined) {
      return {
        kind: 'error',
        taskId,
        error: `Task "${taskId}" has no worktree — cannot resume on provider "${provider}"`,
      };
    }
    const response = await this.commandApi.execute({
      kind: 'start-task',
      taskId,
      agentId: provider,
      sessionConfig: {
        workingDir: task.worktreePath,
        model,
        prompt: buildFailoverPrompt(task, this.lookupTaskCapsule(task)),
      },
    });
    if (response.ok === false) {
      const detail = 'error' in response ? response.error : undefined;
      return {
        kind: 'error',
        taskId,
        error: `Failed to resume on provider "${provider}": ${detail ?? 'unknown error'}`,
      };
    }
    if (!('sessionId' in response) || typeof response.sessionId !== 'string') {
      return {
        kind: 'error',
        taskId,
        error: `Failed to resume on provider "${provider}": unexpected response shape`,
      };
    }
    return { kind: 'started', sessionId: response.sessionId };
  }

  /** Journal + publish a `TaskParked` event for a task left in `blocked`. */
  private recordParked(
    taskId: EntityId,
    sessionId: EntityId,
    agentId: string,
    reason: string,
    resumeAt: string | null,
  ): void {
    const event: TaskParkedEvent = {
      type: 'TaskParked',
      timestamp: new Date().toISOString(),
      taskId,
      sessionId,
      agentId,
      adapterFidelityTier: 'B',
      reason,
      ...(resumeAt !== null ? { resumeAt } : {}),
    };
    this.journal.insert(this.toJournalEvent(event, sessionId));
    this.eventBus.publish(event);
  }

  /** Journal + publish a `TaskFailedOver` event after a successful handoff. */
  private recordFailedOver(
    taskId: EntityId,
    sessionId: EntityId,
    fields: {
      readonly fromProvider: string;
      readonly toProvider: string;
      readonly toModel?: string;
      readonly reason: FailoverReason;
      /** Router's explanation for the pick — journaled for audit. */
      readonly routingReason: string;
    },
  ): void {
    const event: TaskFailedOverEvent = {
      type: 'TaskFailedOver',
      timestamp: new Date().toISOString(),
      taskId,
      sessionId,
      agentId: fields.toProvider,
      adapterFidelityTier: 'B',
      fromProvider: fields.fromProvider,
      toProvider: fields.toProvider,
      ...(fields.toModel !== undefined ? { toModel: fields.toModel } : {}),
      reason: fields.reason,
    };
    this.journal.insert(
      this.toJournalEvent(event, sessionId, { routingReason: fields.routingReason }),
    );
    this.eventBus.publish(event);
  }

  /**
   * Convert a canonical `SupervisorEvent` into a journal `Event` row. The
   * event `kind` is the supervisor type; the payload carries the typed
   * fields (minus the base envelope) for re-expansion (DEC-012/019).
   */
  private toJournalEvent(
    event: TaskFailedOverEvent | TaskParkedEvent | TaskResumedEvent,
    sessionId: EntityId,
    extraPayload?: Readonly<Record<string, unknown>>,
  ): Event {
    const { type, timestamp, taskId, ...payload } = event;
    return {
      id: `event_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`,
      sessionId,
      taskId,
      timestamp,
      kind: type,
      payload: { ...payload, ...extraPayload },
    };
  }

  /** Look up the task's Task Capsule, if one is recorded. */
  private lookupTaskCapsule(task: Task) {
    if (this.capsuleStore === undefined || task.capsuleId === undefined) {
      return undefined;
    }
    const capsule = this.capsuleStore.getById(task.capsuleId);
    return capsule?.scope === 'task' ? capsule : undefined;
  }
}

/**
 * Build the prompt that primes a new provider after failover: the recorded
 * objective plus a briefing describing the handoff and (when a Task Capsule
 * exists) the run history it accumulated. Pure function — exported for
 * tests and for callers that want to preview the briefing.
 */
export function buildFailoverPrompt(
  task: Task,
  capsule?: {
    readonly content: {
      readonly runHistory: readonly {
        readonly sessionId: string;
        readonly status: string;
        readonly startedAt: string;
        readonly endedAt?: string;
      }[];
      readonly rolledUpEventSummaries: readonly string[];
      readonly agentIds: readonly string[];
    };
  },
): string {
  const lines: string[] = [
    task.objective,
    '',
    '[failover briefing]',
    `This task was handed to you after a previous provider session ended. ` +
      `You are resuming in the same git worktree — inspect the existing state ` +
      `(files, diffs, test output) before editing, and continue the work rather ` +
      `than starting over.`,
    `Previous providers: ${task.agentIds.join(', ') || 'none recorded'}.`,
    `Prior sessions: ${task.sessionIds.length}.`,
  ];
  if (capsule !== undefined) {
    for (const run of capsule.content.runHistory) {
      lines.push(
        `- run ${run.sessionId}: ${run.status} (started ${run.startedAt}${run.endedAt ? `, ended ${run.endedAt}` : ''})`,
      );
    }
    for (const summary of capsule.content.rolledUpEventSummaries) {
      lines.push(`- ${summary}`);
    }
  }
  return lines.join('\n');
}

/** Extract a human-readable message from an unknown error. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
