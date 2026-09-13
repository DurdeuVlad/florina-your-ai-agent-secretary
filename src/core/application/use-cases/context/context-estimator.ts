/**
 * Context token estimation and budget-aware truncation utilities (#30,
 * DEC-020).
 *
 * The {@link ContextResolver} assembles a context capsule from the immutable
 * event journal (DEC-012) and scoped storage. Because an LLM context window
 * is finite, the assembled capsule must fit within a token budget. This
 * module provides cheap, deterministic token estimation (~4 chars/token
 * heuristic) and priority-ordered truncation that preserves critical and
 * high-priority items while dropping low-priority history first.
 *
 * Prioritization (PRODUCT_DESIGN.md "Attention Model"):
 * - **critical**: failures, human-input requests, critical-risk approvals.
 * - **high**: completions, blocks, test failures.
 * - **medium**: file changes, test runs, agent start/stop.
 * - **low**: routine progress, tool start/finish.
 *
 * Truncation drops **low** first, then **medium**, keeping **critical** and
 * **high** items whenever possible.
 */
import type { ContextCapsule, Event } from '../../../domain/types.js';
// Type-only import: erased at compile time, so no runtime circular dependency
// with ./context-resolver.js (which imports this module's functions at runtime).
import type { AssembledContextCapsule, Priority, PrioritizedEvent } from './context-resolver.js';

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

/**
 * Default characters-per-token ratio for the cheap token heuristic
 * (~4 chars/token, per the issue spec). This is not a real tokenizer — it
 * is sufficient for budget enforcement in the MVP.
 */
export const DEFAULT_CHARS_PER_TOKEN = 4;

/**
 * Default token budget for an assembled context capsule (8000 tokens, per
 * the issue spec).
 */
export const DEFAULT_TOKEN_BUDGET = 8000;

/* ------------------------------------------------------------------ *
 * Token estimation
 * ------------------------------------------------------------------ */

/**
 * Estimate the number of tokens in a string using a characters-per-token
 * heuristic (~4 chars/token by default).
 *
 * The estimate rounds up so budgets are never silently exceeded.
 *
 * @param text - The text to estimate tokens for.
 * @param charsPerToken - Characters per token (default 4).
 * @returns The estimated token count (always at least 1 for non-empty text).
 */
export function estimateTokens(
  text: string,
  charsPerToken: number = DEFAULT_CHARS_PER_TOKEN,
): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / charsPerToken);
}

/**
 * Estimate the token cost of a domain {@link ContextCapsule} by serializing
 * it to JSON and applying the chars-per-token heuristic.
 *
 * @param capsule - The context capsule to estimate.
 * @param charsPerToken - Characters per token (default 4).
 * @returns The estimated token count.
 */
export function estimateCapsuleTokens(
  capsule: ContextCapsule,
  charsPerToken: number = DEFAULT_CHARS_PER_TOKEN,
): number {
  return estimateTokens(JSON.stringify(capsule), charsPerToken);
}

/**
 * Estimate the token cost of a fully {@link AssembledContextCapsule}
 * (including all structured sections: events, approvals, decisions,
 * digests, worktree status, and the embedded domain capsule).
 *
 * @param capsule - The assembled context capsule to estimate.
 * @param charsPerToken - Characters per token (default 4).
 * @returns The estimated token count.
 */
export function estimateAssembledTokens(
  capsule: AssembledContextCapsule,
  charsPerToken: number = DEFAULT_CHARS_PER_TOKEN,
): number {
  return estimateTokens(JSON.stringify(capsule), charsPerToken);
}

/* ------------------------------------------------------------------ *
 * Event priority classification
 * ------------------------------------------------------------------ */

/**
 * Importance tier for a single event, used by truncation to decide what to
 * drop first when the token budget is exceeded.
 *
 * - `critical` — failures, human-input requests, critical-risk approvals.
 * - `high` — completions, blocks, test runs with failures.
 * - `medium` — file changes, clean test runs, agent start/stop.
 * - `low` — routine progress, tool start/finish.
 */
export { type Priority };

/**
 * Weight table mapping each canonical event kind to a priority tier.
 *
 * Events not directly represented default to `medium`.
 */
const EVENT_PRIORITY: Readonly<Record<string, Priority>> = {
  AgentFailed: 'critical',
  HumanInputRequested: 'critical',
  AgentCompleted: 'high',
  AgentBlocked: 'high',
  ApprovalRequested: 'high',
  AgentStopped: 'medium',
  TestStarted: 'medium',
  TestFinished: 'medium',
  FileChanged: 'medium',
  AgentStarted: 'medium',
  ToolStarted: 'low',
  ToolFinished: 'low',
  AgentProgress: 'low',
};

/**
 * Classify an event into a priority tier based on its kind and payload.
 *
 * `ApprovalRequested` events with a `critical` risk level are promoted to
 * `critical`; otherwise they are `high`. `TestFinished` events with one or
 * more failures are promoted to `high`.
 *
 * @param event - The event to classify.
 * @returns The priority tier (`critical` | `high` | `medium` | `low`).
 */
export function classifyEventPriority(event: Event): Priority {
  const base = EVENT_PRIORITY[event.kind] ?? 'medium';

  // Promote critical-risk approval requests to critical.
  if (event.kind === 'ApprovalRequested') {
    const riskLevel = event.payload['riskLevel'];
    if (typeof riskLevel === 'string' && riskLevel === 'critical') {
      return 'critical';
    }
  }

  // Promote test runs with failures to high.
  if (event.kind === 'TestFinished') {
    const failed = event.payload['failed'];
    if (typeof failed === 'number' && failed > 0) {
      return 'high';
    }
  }

  return base;
}

/* ------------------------------------------------------------------ *
 * Budget-aware truncation
 * ------------------------------------------------------------------ */

/**
 * Priority order from lowest (dropped first) to highest (kept longest).
 */
const TRUNCATION_ORDER: readonly Priority[] = ['low', 'medium', 'high', 'critical'];

/**
 * Truncate an assembled context capsule to fit within a token budget,
 * dropping low-priority events first, then medium, while keeping critical
 * and high-priority items whenever possible.
 *
 * Truncation proceeds in stages:
 * 1. Drop all `low`-priority events.
 * 2. Drop all `medium`-priority events.
 * 3. Drop `high`-priority events (oldest first).
 * 4. Truncate recent digests (keep most recent).
 * 5. Truncate recent decisions (keep most recent).
 *
 * Critical-priority events are never dropped by this function — if the
 * capsule still exceeds the budget after all other truncation, the result
 * is returned as-is (critical content is preserved over fitting).
 *
 * @param capsule - The assembled context capsule to truncate.
 * @param budget - Maximum total tokens for the truncated capsule.
 * @param charsPerToken - Characters per token (default 4).
 * @returns A new (possibly truncated) assembled context capsule.
 */
export function truncateToBudget(
  capsule: AssembledContextCapsule,
  budget: number,
  charsPerToken: number = DEFAULT_CHARS_PER_TOKEN,
): AssembledContextCapsule {
  let current = capsule;
  let currentTokens = estimateAssembledTokens(current, charsPerToken);

  if (currentTokens <= budget) {
    return current;
  }

  // Stage 1–2: drop low, then medium priority events.
  for (const dropPriority of ['low', 'medium'] as const) {
    if (currentTokens <= budget) break;
    current = {
      ...current,
      recentEvents: current.recentEvents.filter((pe) => pe.priority !== dropPriority),
    };
    currentTokens = estimateAssembledTokens(current, charsPerToken);
  }

  // Stage 3: drop high-priority events, oldest first, until within budget.
  if (currentTokens > budget) {
    const highEvents = current.recentEvents.filter((pe) => pe.priority === 'high');
    const sortedHigh = [...highEvents].sort((a, b) =>
      a.event.timestamp < b.event.timestamp ? -1 : 1,
    );
    let remainingHigh = [...sortedHigh];
    while (currentTokens > budget && remainingHigh.length > 0) {
      remainingHigh = remainingHigh.slice(1);
      const highIds = new Set(remainingHigh.map((pe) => pe.event.id));
      current = {
        ...current,
        recentEvents: current.recentEvents.filter(
          (pe) => pe.priority !== 'high' || highIds.has(pe.event.id),
        ),
      };
      currentTokens = estimateAssembledTokens(current, charsPerToken);
    }
  }

  // Stage 4: truncate recent digests (keep most recent).
  if (currentTokens > budget && current.recentDigests.length > 0) {
    for (let keep = current.recentDigests.length - 1; keep >= 0; keep--) {
      const trimmed = current.recentDigests.slice(0, keep);
      const candidate: AssembledContextCapsule = { ...current, recentDigests: trimmed };
      if (estimateAssembledTokens(candidate, charsPerToken) <= budget) {
        current = candidate;
        currentTokens = estimateAssembledTokens(current, charsPerToken);
        break;
      }
      current = candidate;
      currentTokens = estimateAssembledTokens(current, charsPerToken);
    }
  }

  // Stage 5: truncate recent decisions (keep most recent).
  if (currentTokens > budget && current.recentDecisions.length > 0) {
    for (let keep = current.recentDecisions.length - 1; keep >= 0; keep--) {
      const trimmed = current.recentDecisions.slice(0, keep);
      const candidate: AssembledContextCapsule = {
        ...current,
        recentDecisions: trimmed,
      };
      if (estimateAssembledTokens(candidate, charsPerToken) <= budget) {
        current = candidate;
        currentTokens = estimateAssembledTokens(current, charsPerToken);
        break;
      }
      current = candidate;
      currentTokens = estimateAssembledTokens(current, charsPerToken);
    }
  }

  // Recompute the final estimated tokens on the truncated capsule.
  return { ...current, estimatedTokens: currentTokens };
}

/**
 * Count how many events of each priority tier are present in a list of
 * prioritized events. Useful for diagnostics and tests.
 */
export function countByPriority(events: readonly PrioritizedEvent[]): Record<Priority, number> {
  const counts: Record<Priority, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };
  for (const pe of events) {
    counts[pe.priority]++;
  }
  return counts;
}

/** Re-export for consumers that want the truncation order. */
export { TRUNCATION_ORDER };
