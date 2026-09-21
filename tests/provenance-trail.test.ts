import { describe, it, expect } from 'vitest';
import {
  buildProvenanceTrail,
  summarizeEvidence,
  renderProveItAffordance,
} from '../src/adapters/inbound/desktop/views/provenance-trail.js';
import type { Event } from '../src/core/domain/types.js';
import { renderTaskRow } from '../src/adapters/inbound/desktop/views/home-view.js';
import type { TaskSnapshot } from '../src/core/application/use-cases/tasks/command-api.js';

function event(overrides: Partial<Event> & Pick<Event, 'kind'>): Event {
  return {
    id: 'event-1',
    sessionId: 'sess-1',
    taskId: 'task-1',
    timestamp: '2026-09-21T00:00:00.000Z',
    payload: {},
    ...overrides,
  };
}

describe('summarizeEvidence', () => {
  it('summarizes TestFinished', () => {
    expect(summarizeEvidence(event({ kind: 'TestFinished', payload: { passed: 31, failed: 0 } }))).toBe(
      '31 passed, 0 failed',
    );
  });

  it('summarizes VerificationObserved', () => {
    expect(
      summarizeEvidence(
        event({
          kind: 'VerificationObserved',
          payload: { kind: 'typecheck', success: true, summary: 'no errors' },
        }),
      ),
    ).toBe('typecheck: passed — no errors');
  });

  it('summarizes AgentCompleted', () => {
    expect(summarizeEvidence(event({ kind: 'AgentCompleted', payload: { summary: 'done' } }))).toBe('done');
  });

  it('summarizes FileChanged', () => {
    expect(
      summarizeEvidence(event({ kind: 'FileChanged', payload: { path: 'src/a.ts', changeType: 'modified' } })),
    ).toBe('modified: src/a.ts');
  });

  it('falls back to the raw kind for an unmapped event type', () => {
    expect(summarizeEvidence(event({ kind: 'AgentStarted' }))).toBe('AgentStarted');
  });
});

describe('buildProvenanceTrail', () => {
  it('renders claim -> event -> fact for each piece of evidence, then a transcript step', () => {
    const trail = buildProvenanceTrail(
      { text: '31/31 tests pass', taskId: 'task-1' },
      [event({ kind: 'TestFinished', payload: { passed: 31, failed: 0 } })],
    );

    expect(trail.tag).toBe('ProvenanceTrail');
    expect(trail.props?.['taskId']).toBe('task-1');
    const kinds = (trail.children ?? []).map((c) => (typeof c === 'string' ? null : c.props?.['kind']));
    expect(kinds).toEqual(['claim', 'event', 'fact', 'transcript']);
  });

  it('renders one event/fact pair per piece of evidence, in order', () => {
    const trail = buildProvenanceTrail(
      { text: 'implementation complete', taskId: 'task-1' },
      [
        event({ id: 'e1', kind: 'TestFinished', payload: { passed: 5, failed: 0 } }),
        event({ id: 'e2', kind: 'AgentCompleted', payload: { summary: 'shipped' } }),
      ],
    );
    const kinds = (trail.children ?? []).map((c) => (typeof c === 'string' ? null : c.props?.['kind']));
    expect(kinds).toEqual(['claim', 'event', 'fact', 'event', 'fact', 'transcript']);
  });

  it('renders an explicit "no evidence" step when nothing backs the claim, not a fabricated one', () => {
    const trail = buildProvenanceTrail({ text: 'root cause identified', taskId: 'task-1' }, []);
    const kinds = (trail.children ?? []).map((c) => (typeof c === 'string' ? null : c.props?.['kind']));
    expect(kinds).toEqual(['claim', 'unverified']);
  });

  it('the transcript step carries a command scoped to the claim\'s task', () => {
    const trail = buildProvenanceTrail(
      { text: 'x', taskId: 'task-42' },
      [event({ kind: 'TestFinished', payload: { passed: 1, failed: 0 } })],
    );
    const last = (trail.children ?? [])[(trail.children?.length ?? 1) - 1];
    expect(typeof last === 'string' ? undefined : last?.props?.['command']).toBe('show-raw-events:task-42');
  });
});

describe('renderProveItAffordance', () => {
  it('carries a task-scoped command', () => {
    const node = renderProveItAffordance('task-7');
    expect(node.props?.['command']).toBe('prove-it:task-7');
  });
});

describe('renderTaskRow — Prove it wiring (issue #201)', () => {
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

  it('a completed task row carries a Prove it affordance', () => {
    const row = renderTaskRow(task({ state: 'completed' }));
    const proveIt = (row.children ?? []).find((c) => typeof c !== 'string' && c.tag === 'ProveIt');
    expect(proveIt).toBeDefined();
  });

  it('a still-running task row does not — nothing to prove yet', () => {
    const row = renderTaskRow(task({ state: 'running' }));
    const proveIt = (row.children ?? []).find((c) => typeof c !== 'string' && c.tag === 'ProveIt');
    expect(proveIt).toBeUndefined();
  });
});
