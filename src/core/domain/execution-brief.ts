/**
 * Execution Brief — the §6.4 inspectable artifact (DEC-039 §6, issue
 * #191/#207/#208). The data shape lives in domain (it's a journaled
 * artifact attached to `AgentStartedEvent`, per §6.4: "the actual object
 * handed to the manager/worker's prompt"); the compilation pipeline
 * (`compileExecutionBrief`) lives in
 * `application/use-cases/memory/execution-brief.ts`, which depends on
 * this module rather than the reverse (domain never depends on
 * application, DEC-037).
 */
import type { MemoryItem, MemoryScope } from './memory.js';

/** One line of the compiled Brief's "Applicable rules" section. */
export interface ExecutionBriefRuleLine {
  readonly id: string;
  readonly statement: string;
  readonly provenance: MemoryItem['provenance'];
  readonly scope: MemoryScope;
}

export interface ExecutionBrief {
  readonly objective: string;
  readonly relevantContext: readonly string[];
  readonly applicableRules: readonly ExecutionBriefRuleLine[];
  /** Prose non-goals / scope boundaries (§6.4's "Constraints"). */
  readonly constraints: readonly string[];
  readonly requiredVerification: readonly string[];
  readonly definitionOfDone: string;
  readonly providerRationale: string;
  /**
   * Structured path patterns declaring where edits are expected (issue
   * #214). Supports an exact path, a `dir/**` directory wildcard, or a
   * trailing `*` prefix wildcard — intentionally not a full glob engine
   * (ponytail: three concrete cases cover real usage; upgrade to a glob
   * library if patterns get more complex than that). Undefined/empty
   * means no declared boundary — the out-of-scope-edit detector never
   * flags anything when scope wasn't declared, to avoid false positives.
   */
  readonly scopePaths?: readonly string[];
}
