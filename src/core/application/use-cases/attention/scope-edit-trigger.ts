/**
 * Out-of-Brief-scope edit trigger (issue #194/#214). See
 * `docs/RULES_MEMORY_AND_SUPERVISION.md` §7's "edits outside declared
 * task scope (git diff paths not matching the Brief's constraints)".
 *
 * Path matching supports three concrete cases, not a full glob engine
 * (ponytail: real usage is "this directory," "this file," or "this
 * prefix" — a glob dependency is not needed for that; add one if
 * patterns get more elaborate than these three):
 * - an exact path
 * - `dir/**`      — anything under `dir/`, or `dir` itself
 * - `prefix*`     — any path starting with `prefix`
 */
import type { ExecutionBrief } from '../../../domain/execution-brief.js';
import type { SupervisionSignal } from './supervision-ladder.js';

function matchesPattern(path: string, pattern: string): boolean {
  if (pattern.endsWith('/**')) {
    const dir = pattern.slice(0, -3);
    return path === dir || path.startsWith(`${dir}/`);
  }
  if (pattern.endsWith('*')) {
    return path.startsWith(pattern.slice(0, -1));
  }
  return path === pattern;
}

/** True when `path` matches at least one declared scope pattern. */
export function isInScope(path: string, scopePaths: readonly string[]): boolean {
  return scopePaths.some((pattern) => matchesPattern(path, pattern));
}

/**
 * Detect diff paths outside the compiled Brief's declared scope. No
 * `scopePaths` declared means no boundary was set — never flags, to
 * avoid false positives on Briefs that didn't specify one.
 */
export function detectOutOfScopeEdit(
  taskId: string,
  diffPaths: readonly string[],
  brief: ExecutionBrief,
): SupervisionSignal | null {
  if (brief.scopePaths === undefined || brief.scopePaths.length === 0) return null;
  const outOfScope = diffPaths.filter((path) => !isInScope(path, brief.scopePaths!));
  if (outOfScope.length === 0) return null;
  return {
    taskId,
    reason: `${outOfScope.length} edited path(s) outside the Brief's declared scope`,
    evidence: { outOfScopePaths: outOfScope, scopePaths: brief.scopePaths },
  };
}
