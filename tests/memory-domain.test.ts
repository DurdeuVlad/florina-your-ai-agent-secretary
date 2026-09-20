import { describe, it, expect } from 'vitest';
import { sameMemoryScope, isMemoryActive, type MemoryItem } from '../src/core/domain/memory.js';

describe('sameMemoryScope', () => {
  it('matches two global scopes', () => {
    expect(sameMemoryScope({ type: 'global' }, { type: 'global' })).toBe(true);
  });

  it('matches project scopes only when the project id matches', () => {
    const a = { type: 'project', projectId: 'proj-1' } as const;
    const b = { type: 'project', projectId: 'proj-1' } as const;
    const c = { type: 'project', projectId: 'proj-2' } as const;
    expect(sameMemoryScope(a, b)).toBe(true);
    expect(sameMemoryScope(a, c)).toBe(false);
  });

  it('never matches across different scope types', () => {
    expect(sameMemoryScope({ type: 'global' }, { type: 'project', projectId: 'p' })).toBe(false);
    expect(
      sameMemoryScope({ type: 'task', taskId: 't' }, { type: 'project', projectId: 'p' }),
    ).toBe(false);
  });
});

describe('isMemoryActive', () => {
  const base: Omit<MemoryItem, 'status'> = {
    id: 'mem-1',
    kind: 'rule',
    scope: { type: 'global' },
    statement: 'Research prior art before large architecture decisions.',
    provenance: 'explicit',
    confidence: 'high',
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
  };

  it('is true only for active status', () => {
    expect(isMemoryActive({ ...base, status: 'active' })).toBe(true);
    expect(isMemoryActive({ ...base, status: 'candidate' })).toBe(false);
    expect(isMemoryActive({ ...base, status: 'proposed' })).toBe(false);
    expect(isMemoryActive({ ...base, status: 'conflict' })).toBe(false);
    expect(isMemoryActive({ ...base, status: 'retired' })).toBe(false);
    expect(isMemoryActive({ ...base, status: 'superseded' })).toBe(false);
  });
});
