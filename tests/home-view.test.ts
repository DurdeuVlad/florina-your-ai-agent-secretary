/**
 * Home view (issue #120): NEEDS YOU / WORKING / DONE composition from
 * attention items + task snapshots — the mockup's home screen as a
 * serializable RenderTree.
 */
import { describe, it, expect } from 'vitest';

import { renderHomeView } from '../src/adapters/inbound/desktop/views/home-view.js';
import type { AttentionItem } from '../src/core/application/use-cases/attention/attention-item.js';
import type { TaskSnapshot } from '../src/core/application/use-cases/tasks/command-api.js';

function item(partial: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: 'attn_1',
    taskId: 'task_1',
    kind: 'ApprovalRequest',
    priority: 'High',
    createdAt: '2026-09-16T10:00:00Z',
    payload: {},
    status: 'Pending',
    ...partial,
  };
}

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

function sectionLabels(tree: ReturnType<typeof renderHomeView>): string[] {
  return (tree.children ?? [])
    .filter((c): c is Exclude<typeof c, string> => typeof c === 'object')
    .filter((c) => c.tag === 'SectionHeader')
    .map((c) => String(c.props?.['label']));
}

describe('renderHomeView', () => {
  it('renders NEEDS YOU / WORKING sections with counts', () => {
    const tree = renderHomeView(
      [item(), item({ id: 'attn_2', priority: 'Critical' })],
      [task(), task({ id: 'task_2', state: 'completed' })],
    );
    expect(tree.tag).toBe('HomeView');
    expect(tree.props?.['needsYou']).toBe(2);
    expect(tree.props?.['working']).toBe(1);
    expect(sectionLabels(tree)).toEqual(['Needs you', 'Working', 'Done']);
  });

  it('renders the calm empty state when nothing is pending', () => {
    const tree = renderHomeView([], [task()]);
    const json = JSON.stringify(tree);
    expect(json).toContain('Nothing needs you right now');
    expect(sectionLabels(tree)).toEqual(['Needs you', 'Working']);
  });

  it('omits DONE when nothing completed and keeps WORKING rows', () => {
    const tree = renderHomeView([item()], [task({ state: 'delegated' })]);
    expect(sectionLabels(tree)).toEqual(['Needs you', 'Working']);
    expect(JSON.stringify(tree)).toContain('inspect-task:task_1');
  });

  it('excludes non-pending items from NEEDS YOU', () => {
    const tree = renderHomeView([item({ status: 'Resolved' })], []);
    expect(tree.props?.['needsYou']).toBe(0);
    expect(JSON.stringify(tree)).toContain('Nothing needs you right now');
  });

  it('approval items carry string command identifiers', () => {
    const tree = renderHomeView([item()], []);
    const json = JSON.stringify(tree);
    expect(json).toContain('approve:attn_1');
    expect(json).toContain('deny:attn_1');
  });
});
