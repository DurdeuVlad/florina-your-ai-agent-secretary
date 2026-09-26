/**
 * Chat activity/diff drawer (issue #181, docs/mockups/chat.html).
 *
 * A toggleable panel beside the Chat transcript showing the same live
 * task list as Fleet/Tasks (DG-01 §3.3 row shape), reused via
 * {@link renderTaskRow} rather than duplicating it — the drawer is a
 * second view onto data the daemon already streams, not a new query
 * surface. Diff/tool-call detail beyond the task row stays in the
 * Session Inspector (progressive disclosure, DG-01 §0).
 */
import type { TaskSnapshot } from '../../../../core/application/use-cases/tasks/command-api.js';
import type { RenderTree } from './view-types.js';
import { renderTaskRow, ACTIVE_STATES } from './home-view.js';

function el(
  tag: string,
  props?: Record<string, unknown>,
  children?: readonly (RenderTree | string)[],
): RenderTree {
  return { tag, props, children };
}

/** Build the drawer's task list — active tasks only, newest first. */
export function renderChatActivityDrawer(tasks: readonly TaskSnapshot[]): RenderTree {
  const active = tasks
    .filter((t) => ACTIVE_STATES.has(t.state))
    .slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  if (active.length === 0) {
    return el('EmptyState', {}, [el('EmptyHint', {}, ['no active tasks right now'])]);
  }
  return el(
    'ActivityDrawerList',
    {},
    active.map((t) => renderTaskRow(t)),
  );
}
