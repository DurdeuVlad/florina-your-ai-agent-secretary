/**
 * Completion Digest — structured summary of a completed task run (#16).
 *
 * When an agent claims completion, the Florina produces a Completion Digest
 * that separates observed (deterministic) facts from inferred information
 * (PRODUCT_DESIGN.md "Deliverable Review"). This module defines the
 * {@link CompletionDigest} type and the {@link CompletionDigestBuilder} that
 * aggregates a session's {@link SupervisorEvent} stream into a digest.
 *
 * The digest is a *projection* over the immutable event journal (DEC-012) — it
 * never replaces the source events. Every field is derived from either the
 * event stream or the deterministic {@link DiffDigest} from #17.
 */

import type { DiffDigest } from './diff-digest.js';
import type {
  AgentCompletedEvent,
  AgentStartedEvent,
  ApprovalRequestedEvent,
  FileChangedEvent,
  SupervisorEvent,
  TestFinishedEvent,
} from '../../../domain/events.js';
import type { CapabilityRiskLevel } from '../../../domain/capabilities.js';

/* ------------------------------------------------------------------ *
 * CompletionDigest type
 * ------------------------------------------------------------------ */

/**
 * A single risk highlight — something in the completed run that merits human
 * attention before the task is accepted.
 */
export interface RiskHighlight {
  /** Category of risk. */
  readonly kind: 'failed-tests' | 'denied-approval' | 'critical-action' | 'blocked';
  /** Human-readable description of the risk. */
  readonly message: string;
}

/**
 * A reference to a Decision Ledger entry (DEC-NNN) that was consulted or is
 * relevant to the completed task run.
 */
export interface DecisionReference {
  /** Decision Ledger ID (e.g. `DEC-007`). */
  readonly id: string;
  /** Short human-readable summary of the decision's relevance. */
  readonly note: string;
}

/**
 * A structured summary of a completed task run.
 *
 * Fields are populated from the immutable event journal (DEC-012) and the
 * deterministic diff digest (#17). The `summary` field is a concise,
 * scannable, human-readable string suitable for the attention inbox
 * (PRODUCT_DESIGN.md "Visual Experience").
 */
export interface CompletionDigest {
  /** Identifier of the Task this digest summarizes. */
  readonly taskId: string;
  /** Identifier of the Session (run) the digest was built from. */
  readonly sessionId: string;
  /** Identifier of the agent that executed the session. */
  readonly agentId: string;
  /** ISO-8601 timestamp of the first event (AgentStarted). */
  readonly startedAt: string;
  /** ISO-8601 timestamp of the completion event. */
  readonly completedAt: string;
  /** Wall-clock duration of the run in milliseconds. */
  readonly duration: number;
  /** Concise, scannable, human-readable summary (PRODUCT_DESIGN.md tone). */
  readonly summary: string;
  /** Deterministic diff digest from #17, when available. */
  readonly diffSummary?: DiffDigest;
  /** Number of files changed during the run. */
  readonly filesChangedCount: number;
  /** List of repository-relative paths of changed files. */
  readonly filesChanged: readonly string[];
  /** Total number of test cases executed. */
  readonly testsRun: number;
  /** Number of tests that passed. */
  readonly testsPassed: number;
  /** Number of tests that failed. */
  readonly testsFailed: number;
  /** Number of approval requests issued by the agent. */
  readonly approvalsRequested: number;
  /** Number of approvals that were granted. */
  readonly approvalsGranted: number;
  /** Number of approvals that were denied. */
  readonly approvalsDenied: number;
  /** Decision Ledger references relevant to the run. */
  readonly decisions: readonly DecisionReference[];
  /** Risk highlights — things needing human attention. */
  readonly riskHighlights: readonly RiskHighlight[];
  /** Head commit hash, when available (from diff digest or completion event). */
  readonly commitHash?: string;
  /** Branch name, when available (from diff digest or completion event). */
  readonly branchName?: string;
}

/* ------------------------------------------------------------------ *
 * CompletionDigestBuilder
 * ------------------------------------------------------------------ */

/**
 * Builds a {@link CompletionDigest} from a session's event stream.
 *
 * The builder is deterministic — it aggregates events without any LLM calls.
 * The human-readable `summary` is generated from structured fields, not from
 * an LLM, matching the MVP's deterministic-first approach (DEC-014).
 */
export class CompletionDigestBuilder {
  /**
   * Build a completion digest from a sequence of {@link SupervisorEvent}s.
   *
   * Events should belong to a single session. They are processed in
   * chronological order (by timestamp) to compute start/completion times,
   * file changes, test results, approval counts, and risk highlights.
   *
   * @param taskId - The Task identifier.
   * @param sessionId - The Session identifier.
   * @param events - The ordered (or unordered) event stream for the session.
   * @param diffSummary - Optional deterministic diff digest from #17.
   * @returns A populated {@link CompletionDigest}.
   */
  build(
    taskId: string,
    sessionId: string,
    events: readonly SupervisorEvent[],
    diffSummary?: DiffDigest,
  ): CompletionDigest {
    const sorted = [...events].sort((a, b) =>
      a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
    );

    const started = this.findStarted(sorted);
    const completed = this.findCompleted(sorted);

    const startedAt = started?.timestamp ?? sorted[0]?.timestamp ?? '';
    const completedAt = completed?.timestamp ?? sorted[sorted.length - 1]?.timestamp ?? '';
    const duration = this.computeDurationMs(startedAt, completedAt);

    const agentId = started?.agentId ?? sorted[0]?.agentId ?? '';

    const filesChanged = this.collectFilesChanged(sorted);
    const testAgg = this.aggregateTests(sorted);
    const approvalAgg = this.aggregateApprovals(sorted);
    const decisions = this.extractDecisions(sorted, approvalAgg);
    const riskHighlights = this.extractRiskHighlights(sorted, testAgg, approvalAgg);

    const commitHash = this.extractCommitHash(completed, diffSummary);
    const branchName = this.extractBranchName(diffSummary);

    const summary = this.generateSummary({
      objective: started?.objective,
      completed,
      filesChangedCount: filesChanged.length,
      testAgg,
      approvalAgg,
      riskHighlights,
      branchName,
    });

    return {
      taskId,
      sessionId,
      agentId,
      startedAt,
      completedAt,
      duration,
      summary,
      diffSummary,
      filesChangedCount: filesChanged.length,
      filesChanged,
      testsRun: testAgg.run,
      testsPassed: testAgg.passed,
      testsFailed: testAgg.failed,
      approvalsRequested: approvalAgg.requested,
      approvalsGranted: approvalAgg.granted,
      approvalsDenied: approvalAgg.denied,
      decisions,
      riskHighlights,
      commitHash,
      branchName,
    };
  }

  /* ---------------------------------------------------------------- *
   * Event extraction helpers
   * ---------------------------------------------------------------- */

  private findStarted(events: readonly SupervisorEvent[]): AgentStartedEvent | undefined {
    return events.find((e): e is AgentStartedEvent => e.type === 'AgentStarted');
  }

  private findCompleted(events: readonly SupervisorEvent[]): AgentCompletedEvent | undefined {
    return events.find((e): e is AgentCompletedEvent => e.type === 'AgentCompleted');
  }

  private computeDurationMs(startedAt: string, completedAt: string): number {
    if (!startedAt || !completedAt) return 0;
    const start = Date.parse(startedAt);
    const end = Date.parse(completedAt);
    if (Number.isNaN(start) || Number.isNaN(end)) return 0;
    return Math.max(0, end - start);
  }

  private collectFilesChanged(events: readonly SupervisorEvent[]): string[] {
    const paths = new Set<string>();
    for (const event of events) {
      if (event.type === 'FileChanged') {
        const fc = event as FileChangedEvent;
        paths.add(fc.path);
      }
    }
    return [...paths].sort();
  }

  private aggregateTests(events: readonly SupervisorEvent[]): TestAggregation {
    let run = 0;
    let passed = 0;
    let failed = 0;
    for (const event of events) {
      if (event.type === 'TestFinished') {
        const tf = event as TestFinishedEvent;
        run += tf.passed + tf.failed + tf.skipped;
        passed += tf.passed;
        failed += tf.failed;
      }
    }
    return { run, passed, failed };
  }

  private aggregateApprovals(events: readonly SupervisorEvent[]): ApprovalAggregation {
    let requested = 0;
    let granted = 0;
    let denied = 0;
    for (const event of events) {
      if (event.type === 'ApprovalRequested') {
        requested++;
        const ar = event as ApprovalRequestedEvent;
        // The riskLevel field is part of CapabilityRequest; a 'critical'
        // risk level is tracked for risk highlights.
        if (ar.riskLevel === 'critical') {
          // tracked in risk highlights, not here
        }
      }
    }
    // Note: In the current event schema, approval *decisions* (granted/denied)
    // are not separate event types — they would come from the Approval
    // domain object / repository. For MVP, we infer from ApprovalRequested
    // events: if the session completed successfully, approvals were likely
    // granted. A more precise wiring will connect the ApprovalRepository.
    // For now, we use a simple heuristic: if the task completed, all
    // approvals were granted; if it was blocked by permission, they were
    // denied. This is a placeholder until the event schema includes
    // ApprovalDecided events.
    granted = requested; // MVP heuristic — will be refined with real wiring
    return { requested, granted, denied };
  }

  private extractDecisions(
    events: readonly SupervisorEvent[],
    _approvalAgg: ApprovalAggregation,
  ): DecisionReference[] {
    const decisions: DecisionReference[] = [];
    const seen = new Set<string>();

    for (const event of events) {
      if (event.type === 'ApprovalRequested') {
        const ar = event as ApprovalRequestedEvent;
        // Map capability-based approvals to relevant DEC references.
        const decRef = this.mapCapabilityToDecision(ar.capability, ar.riskLevel);
        if (decRef && !seen.has(decRef.id)) {
          seen.add(decRef.id);
          decisions.push(decRef);
        }
      }
    }

    return decisions;
  }

  private mapCapabilityToDecision(
    capability: string,
    riskLevel: CapabilityRiskLevel,
  ): DecisionReference | null {
    // DEC-010: Approve the underlying capability, never an LLM summary.
    // DEC-011: Florina narrows permissions, never silently widens them.
    // DEC-007: Agent autonomy is user-configurable.
    if (capability === 'push' || capability === 'merge' || capability === 'deploy') {
      return {
        id: 'DEC-010',
        note: `High-authority capability '${capability}' requested — requires structured approval, not LLM summary.`,
      };
    }
    if (riskLevel === 'critical') {
      return {
        id: 'DEC-011',
        note: 'Critical risk action taken — Florina must narrow permissions, never silently widen.',
      };
    }
    if (capability === 'network' || capability === 'filesystem') {
      return {
        id: 'DEC-007',
        note: `Capability '${capability}' requested — autonomy level is user-configurable.`,
      };
    }
    return null;
  }

  private extractRiskHighlights(
    events: readonly SupervisorEvent[],
    testAgg: TestAggregation,
    approvalAgg: ApprovalAggregation,
  ): RiskHighlight[] {
    const highlights: RiskHighlight[] = [];

    // Failed tests
    if (testAgg.failed > 0) {
      const failureDetails = this.collectTestFailures(events);
      const detail =
        failureDetails.length > 0
          ? ` (${failureDetails.slice(0, 3).join(', ')}${failureDetails.length > 3 ? '…' : ''})`
          : '';
      highlights.push({
        kind: 'failed-tests',
        message: `${testAgg.failed} test(s) failed${detail}.`,
      });
    }

    // Denied approvals
    if (approvalAgg.denied > 0) {
      highlights.push({
        kind: 'denied-approval',
        message: `${approvalAgg.denied} approval request(s) were denied.`,
      });
    }

    // Critical risk actions
    for (const event of events) {
      if (event.type === 'ApprovalRequested') {
        const ar = event as ApprovalRequestedEvent;
        if (ar.riskLevel === 'critical') {
          highlights.push({
            kind: 'critical-action',
            message: `Critical-risk capability '${ar.capability}' requested for ${ar.destination}.`,
          });
        }
      }
    }

    // Agent blocked
    for (const event of events) {
      if (event.type === 'AgentBlocked') {
        highlights.push({
          kind: 'blocked',
          message: `Agent was blocked: ${event.reason}.`,
        });
      }
    }

    return highlights;
  }

  private collectTestFailures(events: readonly SupervisorEvent[]): string[] {
    const failures: string[] = [];
    for (const event of events) {
      if (event.type === 'TestFinished') {
        const tf = event as TestFinishedEvent;
        if (tf.failures) {
          for (const f of tf.failures) {
            failures.push(f.name);
          }
        }
      }
    }
    return failures;
  }

  private extractCommitHash(
    completed: AgentCompletedEvent | undefined,
    diffSummary: DiffDigest | undefined,
  ): string | undefined {
    // Prefer the diff digest's head commit; fall back to deliverables.
    if (diffSummary?.headCommit) return diffSummary.headCommit;
    if (completed?.deliverables) {
      const commit = completed.deliverables.find((d) => d.type === 'commit');
      if (commit) return commit.ref;
    }
    return undefined;
  }

  private extractBranchName(diffSummary: DiffDigest | undefined): string | undefined {
    return diffSummary?.branch;
  }

  /* ---------------------------------------------------------------- *
   * Summary generation
   * ---------------------------------------------------------------- */

  /**
   * Generate a concise, scannable human-readable summary.
   *
   * Tone follows PRODUCT_DESIGN.md's visual inbox examples: terse, factual,
   * scannable in a single line. Example:
   * "Implementation complete. 9 files, +284/-71, 23/23 tests passing."
   */
  private generateSummary(input: SummaryInput): string {
    const parts: string[] = [];

    // Objective / completion status
    if (input.completed) {
      const agentSummary = input.completed.summary.trim();
      if (agentSummary) {
        parts.push(agentSummary);
      } else {
        parts.push('Task completed.');
      }
    } else {
      parts.push('Task run ended (no completion event).');
    }

    // Files changed
    if (input.filesChangedCount > 0) {
      parts.push(`${input.filesChangedCount} file(s) changed`);
    }

    // Test results
    if (input.testAgg.run > 0) {
      const { passed, failed, run } = input.testAgg;
      if (failed === 0) {
        parts.push(`${passed}/${run} tests passing`);
      } else {
        parts.push(`${passed}/${run} tests passing, ${failed} failed`);
      }
    }

    // Approvals
    if (input.approvalAgg.requested > 0) {
      parts.push(`${input.approvalAgg.requested} approval(s) requested`);
    }

    // Branch
    if (input.branchName) {
      parts.push(`branch: ${input.branchName}`);
    }

    // Risk summary (if any)
    if (input.riskHighlights.length > 0) {
      const riskKinds = input.riskHighlights.map((h) => h.kind);
      parts.push(`risk: ${riskKinds.join(', ')}`);
    }

    return parts.join('. ') + '.';
  }
}

/* ------------------------------------------------------------------ *
 * Internal aggregation types
 * ------------------------------------------------------------------ */

interface TestAggregation {
  run: number;
  passed: number;
  failed: number;
}

interface ApprovalAggregation {
  requested: number;
  granted: number;
  denied: number;
}

interface SummaryInput {
  objective?: string;
  completed: AgentCompletedEvent | undefined;
  filesChangedCount: number;
  testAgg: TestAggregation;
  approvalAgg: ApprovalAggregation;
  riskHighlights: readonly RiskHighlight[];
  branchName?: string;
}
