import { describe, it, expect } from 'vitest';
import {
  findProposedConfirmations,
  resolveProposedConfirmation,
} from '../src/core/application/use-cases/memory/rule-confirmation.js';
import { compileExecutionBrief } from '../src/core/application/use-cases/memory/execution-brief.js';
import type { MemoryItem } from '../src/core/domain/memory.js';

function proposedItem(overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: 'mem-1',
    kind: 'rule',
    scope: { type: 'global' },
    statement: 'Keep bug fixes scoped tightly.',
    provenance: 'inferred-repeated',
    confidence: 'medium',
    status: 'proposed',
    createdAt: '2026-09-21T00:00:00.000Z',
    updatedAt: '2026-09-21T00:00:00.000Z',
    tags: ['bugfix'],
    sourceTurnIds: ['turn-1', 'turn-5'],
    ...overrides,
  };
}

describe('findProposedConfirmations', () => {
  it('surfaces a proposed item that tag-matches the request', () => {
    const results = findProposedConfirmations({ topics: ['bugfix'] }, [proposedItem()]);
    expect(results).toHaveLength(1);
    expect(results[0]!.item.id).toBe('mem-1');
    expect(results[0]!.prompt).toContain('Keep bug fixes scoped tightly.');
    expect(results[0]!.prompt).toContain('standing rule');
  });

  it('does not surface non-proposed items (candidate, active, retired)', () => {
    for (const status of ['candidate', 'active', 'retired', 'conflict', 'superseded'] as const) {
      const results = findProposedConfirmations({ topics: ['bugfix'] }, [proposedItem({ status })]);
      expect(results).toHaveLength(0);
    }
  });

  it('does not surface a proposed item that does not tag-match', () => {
    const results = findProposedConfirmations({ topics: ['frontend'] }, [proposedItem()]);
    expect(results).toHaveLength(0);
  });

  it('deduplicates the same item within one call even if it matches multiple tags', () => {
    const item = proposedItem({ tags: ['bugfix', 'verification'] });
    const results = findProposedConfirmations({ topics: ['bugfix', 'verification'] }, [item]);
    expect(results).toHaveLength(1);
  });

  it('includes a project qualifier in the prompt for project-scoped items', () => {
    const item = proposedItem({ scope: { type: 'project', projectId: 'proj-1' } });
    const results = findProposedConfirmations({ topics: ['bugfix'] }, [item]);
    expect(results[0]!.prompt).toContain('for this project');
  });
});

describe('resolveProposedConfirmation', () => {
  it('confirm promotes to active with high confidence', () => {
    const resolved = resolveProposedConfirmation(proposedItem(), 'confirm', '2026-09-21T01:00:00.000Z');
    expect(resolved.status).toBe('active');
    expect(resolved.confidence).toBe('high');
    expect(resolved.updatedAt).toBe('2026-09-21T01:00:00.000Z');
  });

  it('decline retires the item (soft-delete, kept for provenance)', () => {
    const resolved = resolveProposedConfirmation(proposedItem(), 'decline', '2026-09-21T01:00:00.000Z');
    expect(resolved.status).toBe('retired');
    expect(resolved.id).toBe('mem-1');
    expect(resolved.statement).toBe(proposedItem().statement);
  });

  it('confirm with a narrowed scope overrides the original scope', () => {
    const resolved = resolveProposedConfirmation(
      proposedItem(),
      'confirm',
      '2026-09-21T01:00:00.000Z',
      { type: 'task', taskId: 'task-1' },
    );
    expect(resolved.scope).toEqual({ type: 'task', taskId: 'task-1' });
  });

  it('throws when the item is not in proposed status', () => {
    expect(() =>
      resolveProposedConfirmation(proposedItem({ status: 'active' }), 'confirm', '2026-09-21T01:00:00.000Z'),
    ).toThrow();
  });
});

describe('confirmation -> compileExecutionBrief integration', () => {
  it('a confirmed (now active) item becomes usable by the compiler', () => {
    const confirmed = resolveProposedConfirmation(proposedItem(), 'confirm', '2026-09-21T01:00:00.000Z');
    const brief = compileExecutionBrief(
      { taskId: 't1', objective: 'x', topics: ['bugfix'] },
      [confirmed],
    );
    expect(brief.applicableRules.map((r) => r.id)).toEqual(['mem-1']);
  });

  it('a declined (now retired) item stays unusable', () => {
    const declined = resolveProposedConfirmation(proposedItem(), 'decline', '2026-09-21T01:00:00.000Z');
    const brief = compileExecutionBrief(
      { taskId: 't1', objective: 'x', topics: ['bugfix'] },
      [declined],
    );
    expect(brief.applicableRules).toHaveLength(0);
  });
});
