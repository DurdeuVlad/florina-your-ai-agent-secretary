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
  readonly requiredVerification: readonly string[];
  readonly definitionOfDone: string;
  readonly providerRationale: string;
}
