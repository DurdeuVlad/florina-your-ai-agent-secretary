/**
 * Context-health view (issue #74, DEC-035): per continuous agent —
 * Florina, managers — window fill, last condensation, and event
 * pressure. Drill-down from the inbox's DegradedContext items.
 *
 * Pure view model + {@link RenderTree} template over
 * {@link ContextHealthSnapshot}s.
 */
import type { ContextHealthSnapshot } from '../../../../core/application/use-cases/context/context-health-monitor.js';
import type { ContextHealthStatus } from '../../../../core/domain/events.js';
import type { RenderTree } from './view-types.js';

/** Display metadata per health status. */
export const HEALTH_METADATA: Readonly<
  Record<ContextHealthStatus, { icon: string; color: string; label: string }>
> = {
  ok: { icon: 'check', color: 'green', label: 'Healthy' },
  degraded: { icon: 'gauge', color: 'orange', label: 'Degraded' },
  critical: { icon: 'flame', color: 'red', label: 'Critical' },
};

/** One agent row in the context-health panel. */
export interface AgentHealthView {
  readonly agentId: string;
  readonly taskId?: string;
  readonly status: ContextHealthStatus;
  readonly windowFillPct: number;
  readonly eventsSinceCondensation: number;
  readonly condensationCount: number;
  readonly lastCondensationAt?: string;
}

/** Full context-health view data, worst status first. */
export interface ContextHealthViewData {
  readonly agents: readonly AgentHealthView[];
  readonly worstStatus: ContextHealthStatus;
  readonly isEmpty: boolean;
}

const STATUS_RANK: Readonly<Record<ContextHealthStatus, number>> = {
  critical: 0,
  degraded: 1,
  ok: 2,
};

/**
 * Build the view from monitor snapshots — sorted worst-first so the
 * panel reads as a triage list.
 */
export function buildContextHealthView(
  snapshots: readonly ContextHealthSnapshot[],
): ContextHealthViewData {
  const agents = [...snapshots]
    .sort(
      (a, b) =>
        STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
        b.windowFillPct - a.windowFillPct ||
        a.agentId.localeCompare(b.agentId),
    )
    .map((s) => ({
      agentId: s.agentId,
      ...(s.taskId !== undefined ? { taskId: s.taskId } : {}),
      status: s.status,
      windowFillPct: s.windowFillPct,
      eventsSinceCondensation: s.eventsSinceCondensation,
      condensationCount: s.condensationCount,
      ...(s.lastCondensationAt !== undefined ? { lastCondensationAt: s.lastCondensationAt } : {}),
    }));
  const worstStatus = agents.length === 0 ? 'ok' : agents[0]!.status;
  return { agents, worstStatus, isEmpty: agents.length === 0 };
}

function el(
  tag: string,
  props?: Record<string, unknown>,
  children?: readonly (RenderTree | string)[],
): RenderTree {
  return { tag, props, children };
}

/** Render one agent's health row. */
export function renderAgentHealthRow(view: AgentHealthView): RenderTree {
  const meta = HEALTH_METADATA[view.status];
  return el(
    'AgentHealthRow',
    { agentId: view.agentId, status: view.status, statusColor: meta.color },
    [
      el('HealthHeader', { layout: 'row', gap: 'sm' }, [
        el('Icon', { name: meta.icon, color: meta.color }, []),
        el('AgentLabel', {}, [view.agentId]),
        el('StatusLabel', { color: meta.color }, [meta.label]),
      ]),
      el('WindowFillBar', {
        pct: view.windowFillPct,
        color: meta.color,
        label: `window ${(view.windowFillPct * 100).toFixed(0)}%`,
      }),
      el('HealthDetails', { layout: 'row', gap: 'md' }, [
        el('Detail', { label: 'events since condensation' }, [
          String(view.eventsSinceCondensation),
        ]),
        el('Detail', { label: 'condensations' }, [String(view.condensationCount)]),
        el('Detail', { label: 'last condensation' }, [view.lastCondensationAt ?? 'never']),
      ]),
    ],
  );
}

/** Render the full context-health panel. */
export function renderContextHealthView(view: ContextHealthViewData): RenderTree {
  return el(
    'ContextHealthView',
    { worstStatus: view.worstStatus, empty: view.isEmpty },
    view.agents.length > 0
      ? view.agents.map(renderAgentHealthRow)
      : [el('EmptyHint', {}, ['no agent context tracked yet'])],
  );
}
