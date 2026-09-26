import { describe, it, expect } from 'vitest';
import { preferenceProfileToMemoryItems } from '../src/core/application/use-cases/memory/preference-bridge.js';
import type { PreferenceProfile } from '../src/core/application/ports/outbound/preference-profile.js';
import type { IdGeneratorPort } from '../src/core/application/ports/outbound/id-generator.js';
import type { ClockPort } from '../src/core/application/ports/outbound/clock.js';

function fakeIds(): IdGeneratorPort {
  let n = 0;
  return { generate: (prefix: string) => `${prefix}-${++n}` };
}

function fakeClock(iso: string): ClockPort {
  return { now: () => new Date(iso) };
}

describe('preferenceProfileToMemoryItems', () => {
  it('maps an empty profile to no items', () => {
    const profile: PreferenceProfile = { rules: [], denied: [] };
    expect(preferenceProfileToMemoryItems(profile, fakeIds(), fakeClock('2026-09-21T00:00:00.000Z'))).toEqual(
      [],
    );
  });

  it('maps routing rules and deny rules to explicit, active preference-kind items', () => {
    const profile: PreferenceProfile = {
      rules: [
        { provider: 'claude-code', model: 'sonnet', workTypes: ['reading'], note: 'good at reasoning' },
        { provider: 'codex', projectId: 'proj-1' },
      ],
      denied: [{ provider: 'claude-code', model: 'opus' }],
    };
    const items = preferenceProfileToMemoryItems(profile, fakeIds(), fakeClock('2026-09-21T00:00:00.000Z'));

    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(item.kind).toBe('preference');
      expect(item.provenance).toBe('explicit');
      expect(item.status).toBe('active');
      expect(item.createdAt).toBe('2026-09-21T00:00:00.000Z');
    }

    expect(items[0]!.scope).toEqual({ type: 'global' });
    expect(items[0]!.statement).toBe(
      'Prefer claude-code/sonnet for reading — good at reasoning',
    );

    expect(items[1]!.scope).toEqual({ type: 'project', projectId: 'proj-1' });
    expect(items[1]!.statement).toBe('Prefer codex (project rule)');

    expect(items[2]!.statement).toBe('Never claude-code/opus');
  });

  it('generates unique ids for every rule via the injected id generator', () => {
    const profile: PreferenceProfile = {
      rules: [{ provider: 'a' }, { provider: 'b' }],
      denied: [{ provider: 'c' }],
    };
    const items = preferenceProfileToMemoryItems(profile, fakeIds(), fakeClock('2026-09-21T00:00:00.000Z'));
    const ids = items.map((i) => i.id);
    expect(new Set(ids).size).toBe(3);
  });
});
