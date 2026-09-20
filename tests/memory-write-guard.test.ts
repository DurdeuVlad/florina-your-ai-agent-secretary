import { describe, it, expect } from 'vitest';
import type { MemoryItem, MemoryKind, MemoryProvenance } from '../src/core/domain/memory.js';
import type { MemoryStorePort } from '../src/core/application/ports/outbound/memory-store.js';
import {
  guardMemoryWrite,
  writeMemoryItem,
  isExcludedTopic,
} from '../src/core/application/use-cases/memory/write-guard.js';

function item(overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: 'mem-1',
    kind: 'rule',
    scope: { type: 'global' },
    statement: 'Research prior art before large architecture decisions.',
    provenance: 'explicit',
    confidence: 'high',
    status: 'active',
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
    ...overrides,
  };
}

class InMemoryStore implements MemoryStorePort {
  readonly items: MemoryItem[] = [];
  insert(i: MemoryItem): void {
    this.items.push(i);
  }
  getById(id: string): MemoryItem | null {
    return this.items.find((i) => i.id === id) ?? null;
  }
  list(): readonly MemoryItem[] {
    return this.items;
  }
  update(i: MemoryItem): void {
    const idx = this.items.findIndex((x) => x.id === i.id);
    if (idx >= 0) this.items[idx] = i;
  }
}

describe('isExcludedTopic', () => {
  it('matches credential/autonomy/deploy keywords case-insensitively', () => {
    expect(isExcludedTopic('Always store the API key in .env')).toBe(true);
    expect(isExcludedTopic('AUTO-APPROVE network access from now on')).toBe(true);
    expect(isExcludedTopic('Only Vlad can merge to main')).toBe(true);
  });

  it('does not match ordinary statements', () => {
    expect(isExcludedTopic('Prefer Sonnet for repeatable reading work')).toBe(false);
    expect(isExcludedTopic('Keep bug fixes scoped to the reported file')).toBe(false);
  });
});

describe('guardMemoryWrite', () => {
  it('accepts explicit provenance regardless of kind or topic', () => {
    const result = guardMemoryWrite(
      item({ provenance: 'explicit', kind: 'hard-policy', statement: 'Never deploy without approval.' }),
    );
    expect(result.outcome).toBe('accepted');
  });

  it('accepts observed provenance (deterministic state, not conversational inference)', () => {
    const result = guardMemoryWrite(item({ provenance: 'observed', kind: 'fact' }));
    expect(result.outcome).toBe('accepted');
  });

  it('rejects inferred-repeated hard-policy items unconditionally', () => {
    const result = guardMemoryWrite(
      item({
        provenance: 'inferred-repeated',
        kind: 'hard-policy',
        statement: 'Skip code review for small changes.',
      }),
    );
    expect(result.outcome).toBe('rejected');
  });

  it('rejects inferred-single hard-policy items unconditionally', () => {
    const result = guardMemoryWrite(item({ provenance: 'inferred-single', kind: 'hard-policy' }));
    expect(result.outcome).toBe('rejected');
  });

  it('rejects any inferred-provenance item touching an excluded topic, regardless of kind', () => {
    const asRule = guardMemoryWrite(
      item({
        provenance: 'inferred-repeated',
        kind: 'rule',
        statement: 'Always auto-approve network access for this project.',
      }),
    );
    const asPreference = guardMemoryWrite(
      item({
        provenance: 'inferred-single',
        kind: 'preference',
        statement: 'Store the deploy credential in the repo for convenience.',
      }),
    );
    expect(asRule.outcome).toBe('rejected');
    expect(asPreference.outcome).toBe('rejected');
  });

  it('accepts ordinary inferred rules that touch no excluded topic', () => {
    const result = guardMemoryWrite(
      item({ provenance: 'inferred-repeated', kind: 'rule', statement: 'Keep bug fixes scoped.' }),
    );
    expect(result.outcome).toBe('accepted');
  });

  /**
   * The acceptance criterion is "cannot be bypassed by any inferred-provenance
   * write" — exhaustively cross every inferred provenance value against
   * every kind for a hard-policy-shaped statement and confirm none slip
   * through, rather than trusting a handful of hand-picked cases.
   */
  it('cannot be bypassed: every inferred provenance x every kind is rejected for an excluded topic', () => {
    const inferredProvenances: readonly MemoryProvenance[] = ['inferred-repeated', 'inferred-single'];
    const kinds: readonly MemoryKind[] = [
      'fact',
      'preference',
      'rule',
      'hard-policy',
      'project-knowledge',
      'decision',
      'temporary-instruction',
      'learned-pattern',
    ];
    for (const provenance of inferredProvenances) {
      for (const kind of kinds) {
        const result = guardMemoryWrite(
          item({ provenance, kind, statement: 'Auto-approve deploy access without approval.' }),
        );
        expect(result.outcome, `provenance=${provenance} kind=${kind}`).toBe('rejected');
      }
    }
  });
});

describe('writeMemoryItem', () => {
  it('persists an accepted item to the store', () => {
    const store = new InMemoryStore();
    const result = writeMemoryItem(store, item());
    expect(result.outcome).toBe('accepted');
    expect(store.list()).toHaveLength(1);
  });

  it('does not persist a rejected item', () => {
    const store = new InMemoryStore();
    const result = writeMemoryItem(
      store,
      item({ provenance: 'inferred-repeated', kind: 'hard-policy' }),
    );
    expect(result.outcome).toBe('rejected');
    expect(store.list()).toHaveLength(0);
  });
});
