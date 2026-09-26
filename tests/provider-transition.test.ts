import { describe, it, expect } from 'vitest';
import {
  providerTransitionText,
  renderProviderTransitionRow,
  currentProvider,
  priorProviders,
} from '../src/adapters/inbound/desktop/views/provider-transition.js';
import { renderInspectorView } from '../src/adapters/inbound/desktop/views/inspector-view.js';
import { renderTaskRow } from '../src/adapters/inbound/desktop/views/home-view.js';
import type { TaskSnapshot } from '../src/core/application/use-cases/tasks/command-api.js';
import type { Event } from '../src/core/domain/types.js';

describe('providerTransitionText', () => {
  it('matches flow F\'s worked example shape', () => {
    const text = providerTransitionText(
      { fromProvider: 'codex', toProvider: 'claude-code', reason: 'quota_exhausted' },
      '14:32:00',
    );
    expect(text).toBe('moved from codex to claude-code, quota, 14:32:00');
  });

  it('renders every reason label', () => {
    expect(
      providerTransitionText({ fromProvider: 'a', toProvider: 'b', reason: 'manual' }, 't'),
    ).toContain('manual override');
    expect(
      providerTransitionText({ fromProvider: 'a', toProvider: 'b', reason: 'error' }, 't'),
    ).toContain('error');
    expect(
      providerTransitionText({ fromProvider: 'a', toProvider: 'b', reason: 'preference' }, 't'),
    ).toContain('preference');
  });
});

describe('renderProviderTransitionRow', () => {
  it('renders a distinct provider-transition variant, not a generic row', () => {
    const row = renderProviderTransitionRow(
      { fromProvider: 'codex', toProvider: 'claude-code', reason: 'quota_exhausted' },
      '14:32:00',
    );
    expect(row.props?.['variant']).toBe('provider-transition');
  });
});

describe('currentProvider / priorProviders', () => {
  it('current provider is the most recently appended agent id', () => {
    expect(currentProvider(['codex', 'claude-code'])).toBe('claude-code');
    expect(currentProvider(['codex'])).toBe('codex');
    expect(currentProvider([])).toBe('');
  });

  it('prior providers are everything before the current one, oldest first', () => {
    expect(priorProviders(['codex', 'claude-code', 'gemini'])).toEqual(['codex', 'claude-code']);
    expect(priorProviders(['codex'])).toEqual([]);
  });
});

describe('inspector timeline: provider transition row (issue #202)', () => {
  function failoverEvent(): Event {
    return {
      id: 'e1',
      taskId: 'task-1',
      sessionId: 'sess-1',
      timestamp: '2026-09-21T14:32:00.000Z',
      kind: 'TaskFailedOver',
      payload: { fromProvider: 'codex', toProvider: 'claude-code', reason: 'quota_exhausted' },
    };
  }

  it('renders a distinct row, not folded into a generic timeline row', () => {
    const tree = renderInspectorView({
      tasks: [],
      selectedTaskId: 'task-1',
      events: [failoverEvent()],
      selectedEventIndex: null,
    });
    const timelineCol = tree.children?.[1];
    const row = typeof timelineCol === 'string' ? undefined : timelineCol?.children?.[0];
    expect(typeof row === 'string' ? undefined : row?.props?.['variant']).toBe('provider-transition');
  });

  it('stays visible even at D/E fidelity tier (a structural fact, not raw chatter)', () => {
    const tree = renderInspectorView({
      tasks: [],
      selectedTaskId: 'task-1',
      events: [failoverEvent()],
      selectedEventIndex: null,
      fidelityTier: 'D',
    });
    const timelineCol = tree.children?.[1];
    const row = typeof timelineCol === 'string' ? undefined : timelineCol?.children?.[0];
    expect(typeof row === 'string' ? undefined : row?.props?.['variant']).toBe('provider-transition');
  });

  it('existing tasks without any transition render unaffected (no regression)', () => {
    const normalEvent: Event = {
      id: 'e2',
      taskId: 'task-1',
      sessionId: 'sess-1',
      timestamp: '2026-09-21T00:00:00.000Z',
      kind: 'AgentStarted',
      payload: { objective: 'x', workingDir: '/repo' },
    };
    const tree = renderInspectorView({
      tasks: [],
      selectedTaskId: 'task-1',
      events: [normalEvent],
      selectedEventIndex: null,
    });
    const timelineCol = tree.children?.[1];
    const row = typeof timelineCol === 'string' ? undefined : timelineCol?.children?.[0];
    expect(typeof row === 'string' ? undefined : row?.props?.['variant']).toBeUndefined();
  });
});

describe('current-provider bug fix (issue #202): task rows show the CURRENT provider, not the original', () => {
  function task(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
    return {
      id: 'task-1',
      projectId: 'proj-1',
      objective: 'do the thing',
      state: 'running',
      agentIds: ['codex'],
      sessionIds: [],
      createdAt: '2026-09-21T00:00:00.000Z',
      updatedAt: '2026-09-21T00:00:00.000Z',
      eventCount: 0,
      ...overrides,
    };
  }

  it('home-view renderTaskRow shows the most recent provider after a failover', () => {
    const row = renderTaskRow(task({ agentIds: ['codex', 'claude-code'] }));
    const chip = (row.children ?? []).find((c) => typeof c !== 'string' && c.tag === 'ProviderChip');
    expect(typeof chip === 'string' ? undefined : chip?.children?.[0]).toBe('claude-code');
  });

  it('a task that never failed over still shows its single provider', () => {
    const row = renderTaskRow(task({ agentIds: ['codex'] }));
    const chip = (row.children ?? []).find((c) => typeof c !== 'string' && c.tag === 'ProviderChip');
    expect(typeof chip === 'string' ? undefined : chip?.children?.[0]).toBe('codex');
  });
});
