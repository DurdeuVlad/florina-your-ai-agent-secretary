/**
 * Capsule rollup pipeline — continuous journal→capsule compaction
 * (issue #76, DEC-020/035).
 *
 * The event journal grows forever; capsules stay small. This service rolls
 * a session's raw journal events up into `rolledUpEventSummaries` on the
 * Task Capsule — continuously (on session end, and callable mid-session for
 * long runs) rather than only at task completion.
 *
 * Two levels of compaction:
 *
 * 1. **Session → Task**: {@link rollUpSession} summarizes a session's
 * equipment-level journal into one summary entry plus a {@link SessionRunSummary}
 * row on the capsule's `runHistory`. The original events stay in the
 * journal untouched (DEC-012) — the capsule holds a *projection*.
 *
 * 2. **Summary self-condensation**: a task running for days must not
 * accumulate hundreds of summary lines. When the list exceeds
 * `maxSummaryEntries`, older entries fold into a single synopsis
 * (`[task synopsis]` prefix), keeping the most recent
 * `keepRecentEntries` verbatim — the same keep-tail mechanics as the
 * Florina's {@link Condenser} (#75).
 *
 * Failover synergy (#64): `buildFailoverPrompt` reads
 * `rolledUpEventSummaries` — a capsule rolled up at freeze time IS the
 * briefing the next provider resumes from.
 *
 * Provenance: every rollup journals a `ContextCondensed` event naming the
 * source event ids it folded (`forgottenEventIds`), so the projection is
 * auditable and re-expandable (DEC-012/035).
 */
import type { EntityId, Event, TaskCapsule } from '../../../domain/types.js';
import type { ContextCondensedEvent } from '../../../domain/events.js';
import type {
  ContextCapsuleRepositoryPort,
  EventJournalPort,
  SessionRepositoryPort,
} from '../../ports/outbound/repositories.js';
import type { EventPublisherPort } from '../../ports/outbound/event-stream.js';

/** Summarizes a span of journal events into one capsule entry. */
export type EventSummarizer = (events: readonly Event[]) => Promise<string>;

/** Summarizes a span of prior summary strings into one synopsis. */
export type SummaryCondenser = (summaries: readonly string[]) => Promise<string>;

/** Options for {@link CapsuleRollupService}. */
export interface CapsuleRollupOptions {
  readonly journal: EventJournalPort;
  readonly capsuleStore: ContextCapsuleRepositoryPort;
  readonly sessionStore: Pick<SessionRepositoryPort, 'getById' | 'listByTask'>;
  readonly eventBus: EventPublisherPort;
  /**
   * Event → summary seam. Defaults to {@link extractiveEventSummarizer}
   * (deterministic, no model). Production may wire a model call.
   */
  readonly summarizeEvents?: EventSummarizer;
  /**
   * Summary-list → synopsis seam for self-condensation. Defaults to
   * {@link extractiveSummaryCondenser}.
   */
  readonly condenseSummaries?: SummaryCondenser;
  /**
   * Trigger self-condensation when `rolledUpEventSummaries` exceeds this
   * many entries (default 40).
   */
  readonly maxSummaryEntries?: number;
  /**
   * Entries kept verbatim at the tail during self-condensation (default 12).
   */
  readonly keepRecentEntries?: number;
}

/** Result of a {@link CapsuleRollupService.rollUpSession} call. */
export interface RollupResult {
  readonly capsuleId: EntityId;
  /** The summary entry appended for this session. */
  readonly summary: string;
  /** Journal ids folded into the summary (provenance). */
  readonly rolledUpEventIds: readonly EntityId[];
  /** Whether self-condensation also ran (summary list was over threshold). */
  readonly condensed: boolean;
}

/** Deterministic event summarizer — one line per event, honest and lossy. */
export const extractiveEventSummarizer: EventSummarizer = async (events) => {
  const lines = events.map((e) => {
    const detail = summarizePayload(e.payload);
    return `- ${e.kind}${detail !== '' ? `: ${detail}` : ''}`;
  });
  return `Session summary (${events.length} events):\n${lines.join('\n')}`;
};

/** Deterministic summary condenser — keeps each line's head, truncated. */
export const extractiveSummaryCondenser: SummaryCondenser = async (summaries) => {
  const lines = summaries.map((s) => `- ${s.split('\n')[0].slice(0, 160)}`);
  return `[task synopsis — ${summaries.length} earlier summaries folded]\n${lines.join('\n')}`;
};

/** Notable payload fields to surface in an extractive event line. */
const PAYLOAD_KEYS = [
  'objective',
  'reason',
  'toProvider',
  'fromProvider',
  'status',
  'title',
] as const;

function summarizePayload(payload: Readonly<Record<string, unknown>>): string {
  const parts: string[] = [];
  for (const key of PAYLOAD_KEYS) {
    const value = payload[key];
    if (typeof value === 'string' && value !== '') {
      parts.push(value.slice(0, 80));
      break; // one headline field is enough per line
    }
  }
  return parts.join('');
}

/**
 * Rolls session journal events into the owning Task Capsule and compacts
 * the capsule's summary list when it grows past threshold.
 */
export class CapsuleRollupService {
  private readonly journal: EventJournalPort;
  private readonly capsuleStore: ContextCapsuleRepositoryPort;
  private readonly sessionStore: Pick<SessionRepositoryPort, 'getById' | 'listByTask'>;
  private readonly eventBus: EventPublisherPort;
  private readonly summarizeEvents: EventSummarizer;
  private readonly condenseSummaries: SummaryCondenser;
  private readonly maxSummaryEntries: number;
  private readonly keepRecentEntries: number;

  constructor(options: CapsuleRollupOptions) {
    this.journal = options.journal;
    this.capsuleStore = options.capsuleStore;
    this.sessionStore = options.sessionStore;
    this.eventBus = options.eventBus;
    this.summarizeEvents = options.summarizeEvents ?? extractiveEventSummarizer;
    this.condenseSummaries = options.condenseSummaries ?? extractiveSummaryCondenser;
    this.maxSummaryEntries = options.maxSummaryEntries ?? 40;
    this.keepRecentEntries = options.keepRecentEntries ?? 12;
  }

  /**
   * Roll one session's journal events into the task's capsule.
   *
   * Idempotent per session: a session already present in `runHistory` is
   * skipped (its events were already folded), so callers can invoke this
   * periodically during a long session and again at end without doubling
   * the summary list. Returns `null` when there is nothing to do (no
   * capsule, or the session was already rolled up with no new events).
   */
  async rollUpSession(taskId: EntityId, sessionId: EntityId): Promise<RollupResult | null> {
    const capsule = this.loadTaskCapsule(taskId);
    if (capsule === null) {
      return null;
    }

    const alreadyRolled = capsule.content.runHistory.some((r) => r.sessionId === sessionId);
    const events = this.journal.listBySession(sessionId);
    if (alreadyRolled) {
      return null;
    }

    // --- 1. Session → Task rollup ---
    const summary = await this.summarizeEvents(events);
    const session = this.sessionStore.getById(sessionId);
    const runEntry = {
      sessionId,
      status: session?.status ?? 'stopped',
      startedAt: session?.startedAt ?? new Date().toISOString(),
      ...(session?.endedAt !== undefined ? { endedAt: session.endedAt } : {}),
    } satisfies TaskCapsule['content']['runHistory'][number];

    let content = {
      ...capsule.content,
      runHistory: [...capsule.content.runHistory, runEntry],
      rolledUpEventSummaries: [...capsule.content.rolledUpEventSummaries, summary],
    };

    // Journal the rollup BEFORE mutating the capsule: the provenance event
    // names the folded source events (DEC-012).
    this.recordCondensed({
      taskId,
      sessionId,
      agentId: session?.agentId ?? 'florina',
      summary,
      forgottenEventIds: events.map((e) => e.id),
      keptEventCount: events.length,
    });

    // --- 2. Summary self-condensation ---
    let condensed = false;
    if (content.rolledUpEventSummaries.length > this.maxSummaryEntries) {
      const keep = this.keepRecentEntries;
      const foldable = content.rolledUpEventSummaries.slice(0, -keep);
      const kept = content.rolledUpEventSummaries.slice(-keep);
      if (foldable.length > 0) {
        const synopsis = await this.condenseSummaries(foldable);
        content = { ...content, rolledUpEventSummaries: [synopsis, ...kept] };
        condensed = true;
        this.recordCondensed({
          taskId,
          sessionId,
          agentId: session?.agentId ?? 'florina',
          summary: synopsis,
          // The folded items are summaries, not events — the folded count
          // rides in the journal payload instead of forgottenEventIds.
          forgottenEventIds: [],
          keptEventCount: kept.length,
          extraPayload: { foldedSummaryCount: foldable.length },
        });
      }
    }

    this.capsuleStore.update({ ...capsule, content, updatedAt: new Date().toISOString() });
    return {
      capsuleId: capsule.id,
      summary,
      rolledUpEventIds: events.map((e) => e.id),
      condensed,
    };
  }

  /**
   * Roll up every session of a task not yet in `runHistory` — the
   * "periodically during long sessions" path. Returns one result per
   * newly-rolled session.
   */
  async rollUpTask(taskId: EntityId): Promise<readonly RollupResult[]> {
    const results: RollupResult[] = [];
    for (const session of this.sessionStore.listByTask(taskId)) {
      const result = await this.rollUpSession(taskId, session.id);
      if (result !== null) {
        results.push(result);
      }
    }
    return results;
  }

  /* ---------------------------------------------------------------- *
   * Internal helpers
   * ---------------------------------------------------------------- */

  private loadTaskCapsule(taskId: EntityId): TaskCapsule | null {
    const capsule = this.capsuleStore.loadByScope('task', taskId);
    if (capsule === null || capsule.scope !== 'task') {
      return null;
    }
    return capsule;
  }

  /** Journal + publish a `ContextCondensed` provenance event. */
  private recordCondensed(fields: {
    readonly taskId: EntityId;
    readonly sessionId: EntityId;
    readonly agentId: string;
    readonly summary: string;
    readonly forgottenEventIds: readonly string[];
    readonly keptEventCount: number;
    readonly extraPayload?: Readonly<Record<string, unknown>>;
  }): void {
    const event: ContextCondensedEvent = {
      type: 'ContextCondensed',
      timestamp: new Date().toISOString(),
      taskId: fields.taskId,
      sessionId: fields.sessionId,
      agentId: fields.agentId,
      adapterFidelityTier: 'B',
      summary: fields.summary,
      forgottenEventIds: [...fields.forgottenEventIds],
      keptEventCount: fields.keptEventCount,
    };
    const { type, timestamp, taskId, sessionId, agentId, adapterFidelityTier, ...payload } = event;
    this.journal.insert({
      id: `event_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`,
      sessionId,
      taskId,
      timestamp,
      kind: type,
      payload: { agentId, adapterFidelityTier, ...payload, ...fields.extraPayload },
    });
    this.eventBus.publish(event);
  }
}
