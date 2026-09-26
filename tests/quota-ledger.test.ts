import { describe, it, expect } from 'vitest';

import { QuotaLedger } from '../src/daemon/quota-ledger.js';
import type { QuotaWindow } from '../src/daemon/quota-ledger.js';

const T0 = new Date('2026-09-13T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function ledgerAt(date: Date): QuotaLedger {
  return new QuotaLedger({ now: () => date });
}

function window(overrides: Partial<QuotaWindow> = {}): QuotaWindow {
  return {
    provider: 'codex',
    window: 'five_hour',
    usedPct: 0.4,
    resetsAt: new Date(T0.getTime() + 2 * HOUR).toISOString(),
    status: 'allowed',
    source: 'polled',
    observedAt: T0.toISOString(),
    ...overrides,
  };
}

describe('QuotaLedger', () => {
  it('treats a provider with no recorded windows as available', () => {
    const ledger = ledgerAt(T0);
    expect(ledger.hasCapacity('devin')).toBe(true);
    expect(ledger.providerState('devin').available).toBe(true);
  });

  it('reports available while windows are under their quota', () => {
    const ledger = ledgerAt(T0);
    ledger.recordWindow(window());
    ledger.recordWindow(window({ window: 'seven_day', usedPct: 0.8 }));
    expect(ledger.hasCapacity('codex')).toBe(true);
  });

  it('blocks a provider while a window is exhausted and not yet reset', () => {
    const ledger = ledgerAt(T0);
    ledger.recordWindow(window({ status: 'exhausted', usedPct: 1 }));
    const state = ledger.providerState('codex');
    expect(state.available).toBe(false);
    expect(state.exhaustedUntil).toBe(window().resetsAt);
  });

  it('counts usedPct >= 1 as exhausted even when status says allowed', () => {
    const ledger = ledgerAt(T0);
    ledger.recordWindow(window({ usedPct: 1 }));
    expect(ledger.hasCapacity('codex')).toBe(false);
  });

  it('does not block on warning status', () => {
    const ledger = ledgerAt(T0);
    ledger.recordWindow(window({ status: 'warning', usedPct: 0.9 }));
    expect(ledger.hasCapacity('codex')).toBe(true);
  });

  it('unblocks a provider once its exhausted window has reset', () => {
    const resetsAt = new Date(T0.getTime() + HOUR).toISOString();
    const later = new Date(T0.getTime() + 2 * HOUR);
    const ledger = new QuotaLedger({ now: () => later });
    ledger.recordWindow(window({ status: 'exhausted', usedPct: 1, resetsAt }));
    expect(ledger.hasCapacity('codex')).toBe(true);
  });

  it('ignores stale observations so out-of-order writes cannot regress state', () => {
    const ledger = ledgerAt(T0);
    ledger.recordWindow(window({ status: 'exhausted', usedPct: 1, observedAt: T0.toISOString() }));
    ledger.recordWindow(
      window({ usedPct: 0.1, observedAt: new Date(T0.getTime() - HOUR).toISOString() }),
    );
    expect(ledger.hasCapacity('codex')).toBe(false);
  });

  it('markExhausted records a reactive exhaustion without a known reset', () => {
    const ledger = ledgerAt(T0);
    ledger.markExhausted('gemini');
    const state = ledger.providerState('gemini');
    expect(state.available).toBe(false);
    expect(state.exhaustedUntil).toBeNull();
    expect(state.windows[0]?.source).toBe('reactive');
  });

  it('earliestReset returns the soonest reset across exhausted windows', () => {
    const ledger = ledgerAt(T0);
    const sooner = new Date(T0.getTime() + HOUR).toISOString();
    const later = new Date(T0.getTime() + 5 * HOUR).toISOString();
    ledger.recordWindow(
      window({ provider: 'claude-code', status: 'exhausted', usedPct: 1, resetsAt: later }),
    );
    ledger.recordWindow(
      window({ provider: 'codex', status: 'exhausted', usedPct: 1, resetsAt: sooner }),
    );
    expect(ledger.earliestReset()).toBe(sooner);
    expect(ledger.earliestReset(['claude-code'])).toBe(later);
  });

  it('earliestReset is null when nothing is exhausted', () => {
    const ledger = ledgerAt(T0);
    ledger.recordWindow(window());
    expect(ledger.earliestReset()).toBeNull();
  });

  it('lists providers with recorded windows', () => {
    const ledger = ledgerAt(T0);
    ledger.recordWindow(window({ provider: 'codex' }));
    ledger.recordWindow(window({ provider: 'devin', window: 'monthly' }));
    expect(ledger.providers().sort()).toEqual(['codex', 'devin']);
  });
});
