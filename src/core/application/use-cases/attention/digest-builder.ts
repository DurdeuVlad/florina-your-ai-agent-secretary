/**
 * Digest Builder orchestrator — ties together event journal query, diff
 * digest, and completion digest construction (#16).
 *
 * For MVP, the orchestrator accepts events and an optional diff digest as
 * inputs rather than wiring to actual database queries. This keeps the
 * module testable in isolation and allows the daemon to wire the real
 * `EventRepository` + `DiffAnalyzer` when it is ready.
 *
 * The orchestrator is the single entry point the daemon calls when an agent
 * reports completion:
 * ```ts
 * const digest = digestBuilder.buildDigestForTask(taskId, sessionId, events, diffDigest);
 * ```
 */

import type { SupervisorEvent } from '../../../domain/events.js';
import type { DiffDigest } from './diff-digest.js';
import { CompletionDigestBuilder } from './completion-digest.js';
import type { CompletionDigest } from './completion-digest.js';

/**
 * Optional inputs for building a digest. For MVP these are passed directly;
 * in the full wiring they will be fetched from the event journal and
 * `DiffAnalyzer`.
 */
export interface DigestBuildInput {
  /** Identifier of the Task to build a digest for. */
  readonly taskId: string;
  /** Identifier of the Session (run) to build a digest for. */
  readonly sessionId: string;
  /** The event stream for the session, in any order. */
  readonly events: readonly SupervisorEvent[];
  /** Optional deterministic diff digest from #17. */
  readonly diffDigest?: DiffDigest;
}

/**
 * Orchestrates completion digest construction.
 *
 * Wraps a {@link CompletionDigestBuilder} and provides a single
 * `buildDigestForTask` method. In the full implementation this will query
 * the `EventRepository` for the session's events and call `DiffAnalyzer` for
 * the diff; for MVP it accepts them as inputs.
 */
export class DigestBuilder {
  private readonly builder: CompletionDigestBuilder;

  constructor(builder?: CompletionDigestBuilder) {
    this.builder = builder ?? new CompletionDigestBuilder();
  }

  /**
   * Build a {@link CompletionDigest} for a task's session.
   *
   * @param input - The task ID, session ID, events, and optional diff digest.
   * @returns A populated {@link CompletionDigest}.
   */
  buildDigestForTask(input: DigestBuildInput): CompletionDigest {
    return this.builder.build(input.taskId, input.sessionId, input.events, input.diffDigest);
  }
}
