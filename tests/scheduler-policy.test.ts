/**
 * Scheduler policy unit tests (issue #344): the four dispatch branches —
 * serial-per-provider default, consent+headroom parallel, consent
 * without headroom parked on the ledger's reset, and busy-without-
 * consent waiting. Inputs are the same facts the pump reads from the
 * QuotaLedger — faked here, so the branches are total and deterministic.
 */
import { describe, it, expect } from 'vitest';
import { decideScheduling } from '../src/core/application/use-cases/scheduling/scheduler-policy.js';
import type { SchedulingInput } from '../src/core/application/use-cases/scheduling/scheduler-policy.js';

const FREE: SchedulingInput = {
  providerBusy: false,
  parallelizable: false,
  userRequestedParallel: false,
  hasCapacity: true,
  resumeAt: null,
};

describe('decideScheduling — capacity- and consent-gated parallelism', () => {
  it('dispatches serially when the provider session is free', () => {
    const d = decideScheduling(FREE);
    expect(d.action).toBe('dispatch');
    expect(d.decision).toBe('serial-dispatch');
    if (d.action === 'dispatch') {
      expect(d.mode).toBe('serial');
    }
  });

  it('waits session-busy when the provider is occupied and no consent was given', () => {
    const d = decideScheduling({ ...FREE, providerBusy: true });
    expect(d).toEqual({
      action: 'wait',
      decision: 'session-busy',
      reason: expect.stringContaining('busy'),
    });
  });

  it('waits session-busy even with headroom when neither consent path applies', () => {
    const d = decideScheduling({ ...FREE, providerBusy: true, hasCapacity: true });
    expect(d.decision).toBe('session-busy');
  });

  it('dispatches parallel when the task declared parallelizable and headroom exists', () => {
    const d = decideScheduling({ ...FREE, providerBusy: true, parallelizable: true });
    expect(d.action).toBe('dispatch');
    expect(d.decision).toBe('parallel-ok');
    if (d.action === 'dispatch') {
      expect(d.mode).toBe('parallel');
    }
  });

  it('dispatches parallel when the user explicitly asked and headroom exists', () => {
    const d = decideScheduling({
      ...FREE,
      providerBusy: true,
      userRequestedParallel: true,
    });
    expect(d.decision).toBe('parallel-ok');
    expect(d.reason).toContain('user-requested');
  });

  it('parks quota-blocked with the ledger reset when consent exists but headroom does not', () => {
    const d = decideScheduling({
      ...FREE,
      providerBusy: true,
      parallelizable: true,
      hasCapacity: false,
      resumeAt: '2026-10-11T05:00:00.000Z',
    });
    expect(d).toEqual({
      action: 'wait',
      decision: 'quota-blocked',
      reason: expect.stringContaining('task-declared'),
      resumeAt: '2026-10-11T05:00:00.000Z',
    });
  });

  it('parks quota-blocked for a user request without headroom', () => {
    const d = decideScheduling({
      ...FREE,
      providerBusy: true,
      userRequestedParallel: true,
      hasCapacity: false,
      resumeAt: null,
    });
    expect(d.decision).toBe('quota-blocked');
    expect(d.reason).toContain('user-requested');
    expect(d.resumeAt).toBeUndefined();
  });

  it('never needs consent to dispatch on a free provider — serial is unconditional', () => {
    for (const flags of [
      { parallelizable: true },
      { userRequestedParallel: true },
      { parallelizable: true, userRequestedParallel: true },
    ]) {
      const d = decideScheduling({ ...FREE, ...flags });
      expect(d.decision).toBe('serial-dispatch');
    }
  });
});
