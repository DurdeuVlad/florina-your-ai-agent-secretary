import { describe, it, expect } from 'vitest';
import { classifyRepeatedObservations } from '../src/core/application/use-cases/memory/rule-learning.js';
import { compileExecutionBrief } from '../src/core/application/use-cases/memory/execution-brief.js';
import type { RuleObservation } from '../src/core/application/use-cases/memory/rule-learning.js';

function obs(turnId: string, overrides: Partial<RuleObservation> = {}): RuleObservation {
  return {
    turnId,
    statement: 'Research prior art before large architecture decisions.',
    kind: 'rule',
    scope: { type: 'global' },
    tags: ['research-first'],
    ...overrides,
  };
}

describe('classifyRepeatedObservations', () => {
  it('a single observation produces a candidate, inferred-single item', () => {
    const item = classifyRepeatedObservations([obs('turn-1')], 'mem-1', '2026-09-21T00:00:00.000Z');
    expect(item.provenance).toBe('inferred-single');
    expect(item.status).toBe('candidate');
    expect(item.sourceTurnIds).toEqual(['turn-1']);
  });

  it('two observations in the same turn still count as one distinct turn (candidate)', () => {
    const item = classifyRepeatedObservations(
      [obs('turn-1'), obs('turn-1')],
      'mem-1',
      '2026-09-21T00:00:00.000Z',
    );
    expect(item.provenance).toBe('inferred-single');
    expect(item.status).toBe('candidate');
  });

  it('two observations across distinct turns promote to proposed, inferred-repeated, with both turns linked', () => {
    const item = classifyRepeatedObservations(
      [obs('turn-1'), obs('turn-5')],
      'mem-1',
      '2026-09-21T00:00:00.000Z',
    );
    expect(item.provenance).toBe('inferred-repeated');
    expect(item.status).toBe('proposed');
    expect(item.confidence).toBe('medium');
    expect(item.sourceTurnIds).toEqual(['turn-1', 'turn-5']);
  });

  it('three or more distinct turns still promote (not a hard cap at two)', () => {
    const item = classifyRepeatedObservations(
      [obs('turn-1'), obs('turn-2'), obs('turn-3')],
      'mem-1',
      '2026-09-21T00:00:00.000Z',
    );
    expect(item.status).toBe('proposed');
    expect(item.sourceTurnIds).toEqual(['turn-1', 'turn-2', 'turn-3']);
  });

  it('the latest observation\'s statement/scope/tags represent the item', () => {
    const item = classifyRepeatedObservations(
      [
        obs('turn-1', { statement: 'Look at prior art first.', tags: ['a'] }),
        obs('turn-2', { statement: 'Research prior art before deciding.', tags: ['b'] }),
      ],
      'mem-1',
      '2026-09-21T00:00:00.000Z',
    );
    expect(item.statement).toBe('Research prior art before deciding.');
    expect(item.tags).toEqual(['b']);
  });

  it('throws on an empty observation list', () => {
    expect(() => classifyRepeatedObservations([], 'mem-1', '2026-09-21T00:00:00.000Z')).toThrow();
  });
});

describe('candidate items are never usable by the Execution Brief compiler (integration)', () => {
  it('a single-strike candidate item is excluded even when it tag-matches the request', () => {
    const candidate = classifyRepeatedObservations([obs('turn-1')], 'mem-1', '2026-09-21T00:00:00.000Z');
    const brief = compileExecutionBrief(
      { taskId: 't1', objective: 'x', topics: ['research-first'] },
      [candidate],
    );
    expect(brief.applicableRules).toHaveLength(0);
  });

  it('a proposed (unconfirmed) repeated item is also excluded until it becomes active', () => {
    const proposed = classifyRepeatedObservations(
      [obs('turn-1'), obs('turn-2')],
      'mem-1',
      '2026-09-21T00:00:00.000Z',
    );
    const brief = compileExecutionBrief(
      { taskId: 't1', objective: 'x', topics: ['research-first'] },
      [proposed],
    );
    expect(brief.applicableRules).toHaveLength(0);
  });

  it('confirming (status -> active) makes it usable', () => {
    const proposed = classifyRepeatedObservations(
      [obs('turn-1'), obs('turn-2')],
      'mem-1',
      '2026-09-21T00:00:00.000Z',
    );
    const confirmed = { ...proposed, status: 'active' as const };
    const brief = compileExecutionBrief(
      { taskId: 't1', objective: 'x', topics: ['research-first'] },
      [confirmed],
    );
    expect(brief.applicableRules.map((r) => r.id)).toEqual(['mem-1']);
  });
});
