/**
 * Context Resolver — assembles a Context Capsule for a task/session by
 * querying the event journal and composing relevant context (#30, DEC-020,
 * DEC-012).
 *
 * When a session resumes or a new session picks up a task, the Florina
 * must assemble the relevant context from:
 * - The immutable event journal (DEC-012) — the source of truth.
 * - Task metadata (objective, state, agent/session assignments).
 * - Recent decisions (Decision Ledger).
 * - Recent completion digests (#16) — rolled-up summaries of past runs.
 * - Active approvals (pending `ApprovalRequested` events).
 * - Worktree status (DEC-024) — current git worktree state.
 *
 * The resolver queries each source through narrow interfaces so the
 * concrete repositories can be substituted in tests. The assembled
 * {@link AssembledContextCapsule} carries the structured sections alongside
 * a task-scoped {@link ContextCapsule} ready to be persisted or fed to an
 * agent session.
 *
 * Token budget: the resolver estimates the token count of the assembled
 * capsule (~4 chars/token heuristic) and truncates low-priority history
 * first via {@link truncateToBudget} when the budget is exceeded. The
 * default budget is 8000 tokens.
 */
import { ContextCapsuleScope } from '../../../domain/enums.js';
import type {
  ContextCapsule,
  Decision,
  EntityId,
  Event,
  Task,
  TaskCapsuleContent,
} from '../../../domain/types.js';
import type { CompletionDigest } from '../attention/completion-digest.js';
import type { WorktreeStatus } from '../../ports/outbound/worktree.js';
import type {
  DecisionSourcePort,
  DigestSourcePort,
  EventSourcePort,
  TaskSourcePort,
  WorktreeStatusSourcePort,
} from '../../ports/outbound/context-sources.js';

import {
  classifyEventPriority,
  DEFAULT_CHARS_PER_TOKEN,
  DEFAULT_TOKEN_BUDGET,
  estimateAssembledTokens,
  truncateToBudget,
} from './context-estimator.js';

/* ------------------------------------------------------------------ *
 * Shared types (also imported type-only by context-estimator.ts)
 * ------------------------------------------------------------------ */

/**
 * Importance tier for a single event. See {@link classifyEventPriority}.
 */
export type Priority = 'critical' | 'high' | 'medium' | 'low';

/**
 * An event paired with its computed priority tier.
 */
export interface PrioritizedEvent {
  /** The original journaled event. */
  readonly event: Event;
  /** The priority tier assigned during resolution. */
  readonly priority: Priority;
}

/**
 * A concise summary of the task being resolved, derived from task metadata.
 */
export interface TaskSummary {
  /** The task identifier. */
  readonly taskId: EntityId;
  /** The task objective (human-delegated goal). */
  readonly objective: string;
  /** The current task lifecycle state. */
  readonly state: string;
  /** Ids of agents the task is delegated to. */
  readonly agentIds: readonly EntityId[];
  /** Ids of sessions (runs) spawned for the task. */
  readonly sessionIds: readonly EntityId[];
}

/**
 * The fully assembled context for a task/session, drawn from all sources.
 *
 * Each section is a projection over the immutable event journal (DEC-012)
 * and scoped storage (DEC-020) — never a replacement for the source data.
 * The embedded `capsule` is a task-scoped {@link ContextCapsule} whose
 * content rolls up the assembled sections, ready to be persisted via
 * `ContextCapsuleRepository.insert` / `.update` or handed to an agent
 * session.
 */
export interface AssembledContextCapsule {
  /** The task this context was resolved for. */
  readonly taskId: EntityId;
  /** Task metadata summary (objective, state, agents, sessions). */
  readonly taskSummary: TaskSummary;
  /** Recent events from the journal, prioritized and truncated to budget. */
  readonly recentEvents: readonly PrioritizedEvent[];
  /** Active (pending) approval requests extracted from the event journal. */
  readonly activeApprovals: readonly Event[];
  /** Recent decisions from the Decision Ledger for this task. */
  readonly recentDecisions: readonly Decision[];
  /** Recent completion digests for this task (#16). */
  readonly recentDigests: readonly CompletionDigest[];
  /** Current worktree status, when a worktree exists (DEC-024). */
  readonly worktreeStatus: WorktreeStatus | null;
  /** The task-scoped context capsule rolled up from the assembled sections. */
  readonly capsule: ContextCapsule;
  /** Estimated total token cost of the assembled capsule. */
  readonly estimatedTokens: number;
  /** The token budget that was enforced during resolution. */
  readonly tokenBudget: number;
}

/* ------------------------------------------------------------------ *
 * Source interfaces (narrow, mockable)
 * ------------------------------------------------------------------ */

/**
 * Read surface for task metadata. The concrete `TaskRepository` satisfies
 * this.
 *
 * Owned by the core `TaskSourcePort` (DEC-037); `TaskSource` is retained as
 * a compatibility alias.
 */
export type TaskSource = TaskSourcePort;

/**
 * Read surface for the event journal. The concrete `EventRepository`
 * satisfies this; tests can substitute a spy.
 *
 * Owned by the core `EventSourcePort` (DEC-037); `EventSource` is retained
 * as a compatibility alias.
 */
export type EventSource = EventSourcePort;

/**
 * Read surface for decisions. The concrete `DecisionRepository` satisfies
 * this.
 *
 * Owned by the core `DecisionSourcePort` (DEC-037); `DecisionSource` is
 * retained as a compatibility alias.
 */
export type DecisionSource = DecisionSourcePort;

/**
 * Read surface for completion digests. The concrete
 * `CompletionDigestRepository` satisfies this.
 *
 * Owned by the core `DigestSourcePort` (DEC-037); `DigestSource` is
 * retained as a compatibility alias bound to {@link CompletionDigest}.
 */
export type DigestSource = DigestSourcePort<CompletionDigest>;

/**
 * Read surface for worktree status. The concrete `WorktreeManager` satisfies
 * this via a thin adapter (since `WorktreeManager.worktreeStatus` takes a
 * path, not a task id).
 *
 * Owned by the core `WorktreeStatusSourcePort` (DEC-037);
 * `WorktreeStatusSource` is retained as a compatibility alias.
 */
export type WorktreeStatusSource = WorktreeStatusSourcePort;

/* ------------------------------------------------------------------ *
 * Resolve options
 * ------------------------------------------------------------------ */

/**
 * Options controlling context resolution.
 */
export interface ResolveOptions {
  /**
   * Maximum number of recent events to include (the event window). Defaults
   * to 100 — the most recent 100 events for the task.
   */
  readonly eventWindow?: number;
  /**
   * Maximum total tokens for the assembled capsule. Defaults to 8000.
   */
  readonly tokenBudget?: number;
  /**
   * Characters-per-token ratio for token estimation. Defaults to 4.
   */
  readonly charsPerToken?: number;
  /**
   * Maximum number of recent decisions to include. Defaults to 20.
   */
  readonly maxDecisions?: number;
  /**
   * Maximum number of recent digests to include. Defaults to 10.
   */
  readonly maxDigests?: number;
}

/* ------------------------------------------------------------------ *
 * Defaults
 * ------------------------------------------------------------------ */

/** Default event window: the most recent 100 events. */
export const DEFAULT_EVENT_WINDOW = 100;

/** Default maximum recent decisions included. */
export const DEFAULT_MAX_DECISIONS = 20;

/** Default maximum recent digests included. */
export const DEFAULT_MAX_DIGESTS = 10;

/* ------------------------------------------------------------------ *
 * ContextResolver
 * ------------------------------------------------------------------ */

/**
 * Resolves and assembles context for a task/session from multiple sources.
 *
 * The resolver is constructed with the source interfaces it reads from.
 * The worktree-status source is optional — if not provided, the
 * `worktreeStatus` field is `null`. This makes the resolver usable in
 * partial wiring and trivially mockable in tests.
 *
 * Usage:
 * ```ts
 * const resolver = new ContextResolver({
 *   tasks: taskRepository,
 *   events: eventRepository,
 *   decisions: decisionRepository,
 *   digests: digestRepository,
 *   worktreeStatus: worktreeSource,
 * });
 * const ctx = await resolver.resolve('task-42');
 * ```
 */
export class ContextResolver {
  private readonly tasks: TaskSource;
  private readonly events: EventSource;
  private readonly decisions: DecisionSource;
  private readonly digests: DigestSource;
  private readonly worktreeStatus?: WorktreeStatusSource;

  constructor(sources: {
    readonly tasks: TaskSource;
    readonly events: EventSource;
    readonly decisions: DecisionSource;
    readonly digests: DigestSource;
    readonly worktreeStatus?: WorktreeStatusSource;
  }) {
    this.tasks = sources.tasks;
    this.events = sources.events;
    this.decisions = sources.decisions;
    this.digests = sources.digests;
    this.worktreeStatus = sources.worktreeStatus;
  }

  /**
   * Resolve and assemble context for a task.
   *
   * Queries each available source, prioritizes events, truncates to the
   * token budget (dropping low-priority history first), and rolls the
   * result into a task-scoped {@link ContextCapsule}.
   *
   * @param taskId - The task to resolve context for.
   * @param options - Resolution options (event window, token budget, limits).
   * @returns An {@link AssembledContextCapsule} with all sections and the
   *          rolled-up capsule.
   */
  async resolve(taskId: EntityId, options?: ResolveOptions): Promise<AssembledContextCapsule> {
    const eventWindow = options?.eventWindow ?? DEFAULT_EVENT_WINDOW;
    const tokenBudget = options?.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
    const charsPerToken = options?.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
    const maxDecisions = options?.maxDecisions ?? DEFAULT_MAX_DECISIONS;
    const maxDigests = options?.maxDigests ?? DEFAULT_MAX_DIGESTS;

    // --- Gather raw data from each source ---
    const task = this.tasks.getById(taskId);
    const rawEvents = this.events.listByTask(taskId);
    const rawDecisions = this.decisions.listByTask(taskId);
    const worktreeStatus = this.worktreeStatus?.getWorktreeStatus(taskId) ?? null;

    // Recent digests: the latest for this task plus recent runs.
    const rawDigests: CompletionDigest[] = [];
    const byTask = this.digests.findByTaskId(taskId);
    if (byTask) rawDigests.push(byTask);
    const recent = this.digests.list({ limit: maxDigests });
    for (const d of recent) {
      if (d.taskId === taskId && !rawDigests.some((r) => r.sessionId === d.sessionId)) {
        rawDigests.push(d);
      }
    }

    // --- Apply the event window (most recent `eventWindow` events) ---
    const windowedEvents = this.applyEventWindow(rawEvents, eventWindow);

    // --- Extract active approvals (pending ApprovalRequested events) ---
    const activeApprovals = this.extractActiveApprovals(windowedEvents);

    // --- Prioritize events ---
    const prioritizedEvents: PrioritizedEvent[] = windowedEvents.map((event) => ({
      event,
      priority: classifyEventPriority(event),
    }));

    // --- Limit decisions and digests ---
    const limitedDecisions = rawDecisions.slice(-maxDecisions);
    const limitedDigests = rawDigests.slice(0, maxDigests);

    // --- Build the task summary ---
    const taskSummary: TaskSummary = this.buildTaskSummary(taskId, task, windowedEvents);

    // --- Build the initial capsule ---
    const capsule = this.buildCapsule(taskId, taskSummary, prioritizedEvents, limitedDigests);

    // --- Assemble and truncate to budget ---
    const assembled: AssembledContextCapsule = {
      taskId,
      taskSummary,
      recentEvents: prioritizedEvents,
      activeApprovals,
      recentDecisions: limitedDecisions,
      recentDigests: limitedDigests,
      worktreeStatus,
      capsule,
      estimatedTokens: 0,
      tokenBudget,
    };

    const estimated = estimateAssembledTokens(assembled, charsPerToken);
    const withEstimate: AssembledContextCapsule = { ...assembled, estimatedTokens: estimated };

    if (estimated > tokenBudget) {
      const truncated = truncateToBudget(withEstimate, tokenBudget, charsPerToken);
      // Rebuild the embedded capsule from the truncated event set so the
      // persisted capsule reflects what survived truncation.
      return this.rebuildCapsule(truncated, charsPerToken);
    }

    return withEstimate;
  }

  /* ---------------------------------------------------------------- *
   * Private helpers
   * ---------------------------------------------------------------- */

  /**
   * Apply the event window: keep the most recent `window` events (by
   * timestamp). Events are returned in chronological order by the
   * repository; we take the tail and preserve chronological order.
   */
  private applyEventWindow(events: readonly Event[], window: number): Event[] {
    if (window <= 0 || events.length <= window) {
      return [...events];
    }
    return events.slice(events.length - window);
  }

  /**
   * Extract active (pending) approval requests from the event stream.
   *
   * In the current event schema there is no separate `ApprovalDecided`
   * event, so every `ApprovalRequested` event is treated as an active
   * (pending) approval until the approval domain object records a
   * decision. This matches the MVP heuristic documented in the completion
   * digest builder.
   */
  private extractActiveApprovals(events: readonly Event[]): Event[] {
    return events.filter((e) => e.kind === 'ApprovalRequested');
  }

  /**
   * Build the task summary from task metadata, falling back to values
   * derived from the event stream when the task is not found in storage.
   */
  private buildTaskSummary(
    taskId: EntityId,
    task: Task | null,
    events: readonly Event[],
  ): TaskSummary {
    if (task) {
      return {
        taskId,
        objective: task.objective,
        state: task.state,
        agentIds: task.agentIds,
        sessionIds: task.sessionIds,
      };
    }

    // Fallback: derive what we can from the event stream.
    const started = events.find((e) => e.kind === 'AgentStarted');
    const objective =
      typeof started?.payload['objective'] === 'string'
        ? (started.payload['objective'] as string)
        : `Task ${taskId}`;
    const sessionIds = [...new Set(events.map((e) => e.sessionId))];

    return {
      taskId,
      objective,
      state: 'unknown',
      agentIds: [],
      sessionIds,
    };
  }

  /**
   * Build a task-scoped {@link ContextCapsule} from the assembled sections.
   *
   * The capsule content rolls up:
   * - `objective` from the task summary.
   * - `agentIds` from the task summary.
   * - `runHistory` derived from prior completion digests.
   * - `deliverableIds` derived from digest commit hashes.
   * - `rolledUpEventSummaries` — concise one-line summaries of the
   *   surviving events (the full journal remains the source of truth,
   *   DEC-012).
   */
  private buildCapsule(
    taskId: EntityId,
    taskSummary: TaskSummary,
    events: readonly PrioritizedEvent[],
    digests: readonly CompletionDigest[],
  ): ContextCapsule {
    const rolledUpEventSummaries = events.map((pe) => `${pe.event.kind} @ ${pe.event.timestamp}`);

    const runHistory = digests.map((d) => ({
      sessionId: d.sessionId,
      status: 'completed' as const,
      startedAt: d.startedAt,
      endedAt: d.completedAt,
    }));

    const deliverableIds: EntityId[] = [];
    for (const d of digests) {
      if (d.commitHash) {
        const ref = `commit:${d.commitHash}`;
        if (!deliverableIds.includes(ref)) deliverableIds.push(ref);
      }
    }

    const content: TaskCapsuleContent = {
      objective: taskSummary.objective,
      agentIds: [...taskSummary.agentIds],
      runHistory,
      deliverableIds,
      rolledUpEventSummaries,
    };

    const ts = new Date().toISOString();
    return {
      id: `capsule_${taskId}_${Date.now().toString(36)}`,
      scope: ContextCapsuleScope.Task,
      ownerId: taskId,
      content,
      createdAt: ts,
      updatedAt: ts,
    };
  }

  /**
   * Rebuild the embedded capsule after truncation so the persisted capsule
   * reflects only the events that survived budget truncation.
   */
  private rebuildCapsule(
    capsule: AssembledContextCapsule,
    _charsPerToken: number,
  ): AssembledContextCapsule {
    const rebuilt = this.buildCapsule(
      capsule.taskId,
      capsule.taskSummary,
      capsule.recentEvents,
      capsule.recentDigests,
    );
    return { ...capsule, capsule: rebuilt };
  }
}

/* ------------------------------------------------------------------ *
 * Convenience re-exports
 * ------------------------------------------------------------------ */

export {
  estimateTokens,
  estimateCapsuleTokens,
  estimateAssembledTokens,
  classifyEventPriority,
  truncateToBudget,
  DEFAULT_CHARS_PER_TOKEN,
  DEFAULT_TOKEN_BUDGET,
} from './context-estimator.js';
