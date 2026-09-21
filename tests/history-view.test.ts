import { describe, it, expect } from 'vitest';
import { renderHistoryView } from '../src/adapters/inbound/desktop/views/history-view.js';
import type { HistoryViewInput } from '../src/adapters/inbound/desktop/views/history-view.js';
import type { TaskSnapshot } from '../src/core/application/use-cases/tasks/command-api.js';
import { createAttentionItem } from '../src/core/application/use-cases/attention/attention-item.js';
import type { AttentionItem } from '../src/core/application/use-cases/attention/attention-item.js';

function task(overrides: Partial<TaskSnapshot> & Pick<TaskSnapshot, 'id' | 'state'>): TaskSnapshot {
  return {
    projectId: 'proj-1',
    objective: 'do the thing',
    agentIds: ['codex'],
    sessionIds: [],
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
    eventCount: 0,
    ...overrides,
  };
}

function resolvedItem(taskId: string, overrides: Partial<AttentionItem> = {}): AttentionItem {
  const item = createAttentionItem({ taskId, kind: 'ApprovalRequest', priority: 'High' });
  return { ...item, status: 'Resolved', ...overrides };
}

function flatten(tree: ReturnType<typeof renderHistoryView>): string[] {
  const out: string[] = [];
  function walk(node: typeof tree | string): void {
    if (typeof node === 'string') return;
    out.push(node.tag);
    node.children?.forEach(walk);
  }
  walk(tree);
  return out;
}

describe('renderHistoryView', () => {
  it('shows an explicit empty state when nothing is completed or resolved', () => {
    const tree = renderHistoryView({ tasks: [], resolvedItems: [] });
    expect(flatten(tree)).toContain('EmptyState');
  });

  it('lists completed tasks most-recent-first, excluding non-done states', () => {
    const input: HistoryViewInput = {
      tasks: [
        task({ id: 't-old', state: 'completed', updatedAt: '2026-09-19T00:00:00.000Z' }),
        task({ id: 't-new', state: 'completed', updatedAt: '2026-09-20T00:00:00.000Z' }),
        task({ id: 't-running', state: 'running', updatedAt: '2026-09-21T00:00:00.000Z' }),
      ],
      resolvedItems: [],
    };
    const tree = renderHistoryView(input);
    const rows = (tree.children ?? [])
      .flatMap((c) => (typeof c === 'string' ? [] : (c.children ?? [])))
      .filter((c) => typeof c !== 'string' && c.tag === 'TaskRow');
    const ids = rows.map((r) => (typeof r === 'string' ? undefined : r.props?.['taskId']));
    expect(ids).toEqual(['t-new', 't-old']);
  });

  it('includes reviewed/accepted states as done, not just completed', () => {
    const input: HistoryViewInput = {
      tasks: [
        task({ id: 't1', state: 'reviewed' }),
        task({ id: 't2', state: 'accepted' }),
      ],
      resolvedItems: [],
    };
    const tree = renderHistoryView(input);
    expect(flatten(tree)).toContain('TaskRow');
  });

  it('lists resolved decisions most-recent-first, excluding non-resolved statuses', () => {
    const older = resolvedItem('t1', { createdAt: '2026-09-19T00:00:00.000Z' });
    const newer = resolvedItem('t2', { createdAt: '2026-09-20T00:00:00.000Z' });
    const pending = createAttentionItem({ taskId: 't3', kind: 'ApprovalRequest', priority: 'High' }); // status: Pending
    const tree = renderHistoryView({ tasks: [], resolvedItems: [older, newer, pending] });
    const rows = (tree.children ?? [])
      .flatMap((c) => (typeof c === 'string' ? [] : (c.children ?? [])))
      .filter((c) => typeof c !== 'string' && c.tag === 'HistoryDecisionRow');
    const ids = rows.map((r) => (typeof r === 'string' ? undefined : r.props?.['taskId']));
    expect(ids).toEqual(['t2', 't1']);
  });

  it('filters both lists by project when projectFilter is set', () => {
    const input: HistoryViewInput = {
      tasks: [
        task({ id: 't-a', state: 'completed', projectId: 'proj-a' }),
        task({ id: 't-b', state: 'completed', projectId: 'proj-b' }),
      ],
      resolvedItems: [resolvedItem('t-a'), resolvedItem('t-b')],
      projectFilter: 'proj-a',
    };
    const tree = renderHistoryView(input);
    const taskRows = (tree.children ?? [])
      .flatMap((c) => (typeof c === 'string' ? [] : (c.children ?? [])))
      .filter((c) => typeof c !== 'string' && c.tag === 'TaskRow');
    const decisionRows = (tree.children ?? [])
      .flatMap((c) => (typeof c === 'string' ? [] : (c.children ?? [])))
      .filter((c) => typeof c !== 'string' && c.tag === 'HistoryDecisionRow');
    expect(taskRows).toHaveLength(1);
    expect(decisionRows).toHaveLength(1);
    expect(typeof taskRows[0] === 'string' ? undefined : taskRows[0]?.props?.['taskId']).toBe('t-a');
  });

  it('a resolved decision for a task outside the filtered project is excluded even if the task itself is not done', () => {
    const input: HistoryViewInput = {
      tasks: [
        task({ id: 't-a', state: 'running', projectId: 'proj-a' }),
        task({ id: 't-b', state: 'running', projectId: 'proj-b' }),
      ],
      resolvedItems: [resolvedItem('t-a'), resolvedItem('t-b')],
      projectFilter: 'proj-a',
    };
    const tree = renderHistoryView(input);
    const decisionRows = (tree.children ?? [])
      .flatMap((c) => (typeof c === 'string' ? [] : (c.children ?? [])))
      .filter((c) => typeof c !== 'string' && c.tag === 'HistoryDecisionRow');
    expect(decisionRows).toHaveLength(1);
    expect(typeof decisionRows[0] === 'string' ? undefined : decisionRows[0]?.props?.['taskId']).toBe('t-a');
  });
});
