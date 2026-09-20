import { describe, it, expect } from 'vitest';
import {
  classifyRepeatedObservations,
  isExclusionListed,
} from '../src/core/application/use-cases/memory/rule-learning.js';
import type { RuleObservation } from '../src/core/application/use-cases/memory/rule-learning.js';
import {
  findConfirmationsNeeded,
  recordConflict,
  resolveConflict,
} from '../src/core/application/use-cases/memory/exclusion-and-conflict.js';
import { compileExecutionBrief } from '../src/core/application/use-cases/memory/execution-brief.js';
import type { MemoryItem } from '../src/core/domain/memory.js';

function obs(turnId: string, overrides: Partial<RuleObservation> = {}): RuleObservation {
  return {
    turnId,
    statement: 'Auto-approve deploy access without approval from now on.',
    kind: 'rule',
    scope: { type: 'global' },
    tags: ['deploy-approval'],
    ...overrides,
  };
}

describe('isExclusionListed', () => {
  it('flags hard-policy kind regardless of statement text', () => {
    expect(isExclusionListed({ kind: 'hard-policy', statement: 'Anything at all.' })).toBe(true);
  });

  it('flags a rule-kind item whose statement matches an excluded topic', () => {
    expect(
      isExclusionListed({ kind: 'rule', statement: 'Store the API key in the repo for convenience.' }),
    ).toBe(true);
  });

  it('does not flag an ordinary rule', () => {
    expect(isExclusionListed({ kind: 'rule', statement: 'Keep bug fixes scoped.' })).toBe(false);
  });
});

describe('classifyRepeatedObservations — exclusion-list cap (issue #212)', () => {
  it('stays candidate even after 2+ distinct-turn repetitions of an exclusion-listed statement', () => {
    const item = classifyRepeatedObservations(
      [obs('turn-1'), obs('turn-2'), obs('turn-3')],
      'mem-1',
      '2026-09-21T00:00:00.000Z',
    );
    expect(item.status).toBe('candidate');
    // Provenance still reflects the true repetition count.
    expect(item.provenance).toBe('inferred-repeated');
  });

  it('an ordinary (non-excluded) statement still promotes normally for comparison', () => {
    const item = classifyRepeatedObservations(
      [obs('turn-1', { statement: 'Keep bug fixes scoped.', tags: ['bugfix'] }), obs('turn-2', { statement: 'Keep bug fixes scoped.', tags: ['bugfix'] })],
      'mem-1',
      '2026-09-21T00:00:00.000Z',
    );
    expect(item.status).toBe('proposed');
  });
});

describe('findConfirmationsNeeded — always-confirm for exclusion-listed candidates', () => {
  it('surfaces an exclusion-listed candidate even on its first (single-turn) occurrence', () => {
    const item = classifyRepeatedObservations([obs('turn-1')], 'mem-1', '2026-09-21T00:00:00.000Z');
    expect(item.status).toBe('candidate');
    const results = findConfirmationsNeeded({ topics: ['deploy-approval'] }, [item]);
    expect(results).toHaveLength(1);
    expect(results[0]!.prompt).toContain('every time, not just once repeated');
  });

  it('does not surface an ordinary (non-excluded) candidate', () => {
    const item = classifyRepeatedObservations(
      [obs('turn-1', { statement: 'Keep bug fixes scoped.', tags: ['bugfix'] })],
      'mem-1',
      '2026-09-21T00:00:00.000Z',
    );
    const results = findConfirmationsNeeded({ topics: ['bugfix'] }, [item]);
    expect(results).toHaveLength(0);
  });

  it('still surfaces ordinary proposed items via the existing #211 path (no regression)', () => {
    const item = classifyRepeatedObservations(
      [
        obs('turn-1', { statement: 'Keep bug fixes scoped.', tags: ['bugfix'] }),
        obs('turn-2', { statement: 'Keep bug fixes scoped.', tags: ['bugfix'] }),
      ],
      'mem-1',
      '2026-09-21T00:00:00.000Z',
    );
    expect(item.status).toBe('proposed');
    const results = findConfirmationsNeeded({ topics: ['bugfix'] }, [item]);
    expect(results).toHaveLength(1);
  });
});

describe('exclusion-listed items never bypass confirmation, even confirmed with high repetition (end-to-end)', () => {
  it('never becomes active via the write-guard path either (issue #206 integration)', async () => {
    const { guardMemoryWrite } = await import('../src/core/application/use-cases/memory/write-guard.js');
    const item: MemoryItem = {
      id: 'mem-1',
      kind: 'rule',
      scope: { type: 'global' },
      statement: 'Auto-approve deploy access without approval.',
      provenance: 'inferred-repeated',
      confidence: 'low',
      status: 'active', // simulating a bypass attempt
      createdAt: '2026-09-21T00:00:00.000Z',
      updatedAt: '2026-09-21T00:00:00.000Z',
    };
    const result = guardMemoryWrite(item);
    expect(result.outcome).toBe('rejected');
  });
});

const baseItem: Omit<MemoryItem, 'id' | 'status'> = {
  kind: 'rule',
  scope: { type: 'global' },
  statement: 'Prefer Codex for frontend work.',
  provenance: 'explicit',
  confidence: 'high',
  createdAt: '2026-09-21T00:00:00.000Z',
  updatedAt: '2026-09-21T00:00:00.000Z',
  tags: ['provider-choice'],
};

describe('recordConflict', () => {
  it('produces a new item with conflict status, linked to the existing active item', () => {
    const existing: MemoryItem = { ...baseItem, id: 'r-existing', status: 'active' };
    const incoming: MemoryItem = {
      ...baseItem,
      id: 'r-new',
      status: 'active',
      statement: 'Prefer Claude for frontend work.',
    };
    const recorded = recordConflict(incoming, existing, '2026-09-21T01:00:00.000Z');
    expect(recorded.status).toBe('conflict');
    expect(recorded.conflictsWith).toEqual(['r-existing']);
  });

  it('does not overwrite or change the existing active item', () => {
    const existing: MemoryItem = { ...baseItem, id: 'r-existing', status: 'active' };
    const incoming: MemoryItem = { ...baseItem, id: 'r-new', status: 'active' };
    recordConflict(incoming, existing, '2026-09-21T01:00:00.000Z');
    expect(existing.status).toBe('active'); // unmutated — recordConflict is pure
  });

  it('throws when the existing item is not active', () => {
    const notActive: MemoryItem = { ...baseItem, id: 'r-existing', status: 'retired' };
    const incoming: MemoryItem = { ...baseItem, id: 'r-new', status: 'active' };
    expect(() => recordConflict(incoming, notActive, '2026-09-21T01:00:00.000Z')).toThrow();
  });

  it('a conflict-status item is excluded from the compiled Brief (integration)', () => {
    const existing: MemoryItem = { ...baseItem, id: 'r-existing', status: 'active' };
    const incoming: MemoryItem = { ...baseItem, id: 'r-new', status: 'active' };
    const recorded = recordConflict(incoming, existing, '2026-09-21T01:00:00.000Z');
    const brief = compileExecutionBrief(
      { taskId: 't1', objective: 'x', topics: ['provider-choice'] },
      [existing, recorded],
    );
    // Only the still-active existing item applies; the conflicted new one doesn't.
    expect(brief.applicableRules.map((r) => r.id)).toEqual(['r-existing']);
  });
});

describe('resolveConflict', () => {
  const existing: MemoryItem = { ...baseItem, id: 'r-existing', status: 'active' };
  const conflicted: MemoryItem = {
    ...baseItem,
    id: 'r-new',
    status: 'conflict',
    conflictsWith: ['r-existing'],
    statement: 'Prefer Claude for frontend work.',
  };

  it('keep-new promotes the new item to active and retires the existing one to superseded', () => {
    const { winner, loser } = resolveConflict(conflicted, existing, 'keep-new', '2026-09-21T02:00:00.000Z');
    expect(winner.id).toBe('r-new');
    expect(winner.status).toBe('active');
    expect(winner.supersedes).toBe('r-existing');
    expect(loser.id).toBe('r-existing');
    expect(loser.status).toBe('superseded');
  });

  it('keep-existing leaves the existing item active and supersedes the new one', () => {
    const { winner, loser } = resolveConflict(conflicted, existing, 'keep-existing', '2026-09-21T02:00:00.000Z');
    expect(winner.id).toBe('r-existing');
    expect(winner.status).toBe('active');
    expect(loser.id).toBe('r-new');
    expect(loser.status).toBe('superseded');
  });

  it('throws when newItem is not in conflict status', () => {
    const notConflicted: MemoryItem = { ...conflicted, status: 'active' };
    expect(() => resolveConflict(notConflicted, existing, 'keep-new', '2026-09-21T02:00:00.000Z')).toThrow();
  });
});
