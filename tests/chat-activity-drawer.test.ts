/**
 * Chat activity/diff drawer (issue #181): a live task list beside the
 * Chat transcript, reusing the same task-row shape as Fleet/Tasks.
 */
import { describe, it, expect } from 'vitest';

import { renderChatActivityDrawer } from '../src/adapters/inbound/desktop/views/chat-activity-drawer.js';
import type { RenderTree } from '../src/adapters/inbound/desktop/views/view-types.js';
import type { TaskSnapshot } from '../src/core/application/use-cases/tasks/command-api.js';

function task(partial: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    id: 'task_1',
    projectId: 'p1',
    objective: 'do the thing',
    state: 'running',
    agentIds: ['codex'],
    sessionIds: [],
    createdAt: '2026-09-16T09:00:00Z',
    updatedAt: '2026-09-16T10:00:00Z',
    eventCount: 3,
    ...partial,
  };
}

function findAll(tree: RenderTree, tag: string): RenderTree[] {
  const out: RenderTree[] = [];
  const walk = (node: RenderTree | string): void => {
    if (typeof node === 'string') return;
    if (node.tag === tag) out.push(node);
    for (const c of node.children ?? []) walk(c);
  };
  walk(tree);
  return out;
}

describe('chat activity drawer', () => {
  it('renders the calm empty state when nothing is active', () => {
    const tree = renderChatActivityDrawer([]);
    expect(tree.tag).toBe('EmptyState');
    expect(findAll(tree, 'EmptyHint')[0]!.children?.[0]).toContain('no active tasks');
  });

  it('excludes completed/reviewed/accepted tasks from the live list', () => {
    const tree = renderChatActivityDrawer([task({ id: 't1', state: 'completed' })]);
    expect(tree.tag).toBe('EmptyState');
  });

  it('renders one TaskRow per active task, reusing the shared row shape', () => {
    const tree = renderChatActivityDrawer([
      task({ id: 't1', objective: 'fix login', state: 'running', agentIds: ['claude-code'] }),
      task({ id: 't2', objective: 'add cursor pagination', state: 'blocked', agentIds: ['codex'] }),
    ]);
    const rows = findAll(tree, 'TaskRow');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.props?.['taskId']).toBe('t1');
    expect(findAll(tree, 'ProviderChip')[0]!.children?.[0]).toBe('claude-code');
    expect(findAll(tree, 'StatusWord')[1]!.children?.[0]).toBe('blocked');
  });

  it('orders active tasks newest-updated-first', () => {
    const tree = renderChatActivityDrawer([
      task({ id: 'old', updatedAt: '2026-09-16T09:00:00Z' }),
      task({ id: 'new', updatedAt: '2026-09-16T11:00:00Z' }),
    ]);
    const rows = findAll(tree, 'TaskRow');
    expect(rows.map((r) => r.props?.['taskId'])).toEqual(['new', 'old']);
  });
});
