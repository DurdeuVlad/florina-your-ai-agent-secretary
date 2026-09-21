import { describe, it, expect } from 'vitest';

import { QuotaLedger } from '../src/daemon/quota-ledger.js';
import { CapacityRouter } from '../src/daemon/capacity-router.js';
import type { PreferenceProfile } from '../src/daemon/capacity-router.js';
import type { QuotaWindow } from '../src/daemon/quota-ledger.js';

const T0 = new Date('2026-09-13T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

const VLADS_PROFILE: PreferenceProfile = {
  rules: [
    { provider: 'claude-code', workTypes: ['thinking', 'remote'] },
    { provider: 'claude-code', model: 'opus' },
    { provider: 'claude-code', model: 'sonnet-latest' },
    { provider: 'codex' },
    { provider: 'devin', workTypes: ['long-running'] },
    { provider: 'gemini' },
  ],
  denied: [
    { provider: 'claude-code', model: 'opus' },
    { provider: 'claude-code', model: 'faber' },
  ],
};

function exhausted(provider: string, resetsAt: string | null): QuotaWindow {
  return {
    provider,
    window: 'reactive',
    usedPct: 1,
    resetsAt,
    status: 'exhausted',
    source: 'reactive',
    observedAt: T0.toISOString(),
  };
}

function router(
  profile: PreferenceProfile = VLADS_PROFILE,
  windows: QuotaWindow[] = [],
): CapacityRouter {
  const ledger = new QuotaLedger({ now: () => T0 });
  for (const w of windows) {
    ledger.recordWindow(w);
  }
  return new CapacityRouter({ ledger, profile });
}

describe('CapacityRouter', () => {
  it('routes untyped work to the first non-denied catch-all rule', () => {
    const result = router().route({});
    // opus rule is denied, so sonnet-latest wins.
    expect(result).toMatchObject({
      kind: 'routed',
      provider: 'claude-code',
      model: 'sonnet-latest',
    });
  });

  it('routes typed work to the matching work-type rule', () => {
    const result = router().route({ workType: 'thinking' });
    expect(result).toMatchObject({ kind: 'routed', provider: 'claude-code' });
  });

  it('applies model-level deny rules', () => {
    const profile: PreferenceProfile = {
      rules: [{ provider: 'claude-code', model: 'opus' }, { provider: 'codex' }],
      denied: [{ provider: 'claude-code', model: 'opus' }],
    };
    const result = router(profile).route({});
    expect(result).toMatchObject({ kind: 'routed', provider: 'codex' });
  });

  it('a claude-code deny on the short alias also blocks the full model id (issue #250)', () => {
    const profile: PreferenceProfile = {
      rules: [{ provider: 'claude-code', model: 'claude-opus-5' }, { provider: 'codex' }],
      denied: [{ provider: 'claude-code', model: 'opus' }],
    };
    const result = router(profile).route({});
    expect(result).toMatchObject({ kind: 'routed', provider: 'codex' });
  });

  it('a claude-code deny on the full model id also blocks the short alias (issue #250)', () => {
    const profile: PreferenceProfile = {
      rules: [{ provider: 'claude-code', model: 'opus' }, { provider: 'codex' }],
      denied: [{ provider: 'claude-code', model: 'claude-opus-5' }],
    };
    const result = router(profile).route({});
    expect(result).toMatchObject({ kind: 'routed', provider: 'codex' });
  });

  it('claude-code alias-family matching does not deny other model families', () => {
    const profile: PreferenceProfile = {
      rules: [{ provider: 'claude-code', model: 'claude-sonnet-5' }],
      denied: [{ provider: 'claude-code', model: 'opus' }],
    };
    const result = router(profile).route({});
    expect(result).toMatchObject({ kind: 'routed', provider: 'claude-code', model: 'claude-sonnet-5' });
  });

  it('alias-family matching is scoped to claude-code and does not affect other providers', () => {
    const profile: PreferenceProfile = {
      // "opus" is a plausible-but-unrelated model string on another provider;
      // a claude-code deny must never leak into it.
      rules: [{ provider: 'antigravity', model: 'opus' }],
      denied: [{ provider: 'claude-code', model: 'opus' }],
    };
    const result = router(profile).route({});
    expect(result).toMatchObject({ kind: 'routed', provider: 'antigravity', model: 'opus' });
  });

  it('a deny rule without a model removes the provider entirely', () => {
    const profile: PreferenceProfile = {
      rules: [{ provider: 'gemini' }, { provider: 'codex' }],
      denied: [{ provider: 'gemini' }],
    };
    expect(router(profile).route({})).toMatchObject({ kind: 'routed', provider: 'codex' });
  });

  it('fails over past an exhausted provider to the next preference', () => {
    const r = router(VLADS_PROFILE, [
      exhausted('claude-code', new Date(T0.getTime() + HOUR).toISOString()),
    ]);
    expect(r.route({})).toMatchObject({ kind: 'routed', provider: 'codex' });
  });

  it('excludes already-tried providers on failover', () => {
    const result = router().route({ excludeProviders: ['claude-code', 'codex'] });
    expect(result).toMatchObject({ kind: 'routed', provider: 'gemini' });
  });

  it('parks with the earliest resume time when all candidates are exhausted', () => {
    const soon = new Date(T0.getTime() + HOUR).toISOString();
    const late = new Date(T0.getTime() + 6 * HOUR).toISOString();
    const r = router(VLADS_PROFILE, [
      exhausted('claude-code', late),
      exhausted('codex', soon),
      exhausted('devin', late),
      exhausted('gemini', late),
    ]);
    const result = r.route({});
    expect(result).toMatchObject({ kind: 'parked', resumeAt: soon });
  });

  it('typed request with no matching typed rule falls back to catch-alls', () => {
    const result = router().route({ workType: 'nonexistent-type' });
    expect(result).toMatchObject({
      kind: 'routed',
      provider: 'claude-code',
      model: 'sonnet-latest',
    });
  });

  it('parks with null resumeAt when every candidate is denied or excluded', () => {
    const profile: PreferenceProfile = {
      rules: [{ provider: 'gemini' }],
      denied: [{ provider: 'gemini' }],
    };
    const result = router(profile).route({});
    expect(result).toMatchObject({ kind: 'parked', resumeAt: null });
    expect(result.kind === 'parked' && result.reason).toContain('no preference rule');
  });

  it('treats providers with no quota data as available (optimistic)', () => {
    // Devin has no recorded windows — reactive-only provider.
    const result = router().route({ workType: 'long-running' });
    expect(result).toMatchObject({ kind: 'routed', provider: 'devin' });
  });
});
