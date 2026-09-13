/**
 * Home view — the attention inbox as the app's home screen (issue #120,
 * docs/mockups/inbox.html, DG-01 §3.1–3.3).
 *
 * Composes the three home sections from daemon snapshots:
 *   NEEDS YOU — pending attention items (priority-grouped, via the inbox
 *               view model's per-item rendering)
 *   WORKING   — tasks currently delegated/running/parked
 *   DONE      — tasks completed or accepted today
 *
 * Everything stays a {@link RenderTree}: string command identifiers, no
 * closures, JSON-serializable across the IPC boundary.
 */
import type { TaskSnapshot } from '../../../core/application/use-cases/tasks/command-api.js';
import type { AttentionItem } from '../../../core/application/use-cases/attention/attention-item.js';
import type { RenderTree } from './view-types.js';
import { InboxViewModel } from './inbox-view.js';
import { renderInboxItem } from './inbox-templates.js';

function el(
  tag: string,
  props?: Record<string, unknown>,
  children?: readonly (RenderTree | string)[],
): RenderTree {
  return { tag, props, children };
}

const ACTIVE_STATES = new Set(['delegated', 'running', 'blocked', 'attention-needed']);
const DONE_STATES = new Set(['completed', 'reviewed', 'accepted']);

/** Display word for a task row's live status (plain language, DG-01 §3.3). */
function statusWord(task: TaskSnapshot): string {
  switch (task.state) {
    case 'blocked':
      return 'blocked';
    case 'attention-needed':
      return 'needs you';
    case 'delegated':
      return 'delegated';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'running';
  }
}

function renderTaskRow(task: TaskSnapshot): RenderTree {
  const word = statusWord(task);
  const done = DONE_STATES.has(task.state);
  const provider = task.agentIds[0] ?? '';
  return el(
    'TaskRow',
    { taskId: task.id, state: task.state, command: `inspect-task:${task.id}` },
    [
      el('TaskObjective', {}, [task.objective]),
      ...(provider !== '' ? [el('ProviderChip', {}, [provider])] : []),
      el('StatusWord', { done }, [word]),
    ],
  );
}

/**
 * Build the home screen tree: NEEDS YOU / WORKING / DONE sections with
 * live counts. Empty NEEDS YOU renders the calm empty state (DG-01 §4).
 */
export function renderHomeView(
  items: readonly AttentionItem[],
  tasks: readonly TaskSnapshot[],
): RenderTree {
  const vm = new InboxViewModel();
  const pending = items.filter((i) => i.status === 'Pending');
  const working = tasks.filter((t) => ACTIVE_STATES.has(t.state));
  const done = tasks.filter((t) => DONE_STATES.has(t.state));

  const sections: RenderTree[] = [];

  sections.push(
    el('SectionHeader', { label: 'Needs you' }, [el('SectionCount', {}, [String(pending.length)])]),
  );
  if (pending.length === 0) {
    sections.push(
      el('EmptyState', {}, [
        el('EmptyTitle', {}, ['Nothing needs you right now']),
        el('EmptyHint', {}, ['Items will appear here as agents surface attention.']),
      ]),
    );
  } else {
    sections.push(
      el(
        'GroupItems',
        {},
        pending.map((i) => renderInboxItem(vm.toItemView(i))),
      ),
    );
  }

  sections.push(
    el('SectionHeader', { label: 'Working' }, [el('SectionCount', {}, [String(working.length)])]),
  );
  sections.push(el('GroupItems', {}, working.map(renderTaskRow)));

  if (done.length > 0) {
    sections.push(
      el('SectionHeader', { label: 'Done' }, [el('SectionCount', {}, [String(done.length)])]),
    );
    sections.push(el('GroupItems', {}, done.map(renderTaskRow)));
  }

  return el('HomeView', { needsYou: pending.length, working: working.length }, sections);
}
