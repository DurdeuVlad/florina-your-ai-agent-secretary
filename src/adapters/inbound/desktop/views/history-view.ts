/**
 * History view (issue #199/#221, docs/UX_INFORMATION_ARCHITECTURE.md §2).
 *
 * A dedicated place for "what already happened" — completed Tasks and
 * resolved AttentionItems (decisions/approvals) — split out from
 * Attention/Work because done work has different needs (search,
 * evidence review, no pending actions) than active work does
 * (`docs/GAP_ANALYSIS.md` #9). Pure read-composition over existing
 * task/attention data, most-recent-first, optionally filtered by
 * project — no new data model, no DOM, no framework.
 */
import type { TaskSnapshot } from '../../../../core/application/use-cases/tasks/command-api.js';
import type { AttentionItem } from '../../../../core/application/use-cases/attention/attention-item.js';
import type { RenderTree } from './view-types.js';
import { renderTaskRow, DONE_STATES } from './home-view.js';

function el(
  tag: string,
  props?: Record<string, unknown>,
  children?: readonly (RenderTree | string)[],
): RenderTree {
  return { tag, props, children };
}

export interface HistoryViewInput {
  /** All known tasks — filtered to done states (and optionally project) here. */
  readonly tasks: readonly TaskSnapshot[];
  /** All resolved attention items (decisions/approvals) — filtered here too. */
  readonly resolvedItems: readonly AttentionItem[];
  /** Optional project id to narrow both lists to. */
  readonly projectFilter?: string;
}

function renderResolvedItemRow(item: AttentionItem): RenderTree {
  return el('HistoryDecisionRow', { itemId: item.id, taskId: item.taskId, kind: item.kind }, [
    el('HistoryDecisionKind', {}, [item.kind]),
    el('HistoryDecisionMeta', {}, [`task ${item.taskId}`]),
  ]);
}

/** Build the History view: completed tasks + resolved decisions, most-recent-first. */
export function renderHistoryView(input: HistoryViewInput): RenderTree {
  const projectId = input.projectFilter;
  const projectTaskIds =
    projectId !== undefined
      ? new Set(input.tasks.filter((t) => t.projectId === projectId).map((t) => t.id))
      : null;

  const doneTasks = input.tasks
    .filter((t) => DONE_STATES.has(t.state))
    .filter((t) => projectId === undefined || t.projectId === projectId)
    .slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const resolvedItems = input.resolvedItems
    .filter((i) => i.status === 'Resolved')
    .filter((i) => projectTaskIds === null || projectTaskIds.has(i.taskId))
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  if (doneTasks.length === 0 && resolvedItems.length === 0) {
    return el('HistoryView', {}, [
      el('EmptyState', {}, [
        el('EmptyHint', {}, ['nothing completed or resolved yet']),
      ]),
    ]);
  }

  return el('HistoryView', {}, [
    el('HistorySection', { title: 'Completed work' }, [
      ...(doneTasks.length === 0
        ? [el('EmptyHint', {}, ['no completed tasks' + (projectId !== undefined ? ' in this project' : '')])]
        : doneTasks.map((t) => renderTaskRow(t))),
    ]),
    el('HistorySection', { title: 'Resolved decisions' }, [
      ...(resolvedItems.length === 0
        ? [el('EmptyHint', {}, ['no resolved decisions' + (projectId !== undefined ? ' in this project' : '')])]
        : resolvedItems.map((i) => renderResolvedItemRow(i))),
    ]),
  ]);
}
