import { describe, it, expect } from 'vitest';
import {
  detectQuotaExhaustion,
  detectContextDegradation,
  detectRetryCeiling,
  detectInactivity,
  type QuotaObservation,
} from '../src/core/application/use-cases/attention/escalation-triggers.js';
import { LivenessMonitor } from '../src/core/application/use-cases/attention/liveness-monitor.js';
import { AttentionInbox } from '../src/core/application/use-cases/attention/attention-inbox.js';
import { SupervisionLadder, SupervisionLevel } from '../src/core/application/use-cases/attention/supervision-ladder.js';
import type { ContextHealthChangedEvent } from '../src/core/domain/events.js';

describe('detectQuotaExhaustion', () => {
  it('signals on an exhausted window', () => {
    const obs: QuotaObservation = { taskId: 't1', provider: 'codex', window: '5h', status: 'exhausted' };
    const signal = detectQuotaExhaustion(obs);
    expect(signal).not.toBeNull();
    expect(signal!.taskId).toBe('t1');
    expect(signal!.reason).toContain('codex/5h');
  });

  it('does not signal on allowed or warning windows', () => {
    expect(
      detectQuotaExhaustion({ taskId: 't1', provider: 'codex', window: '5h', status: 'allowed' }),
    ).toBeNull();
    expect(
      detectQuotaExhaustion({ taskId: 't1', provider: 'codex', window: '5h', status: 'warning' }),
    ).toBeNull();
  });
});

describe('detectContextDegradation', () => {
  function event(status: ContextHealthChangedEvent['status']): ContextHealthChangedEvent {
    return {
      type: 'ContextHealthChanged',
      timestamp: '2026-09-21T00:00:00.000Z',
      taskId: 't1',
      sessionId: 's1',
      agentId: 'codex',
      adapterFidelityTier: 'B',
      status,
    };
  }

  it('does not signal on ok status', () => {
    expect(detectContextDegradation('t1', event('ok'))).toBeNull();
  });

  it('signals on degraded and critical status', () => {
    expect(detectContextDegradation('t1', event('degraded'))).not.toBeNull();
    expect(detectContextDegradation('t1', event('critical'))).not.toBeNull();
  });
});

describe('detectRetryCeiling', () => {
  it('does not signal below the ceiling', () => {
    expect(detectRetryCeiling('t1', 2, 5)).toBeNull();
  });

  it('signals at or above the ceiling', () => {
    expect(detectRetryCeiling('t1', 5, 5)).not.toBeNull();
    expect(detectRetryCeiling('t1', 6, 5)).not.toBeNull();
  });
});

describe('detectInactivity', () => {
  it('does not signal for a task with no recorded events', () => {
    const monitor = new LivenessMonitor();
    expect(detectInactivity('t1', monitor)).toBeNull();
  });

  it('signals once the liveness timeout is exceeded', () => {
    let clock = 0;
    const monitor = new LivenessMonitor({ timeoutMs: 1000, now: () => clock });
    monitor.seed('t1', 0);
    clock = 2000;
    const signal = detectInactivity('t1', monitor);
    expect(signal).not.toBeNull();
    expect(signal!.reason).toContain('1000ms');
  });
});

describe('escalation triggers feeding the ladder (no over-escalation)', () => {
  it('a quota-exhaustion signal resolved by an L2 resolver never reaches L4', () => {
    const inbox = new AttentionInbox();
    const obs: QuotaObservation = { taskId: 't1', provider: 'codex', window: '5h', status: 'exhausted' };
    const signal = detectQuotaExhaustion(obs)!;
    const ladder = new SupervisionLadder({
      inbox,
      l2Resolvers: [{ resolve: () => true }], // e.g. manager reroutes to another provider
    });
    const outcome = ladder.escalate(signal);
    expect(outcome.level).toBe(SupervisionLevel.L2ManagerReasoning);
    expect(inbox.list()).toHaveLength(0);
  });

  it('an unresolved context-degradation signal reaches L4 exactly once', () => {
    const inbox = new AttentionInbox();
    const event: ContextHealthChangedEvent = {
      type: 'ContextHealthChanged',
      timestamp: '2026-09-21T00:00:00.000Z',
      taskId: 't1',
      sessionId: 's1',
      agentId: 'codex',
      adapterFidelityTier: 'B',
      status: 'critical',
    };
    const signal = detectContextDegradation('t1', event)!;
    const ladder = new SupervisionLadder({ inbox });
    const outcome = ladder.escalate(signal);
    expect(outcome.level).toBe(SupervisionLevel.L4Human);
    expect(inbox.list()).toHaveLength(1);
  });
});
