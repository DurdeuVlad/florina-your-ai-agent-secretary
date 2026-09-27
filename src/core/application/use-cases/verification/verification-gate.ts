/**
 * Verification gate — "done means proven" (DEC-032, issue #68).
 *
 * An agent's claim of completion is a claim. Before a task may surface
 * in the inbox as done, the gate assesses the journaled evidence for the
 * run: `VerificationObserved` probes (test/build/lint/typecheck/
 * behavioral) and `TestFinished` results. Evidence is deterministic
 * adapter/journal fact (DEC-010) — never an LLM narrative.
 *
 * Verdict rule (deterministic):
 * - Collect every evidence-bearing journal event for the session/task,
 *   oldest to newest.
 * - `verified` requires at least one positive fact AND a positive
 *   latest fact — a failed probe after a green run means the latest
 *   truth is "not proven"; a green run after a failure means the fix
 *   cycle converged.
 * - No evidence at all → `unverified` (absence of proof is not proof).
 *
 * Manager accountability (DEC-032): an unverified completion claim is
 * itself an attention-worthy fact — {@link gateCompletion} journals a
 * `VerificationObserved{kind:'other', success:false}` record so the
 * unproven claim is part of the immutable record.
 */
import type { EntityId, Event } from '../../../domain/types.js';
import type { VerificationObservedEvent } from '../../../domain/events.js';
import type { VerificationKind } from '../../../domain/events.js';
import type { EventJournalPort } from '../../ports/outbound/repositories.js';
import { supervisorEventToJournalRow } from '../journal/event-journal-writer.js';

/** One deterministic piece of verification evidence from the journal. */
export interface VerificationFact {
  /** Evidence class: a probe kind, or 'test-run' for TestFinished rows. */
  readonly kind: VerificationKind | 'test-run';
  /** Whether this fact represents passing evidence. */
  readonly success: boolean;
  /** The command/probe that produced the evidence, when recorded. */
  readonly command?: string;
  /** Deterministic summary (e.g. "1623 passed, 0 failed"). */
  readonly summary?: string;
  /** Journal timestamp of the evidence. */
  readonly timestamp: string;
}

/** The outcome of assessing a claimed completion. */
export interface VerificationAssessment {
  readonly verdict: 'verified' | 'unverified';
  /** All evidence found, oldest to newest. */
  readonly facts: readonly VerificationFact[];
  readonly positiveCount: number;
  readonly negativeCount: number;
  /**
   * Evidence categories with no observed facts at all — informational;
   * the verdict does not require every category.
   */
  readonly missing: readonly string[];
}

/** Marker summary for claim records the gate itself journals. */
const UNVERIFIED_CLAIM_SUMMARY = 'completion claimed without verification evidence';

/** Evidence categories the gate scans for (informational `missing`). */
const EVIDENCE_KINDS: readonly string[] = ['test', 'build', 'lint', 'typecheck', 'behavioral'];

export interface VerificationGateDeps {
  readonly journal: EventJournalPort;
  /**
   * Sink for claim-record insert failures (issue #264) — a dropped
   * accountability record is a provenance gap, not a soft fail.
   * Receives the error and the converted journal row. MUST NOT throw.
   */
  readonly onJournalFailure?: (err: unknown, row: Event) => void;
}

export class VerificationGate {
  private readonly journal: EventJournalPort;
  private readonly onJournalFailure?: (err: unknown, row: Event) => void;

  constructor(deps: VerificationGateDeps) {
    this.journal = deps.journal;
    this.onJournalFailure = deps.onJournalFailure;
  }

  /**
   * Assess the journaled verification evidence for a task (optionally
   * narrowed to one session). Pure read — safe to call repeatedly.
   */
  assess(taskId: EntityId, sessionId?: EntityId): VerificationAssessment {
    const rows =
      sessionId !== undefined
        ? this.journal.listBySession(sessionId)
        : this.journal.listByTask(taskId);

    const facts: VerificationFact[] = [];
    for (const row of rows) {
      const fact = rowToFact(row);
      if (fact !== null) facts.push(fact);
    }
    facts.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));

    const positiveCount = facts.filter((f) => f.success).length;
    const negativeCount = facts.length - positiveCount;
    const latest = facts[facts.length - 1];
    const verdict = latest !== undefined && latest.success ? 'verified' : 'unverified';

    const observedKinds = new Set<string>(
      facts.map((f) => (f.kind === 'test-run' ? 'test' : f.kind)),
    );
    const missing = EVIDENCE_KINDS.filter((k) => !observedKinds.has(k));

    return { verdict, facts, positiveCount, negativeCount, missing };
  }

  /**
   * Gate a claimed completion: assesses evidence and, when the claim is
   * unverified, journals a `VerificationObserved` fact recording the
   * unproven claim (manager accountability, DEC-032). The claim record
   * is journal-only — it is written directly rather than published, so
   * the bus→journal writer never double-records it; the attention item
   * carries the live signal.
   *
   * Idempotent per claim: if the latest fact is already a claim record
   * for this completion, no duplicate is written.
   */
  gateCompletion(taskId: EntityId, sessionId: EntityId, agentId: string): VerificationAssessment {
    const assessment = this.assess(taskId, sessionId);
    if (assessment.verdict === 'verified') {
      return assessment;
    }
    const latest = assessment.facts[assessment.facts.length - 1];
    if (
      latest !== undefined &&
      latest.kind === 'other' &&
      latest.summary === UNVERIFIED_CLAIM_SUMMARY
    ) {
      // Already recorded for this claim — don't duplicate on replay.
      return assessment;
    }

    const event: VerificationObservedEvent = {
      type: 'VerificationObserved',
      timestamp: new Date().toISOString(),
      taskId,
      sessionId,
      agentId,
      adapterFidelityTier: 'B',
      kind: 'other',
      success: false,
      summary: UNVERIFIED_CLAIM_SUMMARY,
      evidence: { taskId, sessionId, agentId },
    };
    const row = supervisorEventToJournalRow(event);
    try {
      this.journal.insert(row);
    } catch (err) {
      // Best-effort record: an unregistered session/task cannot satisfy
      // the journal's foreign keys — the assessment and inbox item
      // still stand without it. The drop is surfaced as a journal-gap
      // attention item (#264) rather than silently lost.
      try {
        this.onJournalFailure?.(err, row);
      } catch {
        /* the sink itself must never break gating */
      }
      return assessment;
    }

    // Re-assess so the returned facts include the claim record.
    return this.assess(taskId, sessionId);
  }

  /**
   * Deterministic re-verification objective for routing an unverified
   * task back to its worker or manager (DEC-032): "run the suite, paste
   * results, demonstrate the behavior".
   */
  verificationObjective(assessment: VerificationAssessment): string {
    const needs = assessment.missing.length > 0 ? assessment.missing : ['test'];
    return (
      `Completion claimed without proof. Produce verification evidence: ` +
      `run the test suite and report results, report build/lint/typecheck ` +
      `status, and demonstrate observed runtime behavior where applicable. ` +
      `No evidence observed for: ${needs.join(', ')}.`
    );
  }
}

/* ------------------------------------------------------------------ *
 * Internal helpers
 * ------------------------------------------------------------------ */

/**
 * Map a journal row to a {@link VerificationFact} when it carries
 * evidence: `VerificationObserved` probes and `TestFinished` results.
 * Every other event kind is not verification evidence.
 */
function rowToFact(row: Event): VerificationFact | null {
  if (row.kind === 'VerificationObserved') {
    const p = row.payload;
    const kind = typeof p['kind'] === 'string' ? (p['kind'] as VerificationKind) : 'other';
    return {
      kind,
      success: p['success'] === true,
      ...(typeof p['command'] === 'string' ? { command: p['command'] } : {}),
      ...(typeof p['summary'] === 'string' ? { summary: p['summary'] } : {}),
      timestamp: row.timestamp,
    };
  }
  if (row.kind === 'TestFinished') {
    const p = row.payload;
    const passed = typeof p['passed'] === 'number' ? p['passed'] : 0;
    const failed = typeof p['failed'] === 'number' ? p['failed'] : 0;
    const framework = typeof p['framework'] === 'string' ? p['framework'] : 'tests';
    return {
      kind: 'test-run',
      success: failed === 0 && passed > 0,
      summary: `${framework}: ${passed} passed, ${failed} failed`,
      timestamp: row.timestamp,
    };
  }
  return null;
}
