/**
 * Provider transition/failover indicator (DEC-029, issue #202).
 *
 * A `TaskFailedOver` event is already journaled by DEC-029's failover
 * mechanism — this module only renders it distinctly ("moved from Codex
 * to Claude, quota, 14:32" per `docs/UX_FLOWS.md` flow F) instead of
 * folding it into a generic timeline row. Shared by the Session
 * Inspector's event timeline and, once the desktop catch-up view exists
 * (#195/#217 currently only ship the CLI rendering), that surface too —
 * "reusing this same rendering" per #202's third acceptance criterion.
 */
import type { FailoverReason } from '../../../../core/domain/events.js';
import type { RenderTree } from './view-types.js';

function el(
  tag: string,
  props?: Record<string, unknown>,
  children?: readonly (RenderTree | string)[],
): RenderTree {
  return { tag, props, children };
}

/** The fields `providerTransitionText`/`renderProviderTransitionRow` need — read from a
 * journaled `TaskFailedOver` event's payload (already the typed shape at the point of
 * emission; re-declared here as a plain object so this module doesn't need the full
 * `Event`/`TaskFailedOverEvent` journal-row typing, just the three fields it renders). */
export interface ProviderTransitionFacts {
  readonly fromProvider: string;
  readonly toProvider: string;
  readonly reason: FailoverReason;
}

const REASON_LABEL: Record<FailoverReason, string> = {
  quota_exhausted: 'quota',
  error: 'error',
  preference: 'preference',
  manual: 'manual override',
};

/** "moved from Codex to Claude, quota, 14:32" — the flow F worked example's exact shape. */
export function providerTransitionText(facts: ProviderTransitionFacts, timeLabel: string): string {
  return `moved from ${facts.fromProvider} to ${facts.toProvider}, ${REASON_LABEL[facts.reason]}, ${timeLabel}`;
}

/** Distinct timeline row for a provider transition — never folded into a generic event row. */
export function renderProviderTransitionRow(
  facts: ProviderTransitionFacts,
  timeLabel: string,
  props: { readonly command?: string; readonly selected?: boolean } = {},
): RenderTree {
  return el(
    'InspRow',
    { ...props, selectable: props.command !== undefined, variant: 'provider-transition' },
    [
      el('InspRowTitle', { color: 'info' }, ['⇄ Provider transition']),
      el('InspRowSub', {}, [providerTransitionText(facts, timeLabel)]),
    ],
  );
}

/** Current provider = the most recently appended agent id (failover appends, never replaces). */
export function currentProvider(agentIds: readonly string[]): string {
  return agentIds[agentIds.length - 1] ?? '';
}

/** Providers used earlier in the task's run, oldest first, excluding the current one. */
export function priorProviders(agentIds: readonly string[]): readonly string[] {
  return agentIds.slice(0, -1);
}
