/**
 * Fleet & quota screen (issue #127, mockup `docs/mockups/fleet.html`).
 *
 * The only screen where capacity is visualized — DG-01 §3.5 keeps it out
 * of the inbox. Renders the `query-fleet` response into a serializable
 * {@link RenderTree} matching the mockup's card/chip/bar/row vocabulary:
 *
 *  - **Providers**: utilization bar, available/exhausted chip, reset
 *    countdown.
 *  - **Parked**: tasks waiting on quota with their resume times.
 *  - **Routing decisions**: journaled failover/park/resume one-liners.
 *
 * All values are observed (journaled events + quota-ledger
 * observations) — nothing is inferred that the journal cannot prove.
 *
 * Note: `fleet-view.ts` hosts the older M6 view-model surface
 * (`buildFleetView`/`FleetViewData`); this file is the live-screen
 * renderer wired to the daemon's `query-fleet` response.
 */
import type {
  FleetProviderView,
  FleetResponse,
  ParkedTaskView,
  QueuedTaskView,
  RoutingDecisionView,
} from '../../../../core/application/use-cases/tasks/command-api.js';
import type { RenderTree } from './view-types.js';

function el(
  tag: string,
  props?: Record<string, unknown>,
  children?: readonly (RenderTree | string)[],
): RenderTree {
  return { tag, props, children };
}

function pctLabel(usedPct: number): string {
  return `${Math.round(usedPct * 100)}%`;
}

function clockOf(iso: string): string {
  const m = /T(\d{2}:\d{2})/.exec(iso);
  return m !== null ? m[1] : iso;
}

function renderProvider(p: FleetProviderView): RenderTree {
  const chip = p.available
    ? el('Chip', { variant: 'green' }, ['available'])
    : el('Chip', { variant: 'red' }, ['exhausted']);
  const summary = !p.available
    ? `quota dry — resets ${p.exhaustedUntil !== null ? clockOf(p.exhaustedUntil) : 'unknown'}`
    : p.lastObservedAt === null
      ? 'no quota observations yet'
      : `${pctLabel(p.usedPct)} of window used${p.resetsAt !== null ? ` · resets ${clockOf(p.resetsAt)}` : ''}`;
  return el('FleetCard', { provider: p.provider }, [
    el('FleetTop', {}, [el('FleetProvider', {}, [p.provider]), chip]),
    el('FleetSummary', {}, [summary]),
    el('Bar', { pct: Math.round(p.usedPct * 100), dry: !p.available }, []),
  ]);
}

function renderParked(p: ParkedTaskView): RenderTree {
  const resume = p.resumeAt !== null ? `resumes ${clockOf(p.resumeAt)}` : 'resume time unknown';
  return el('FleetRow', {}, [
    el('InspRowTitle', {}, [p.objective]),
    el('InspRowSub', {}, [`${resume} · ${p.reason}`]),
  ]);
}

/**
 * Queued rows (issue #345) are visually distinct from parked ones: the
 * row leads with the lane position and carries the entry's priority as
 * a slate chip. `resumeAt` is journaled quota-reset evidence only — the
 * surface never invents an ETA.
 */
function renderQueued(q: QueuedTaskView): RenderTree {
  const resume = q.resumeAt !== null ? ` · resumes ${clockOf(q.resumeAt)}` : '';
  return el('FleetRow', {}, [
    el('InspRowTitle', {}, [`#${q.position} ${q.objective}`]),
    el('Chip', { variant: 'slate' }, [q.priority]),
    el('InspRowSub', {}, [`${q.provider} · ${q.waitReason}${resume}`]),
  ]);
}

function renderDecision(d: RoutingDecisionView): RenderTree {
  return el('FleetRow', {}, [
    el('InspRowTitle', {}, [d.summary]),
    el('InspRowSub', {}, [clockOf(d.timestamp)]),
  ]);
}

/** Build the fleet/quota screen tree from a `query-fleet` response. */
export function renderFleetScreen(fleet: FleetResponse): RenderTree {
  const children: RenderTree[] = [];

  children.push(
    el('SectionHeader', { label: 'Providers' }, [
      el('SectionCount', {}, [String(fleet.providers.length)]),
    ]),
  );
  if (fleet.providers.length === 0) {
    children.push(el('EmptyState', {}, [el('EmptyHint', {}, ['no providers registered'])]));
  } else {
    children.push(...fleet.providers.map(renderProvider));
  }

  if (fleet.parked.length > 0) {
    children.push(
      el('SectionHeader', { label: 'Parked' }, [
        el('SectionCount', {}, [String(fleet.parked.length)]),
      ]),
    );
    children.push(...fleet.parked.map(renderParked));
  }

  // The queue section is always rendered (issue #345): "a queue you
  // can't see reads as lost work" — an honest empty state still answers
  // "where is my task" better than an absent section. `?? []` keeps the
  // renderer honest against a daemon that predates the field.
  const queue = fleet.queue ?? [];
  children.push(
    el('SectionHeader', { label: 'Queue' }, [el('SectionCount', {}, [String(queue.length)])]),
  );
  if (queue.length === 0) {
    children.push(el('EmptyState', {}, [el('EmptyHint', {}, ['no queued tasks'])]));
  } else {
    children.push(...queue.map(renderQueued));
  }

  children.push(
    el('SectionHeader', { label: 'Recent routing decisions' }, [
      el('SectionCount', {}, [String(fleet.routingDecisions.length)]),
    ]),
  );
  if (fleet.routingDecisions.length === 0) {
    children.push(
      el('EmptyState', {}, [
        el('EmptyHint', {}, ['no routing decisions journaled in the last 24h']),
      ]),
    );
  } else {
    children.push(...fleet.routingDecisions.map(renderDecision));
  }

  return el('FleetView', {}, children);
}
