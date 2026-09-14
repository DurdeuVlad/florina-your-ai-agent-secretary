/**
 * Secretary screen (issue #130, mockup `docs/mockups/secretary.html`).
 *
 * Renders the `query-secretary` response into the mockup's vocabulary:
 *
 *  - **Context health** (first-class per DEC-035): one card per
 *    continuous agent — window-fill bar, status chip, events since
 *    condensation, last condensation time.
 *  - **Plan**: the Secretary's todo items with status marks.
 *  - **In-flight research**: running `research` tool calls.
 *  - **Memory writes**: proposals awaiting confirmation, with
 *    Confirm/Reject wired to `memory-confirm`/`memory-reject`.
 *
 * Every section renders the response verbatim — empty ports surface as
 * honest empty states, never fabricated activity.
 */
import type {
  PendingMemoryWrite,
  SecretaryResearchItem,
  SecretaryResponse,
} from '../../../../core/application/use-cases/tasks/command-api.js';
import type { ContextHealthSnapshot } from '../../../../core/application/use-cases/context/context-health-monitor.js';
import type { TodoItem } from '../../../../core/application/use-cases/florina/todo-tool.js';
import type { RenderTree } from './view-types.js';

function el(
  tag: string,
  props?: Record<string, unknown>,
  children?: readonly (RenderTree | string)[],
): RenderTree {
  return { tag, props, children };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-09-15T09:41:…` → `Sep 15 09:41`. */
function shortDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})/.exec(iso);
  if (m === null) return iso;
  const month = MONTHS[Number.parseInt(m[2]!, 10) - 1];
  if (month === undefined) return iso;
  return `${month} ${Number.parseInt(m[3]!, 10)} ${m[4]}`;
}

const HEALTH_CHIP: Record<string, 'green' | 'amber' | 'red'> = {
  ok: 'green',
  degraded: 'amber',
  critical: 'red',
};

function healthCard(h: ContextHealthSnapshot): RenderTree {
  const pct = Math.round(h.windowFillPct * 100);
  const statusLabel = h.status === 'ok' ? 'healthy' : h.status;
  return el('PrefCard', {}, [
    el('PrefTop', {}, [
      el('PrefKind', {}, [h.agentId]),
      el('Chip', { variant: HEALTH_CHIP[h.status] ?? 'amber' }, [statusLabel]),
    ]),
    el('PrefNote', {}, [
      `${pct}% of context window used · ${h.eventsSinceCondensation} events since condensation`,
    ]),
    el('Bar', { pct, dry: h.status === 'critical', warm: h.status === 'degraded' }, []),
    el('PrefMeta', {}, [
      h.lastCondensationAt !== undefined
        ? `last condensation ${shortDate(h.lastCondensationAt)} · ${h.condensationCount} total`
        : 'no condensation yet',
    ]),
  ]);
}

const TODO_MARK: Record<TodoItem['status'], string> = {
  pending: '○',
  in_progress: '●',
  completed: '✓',
};

function todoRow(item: TodoItem): RenderTree {
  return el('FleetRow', {}, [
    el('InspRowTitle', {}, [`${TODO_MARK[item.status]} ${item.content}`]),
    el('InspRowSub', {}, [item.status.replace('_', ' ')]),
  ]);
}

function researchCard(r: SecretaryResearchItem): RenderTree {
  return el('PrefCard', {}, [
    el('PrefTop', {}, [el('PrefKind', {}, [r.query]), el('Chip', {}, ['running'])]),
    el('PrefMeta', {}, [
      `started ${shortDate(r.startedAt)}${r.ideaId !== undefined ? ` · appends to ${r.ideaId}` : ''}`,
    ]),
  ]);
}

function memoryCard(w: PendingMemoryWrite): RenderTree {
  return el('PrefCard', {}, [
    el('PrefTop', {}, [
      el('PrefKind', {}, [
        w.scope === 'project'
          ? `project memory${w.projectId !== undefined ? `:${w.projectId}` : ''}`
          : 'user-scope memory',
      ]),
      el('Chip', { variant: 'purple' }, ['proposed']),
    ]),
    el('PrefNote', {}, [`"${w.summary}"`]),
    el('PrefMeta', {}, [
      `proposed ${shortDate(w.proposedAt)}${w.source !== undefined ? ` · from ${w.source}` : ''}`,
    ]),
    el('PrefActions', {}, [
      el('Button', { command: `memwrite:confirm:${w.id}` }, ['Confirm']),
      el('Button', { variant: 'danger', command: `memwrite:reject:${w.id}` }, ['Reject']),
    ]),
  ]);
}

/** Build the Secretary screen tree from a `query-secretary` response. */
export function renderSecretaryScreen(res: SecretaryResponse): RenderTree {
  const children: RenderTree[] = [];

  children.push(
    el('SectionHeader', { label: 'Context health' }, [
      el('SectionCount', {}, [String(res.health.length)]),
    ]),
  );
  if (res.health.length === 0) {
    children.push(
      el('EmptyState', {}, [
        el('EmptyHint', {}, ['no continuous agents reporting context health yet']),
      ]),
    );
  } else {
    children.push(...res.health.map(healthCard));
  }

  children.push(
    el('SectionHeader', { label: 'Plan' }, [el('SectionCount', {}, [String(res.plan.length)])]),
  );
  if (res.plan.length === 0) {
    children.push(
      el('EmptyState', {}, [
        el('EmptyHint', {}, ['no plan items — the Secretary maintains one while her loop runs']),
      ]),
    );
  } else {
    children.push(...res.plan.map(todoRow));
  }

  children.push(
    el('SectionHeader', { label: 'In-flight research' }, [
      el('SectionCount', {}, [String(res.research.length)]),
    ]),
  );
  if (res.research.length === 0) {
    children.push(el('EmptyState', {}, [el('EmptyHint', {}, ['no research running'])]));
  } else {
    children.push(...res.research.map(researchCard));
  }

  children.push(
    el('SectionHeader', { label: 'Memory writes' }, [
      el('SectionCount', {}, [String(res.memoryWrites.length)]),
    ]),
  );
  if (res.memoryWrites.length === 0) {
    children.push(
      el('EmptyState', {}, [el('EmptyHint', {}, ['no memory writes awaiting confirmation'])]),
    );
  } else {
    children.push(...res.memoryWrites.map(memoryCard));
  }

  return el('PrefsView', {}, children);
}
