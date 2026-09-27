/**
 * Event journal writer — persists bus-published {@link SupervisorEvent}s
 * into the immutable event journal (DEC-012).
 *
 * The daemon's {@link EventBus} is an in-memory fan-out: adapter
 * observations (test runs, verification probes, file changes, usage)
 * flowed to the inbox and stream but were never persisted. Verification
 * evidence (#68, DEC-032) must be durable — this writer is the bridge.
 *
 * Provenance rule: events *authored by daemon services* are already
 * journaled by their producers (failover, capsule rollup, grant service)
 * before they are published — the writer skips those kinds to avoid
 * double-recording. Adapters never author them; they are
 * Florina-internal records.
 */
import type { SupervisorEvent } from '../../../domain/events.js';
import type { Event, SupervisorEventKind } from '../../../domain/types.js';
import type { EventJournalPort } from '../../ports/outbound/repositories.js';
import type { EventSubscriberPort } from '../../ports/outbound/event-stream.js';

/**
 * Event kinds authored — and already journaled — by daemon services.
 * The writer never re-journals these; adapters do not produce them.
 */
const SELF_JOURNALED_KINDS: ReadonlySet<SupervisorEventKind> = new Set([
  'TaskFailedOver',
  'TaskParked',
  'TaskResumed',
  'ContextCondensed',
  'ApprovalGranted',
  'ApprovalRevoked',
]);

export interface EventJournalWriterDeps {
  readonly journal: EventJournalPort;
  readonly bus: EventSubscriberPort;
  /**
   * Optional error sink. Journal insert failures (e.g. an event
   * referencing a task/session that was never persisted) are reported
   * here and otherwise swallowed — a bad event must not break the
   * publish pipeline for downstream subscribers. `row` is the converted
   * journal record that failed to insert — retained so the caller can
   * surface a retryable attention item (issue #264). `row` is absent
   * when the failure happened during conversion, before a row existed.
   * A throwing sink is contained: it runs inside the publish pipeline's
   * synchronous emit.
   */
  readonly onError?: (err: unknown, event: SupervisorEvent, row?: Event) => void;
}

/**
 * Subscribes to the {@link EventSubscriberPort} and appends every
 * adapter-originated event to the {@link EventJournalPort}.
 */
export class EventJournalWriter {
  private readonly journal: EventJournalPort;
  private readonly bus: EventSubscriberPort;
  private readonly onError?: (err: unknown, event: SupervisorEvent, row?: Event) => void;
  private unsubscribe?: () => void;

  constructor(deps: EventJournalWriterDeps) {
    this.journal = deps.journal;
    this.bus = deps.bus;
    this.onError = deps.onError;
  }

  /** Begin journaling bus events. Idempotent. Pair with {@link stop}. */
  start(): void {
    if (this.unsubscribe !== undefined) return;
    this.unsubscribe = this.bus.onEvent((event) => this.handleEvent(event));
  }

  /** Stop journaling. Safe when not started. */
  stop(): void {
    if (this.unsubscribe !== undefined) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  /**
   * Persist one event. Exposed publicly for direct feeds (e.g. journal
   * replay). Self-journaled kinds are skipped.
   */
  handleEvent(event: SupervisorEvent): void {
    if (SELF_JOURNALED_KINDS.has(event.type)) {
      return;
    }
    let row: Event | undefined;
    try {
      row = supervisorEventToJournalRow(event);
      this.journal.insert(row);
    } catch (err) {
      // The sink runs inside the publish pipeline — it must never throw,
      // so enforce that here rather than trusting every caller (#264).
      try {
        this.onError?.(err, event, row);
      } catch {
        /* a broken sink must not break the pipeline either */
      }
    }
  }
}

/**
 * Whether a journal-insert failure could succeed on retry (issue #264).
 * Constraint violations (better-sqlite3 `SQLITE_CONSTRAINT*`) are
 * permanent — the row references entities that were never persisted, so
 * a retry can never satisfy it. Busy/locked/IO/full are transient.
 */
export function isPermanentJournalError(err: unknown): boolean {
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code: unknown }).code)
      : '';
  return code.startsWith('SQLITE_CONSTRAINT');
}

/**
 * Convert a canonical {@link SupervisorEvent} into a journal {@link Event}
 * row: `kind` is the event type, `timestamp` is the observed time (not
 * the insert time), and the payload carries every typed field including
 * the envelope ids for re-expansion.
 */
export function supervisorEventToJournalRow(event: SupervisorEvent): Event {
  const { type, timestamp, taskId, sessionId, ...fields } = event;
  return {
    id: `event_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`,
    sessionId,
    taskId,
    timestamp,
    kind: type,
    payload: { taskId, sessionId, ...fields },
  };
}
