/**
 * Session inspector view tests (issue #126): the three-column drill-down
 * over journaled events — task list, event timeline, detail pane — with
 * condensed-range rows and D/E-tier verified-only filtering.
 */
import { describe, it, expect } from 'vitest';

import { renderInspectorView } from '../src/adapters/inbound/desktop/views/inspector-view.js';
import type { RenderTree } from '../src/adapters/inbound/desktop/views/view-types.js';
import type { Event } from '../src/core/domain/types.js';
import type { TaskSnapshot } from '../src/core/application/use-cases/tasks/command-api.js';

function task(partial: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    id: 'task_1',
    projectId: 'p1',
    objective: 'do the thing',
    state: 'running',
    agentIds: ['codex'],
    sessionIds: ['s1'],
    createdAt: '2026-01-01T09:00:00Z',
    updatedAt: '2026-01-01T09:30:00Z',
    eventCount: 2,
    ...partial,
  };
}

function event(partial: Partial<Event> = {}): Event {
  return {
    id: 'e1',
    sessionId: 's1',
    taskId: 'task_1',
    timestamp: '2026-01-01T10:00:00Z',
    kind: 'AgentStarted',
    payload: { agentId: 'codex' },
    ...partial,
  };
}

function findAll(tree: RenderTree, tag: string): RenderTree[] {
  const out: RenderTree[] = [];
  const walk = (n: RenderTree | string): void => {
    if (typeof n === 'string') return;
    if (n.tag === tag) out.push(n);
    for (const c of n.children ?? []) walk(c);
  };
  walk(tree);
  return out;
}

describe('renderInspectorView', () => {
  it('renders the three columns', () => {
    const tree = renderInspectorView({
      tasks: [task()],
      selectedTaskId: 'task_1',
      events: [event()],
      selectedEventIndex: 0,
    });
    expect(tree.tag).toBe('Inspector');
    const cols = findAll(tree, 'InspectorCol');
    expect(cols).toHaveLength(3);
    expect(cols[0].props?.['title']).toBe('Tasks');
    expect(cols[1].props?.['title']).toBe('Event timeline');
    expect(String(cols[2].props?.['title'])).toContain('AgentStarted');
  });

  it('task rows carry inspect-task commands and selection state', () => {
    const tree = renderInspectorView({
      tasks: [task(), task({ id: 'task_2', objective: 'other' })],
      selectedTaskId: 'task_2',
      events: [],
      selectedEventIndex: null,
    });
    const rows = findAll(tree, 'InspRow').filter((r) =>
      String(r.props?.['command'] ?? '').startsWith('inspect-task:'),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].props?.['command']).toBe('inspect-task:task_1');
    expect(rows[0].props?.['selected']).toBe(false);
    expect(rows[1].props?.['selected']).toBe(true);
  });

  it('timeline rows carry inspect-event commands indexed by journal position', () => {
    const tree = renderInspectorView({
      tasks: [task()],
      selectedTaskId: 'task_1',
      events: [event(), event({ id: 'e2', kind: 'ToolFinished', payload: { toolName: 'bash' } })],
      selectedEventIndex: 1,
    });
    const rows = findAll(tree, 'InspRow').filter((r) =>
      String(r.props?.['command'] ?? '').startsWith('inspect-event:'),
    );
    expect(rows.map((r) => r.props?.['command'])).toEqual(['inspect-event:0', 'inspect-event:1']);
    expect(rows[1].props?.['selected']).toBe(true);
  });

  it('renders ContextCondensed as one expandable row counting forgotten events', () => {
    const tree = renderInspectorView({
      tasks: [task()],
      selectedTaskId: 'task_1',
      events: [
        event(),
        event({
          id: 'e2',
          kind: 'ContextCondensed',
          payload: { forgottenEventIds: ['e0', 'ea', 'eb'] },
        }),
      ],
      selectedEventIndex: null,
    });
    const rows = findAll(tree, 'InspRow');
    const condensed = rows.find((r) =>
      findAll(r, 'InspRowTitle').some((t) =>
        String(t.children?.[0] ?? '').includes('3 events condensed'),
      ),
    );
    expect(condensed).toBeDefined();
    expect(condensed?.props?.['muted']).toBe(true);
    expect(condensed?.props?.['command']).toBe('inspect-event:1');
  });

  it('detail pane renders the selected event payload verbatim', () => {
    const tree = renderInspectorView({
      tasks: [task()],
      selectedTaskId: 'task_1',
      events: [event({ kind: 'ToolFinished', payload: { toolName: 'bash', exitCode: 0 } })],
      selectedEventIndex: 0,
    });
    const mono = findAll(tree, 'DetailMono');
    expect(mono).toHaveLength(1);
    const text = String(mono[0].children?.[0] ?? '');
    expect(text).toContain('ToolFinished');
    expect(text).toContain('toolName: bash');
    expect(text).toContain('observed · from event journal');
  });

  it('shows an empty detail prompt when no event is selected', () => {
    const tree = renderInspectorView({
      tasks: [task()],
      selectedTaskId: 'task_1',
      events: [event()],
      selectedEventIndex: null,
    });
    expect(findAll(tree, 'DetailMono')).toHaveLength(0);
  });

  it('tier D filters to terminal/verification events and shows a notice', () => {
    const tree = renderInspectorView({
      tasks: [task()],
      selectedTaskId: 'task_1',
      fidelityTier: 'D',
      events: [
        event({ id: 'e1', kind: 'ToolStarted' }),
        event({ id: 'e2', kind: 'AgentProgress' }),
        event({ id: 'e3', kind: 'AgentCompleted' }),
      ],
      selectedEventIndex: 2,
    });
    const titles = findAll(tree, 'InspRowTitle').map((t) => String(t.children?.[0]));
    expect(titles).not.toContain('ToolStarted');
    expect(titles).not.toContain('AgentProgress');
    expect(titles).toContain('AgentCompleted');
    expect(findAll(tree, 'FidelityNotice')).toHaveLength(1);
  });

  it('tier A shows the full timeline without a fidelity notice', () => {
    const tree = renderInspectorView({
      tasks: [task()],
      selectedTaskId: 'task_1',
      fidelityTier: 'A',
      events: [
        event({ id: 'e1', kind: 'ToolStarted' }),
        event({ id: 'e2', kind: 'AgentCompleted' }),
      ],
      selectedEventIndex: null,
    });
    const titles = findAll(tree, 'InspRowTitle').map((t) => String(t.children?.[0]));
    expect(titles).toContain('ToolStarted');
    expect(titles).toContain('AgentCompleted');
    expect(findAll(tree, 'FidelityNotice')).toHaveLength(0);
  });

  it('prompts to select a task when none is open', () => {
    const tree = renderInspectorView({
      tasks: [task()],
      selectedTaskId: null,
      events: [],
      selectedEventIndex: null,
    });
    const subs = findAll(tree, 'InspRowSub').map((t) => String(t.children?.[0]));
    expect(subs).toContain('select a task');
  });

  it('emits a JSON-serializable tree', () => {
    const tree = renderInspectorView({
      tasks: [task()],
      selectedTaskId: 'task_1',
      events: [event()],
      selectedEventIndex: 0,
    });
    expect(() => JSON.stringify(tree)).not.toThrow();
  });
});
