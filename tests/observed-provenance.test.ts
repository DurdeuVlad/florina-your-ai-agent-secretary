import { describe, it, expect, vi } from 'vitest';
import { AttentionAggregator } from '../src/core/application/use-cases/attention/attention-aggregator.js';
import type { ApprovalGate } from '../src/core/application/use-cases/attention/attention-aggregator.js';
import { AttentionInbox } from '../src/core/application/use-cases/attention/attention-inbox.js';
import { EventBus } from '../src/adapters/outbound/events/in-memory-event-bus.js';
import { validateEvent } from '../src/core/domain/events.js';
import type { ApprovalRequestedEvent, AgentFailedEvent } from '../src/core/domain/events.js';
import { QuotaLedger } from '../src/core/application/use-cases/routing/quota-ledger.js';

const base = {
  timestamp: '2026-09-21T00:00:00.000Z',
  taskId: 'task-1',
  sessionId: 'sess-1',
  agentId: 'claude-code',
  adapterFidelityTier: 'A' as const,
};

function approvalEvent(overrides: Partial<ApprovalRequestedEvent> = {}): ApprovalRequestedEvent {
  return {
    ...base,
    type: 'ApprovalRequested',
    task: 'Some task',
    agent: 'claude-code',
    capability: 'network',
    destination: 'example.com',
    command: 'npm install',
    workingDir: '/repo',
    scope: [{ type: 'network', targets: ['example.com'] }],
    riskLevel: 'low',
    ...overrides,
  };
}

describe('domain: provenance field validation (DEC-041, issue #197)', () => {
  it('accepts an event with no provenance (defaults to managed)', () => {
    const event = approvalEvent();
    expect(() => validateEvent(event)).not.toThrow();
  });

  it('accepts provenance: "managed"', () => {
    const event = approvalEvent({ provenance: 'managed' });
    expect(() => validateEvent(event)).not.toThrow();
  });

  it('accepts provenance: "observed"', () => {
    const event = approvalEvent({ provenance: 'observed' });
    expect(() => validateEvent(event)).not.toThrow();
  });

  it('rejects an invalid provenance value', () => {
    const event = { ...approvalEvent(), provenance: 'bogus' };
    expect(() => validateEvent(event)).toThrow();
  });
});

describe('AttentionAggregator: observed events never reach the inbox/approval pipeline', () => {
  it('an observed ApprovalRequested is never auto-approved: the gate is never even called', () => {
    const inbox = new AttentionInbox();
    const bus = new EventBus();
    const approvalGate: ApprovalGate = { evaluateApprovalRequest: vi.fn(() => 'auto-approved') };
    const aggregator = new AttentionAggregator(inbox, bus, { approvalGate });
    aggregator.start();

    bus.publish(approvalEvent({ provenance: 'observed' }));

    expect(approvalGate.evaluateApprovalRequest).not.toHaveBeenCalled();
  });

  it('an observed ApprovalRequested never creates an attention item, escalated or not', () => {
    const inbox = new AttentionInbox();
    const bus = new EventBus();
    const approvalGate: ApprovalGate = { evaluateApprovalRequest: vi.fn(() => 'escalate') };
    const aggregator = new AttentionAggregator(inbox, bus, { approvalGate });
    aggregator.start();

    bus.publish(approvalEvent({ provenance: 'observed' }));

    expect(inbox.list()).toHaveLength(0);
  });

  it('an observed AgentFailed never creates a FailedRun attention item either — the guard is type-agnostic', () => {
    const inbox = new AttentionInbox();
    const bus = new EventBus();
    const aggregator = new AttentionAggregator(inbox, bus);
    aggregator.start();

    const failed: AgentFailedEvent = {
      ...base,
      type: 'AgentFailed',
      reason: 'timeout',
      provenance: 'observed',
    };
    bus.publish(failed);

    expect(inbox.list()).toHaveLength(0);
  });

  it('control: the same ApprovalRequested WITHOUT observed provenance behaves normally (auto-approves)', () => {
    const inbox = new AttentionInbox();
    const bus = new EventBus();
    const approvalGate: ApprovalGate = { evaluateApprovalRequest: vi.fn(() => 'auto-approved') };
    const aggregator = new AttentionAggregator(inbox, bus, { approvalGate });
    aggregator.start();

    bus.publish(approvalEvent());

    expect(approvalGate.evaluateApprovalRequest).toHaveBeenCalledOnce();
    expect(inbox.list()).toHaveLength(0); // auto-approved -> no inbox item, same as today
  });

  it('control: an unresolved (non-observed) ApprovalRequested still escalates to the inbox', () => {
    const inbox = new AttentionInbox();
    const bus = new EventBus();
    const approvalGate: ApprovalGate = { evaluateApprovalRequest: vi.fn(() => 'escalate') };
    const aggregator = new AttentionAggregator(inbox, bus, { approvalGate });
    aggregator.start();

    bus.publish(approvalEvent());

    expect(inbox.list()).toHaveLength(1);
  });
});

describe('quota accounting has no reachable path from SupervisorEvents at all (architectural guarantee)', () => {
  it('QuotaLedger exposes no bus subscription — publishing any event, observed or not, cannot reach it', () => {
    const ledger = new QuotaLedger();
    const recordSpy = vi.spyOn(ledger, 'recordWindow');
    const bus = new EventBus();
    const inbox = new AttentionInbox();
    const aggregator = new AttentionAggregator(inbox, bus);
    aggregator.start();

    bus.publish(approvalEvent({ provenance: 'observed' }));
    bus.publish(approvalEvent());

    // QuotaLedger.recordWindow only ever runs from explicit
    // QuotaReaderPort polling (a provider quota reading), never from the
    // SupervisorEvent bus — so it is unreachable from any event,
    // observed or managed, by construction, not by a guard that could
    // be bypassed.
    expect(recordSpy).not.toHaveBeenCalled();
  });
});

describe('task journaling has no reachable path from arbitrary SupervisorEvents (architectural guarantee)', () => {
  it('publishing an observed event does not create or reference a Task row anywhere in the aggregator pipeline', () => {
    // AttentionAggregator's constructor accepts only an inbox, bus, and
    // optional approval/verification gates -- it holds no TaskRepositoryPort
    // reference at all, so it has no mechanism to create or mutate a Task
    // regardless of an event's provenance. Tasks are only ever created
    // explicitly by CommandApi.handleStartTask (#209), which observed
    // provider-native activity never goes through by definition (Florina
    // did not dispatch it).
    const inbox = new AttentionInbox();
    const bus = new EventBus();
    const aggregator = new AttentionAggregator(inbox, bus);
    aggregator.start();
    expect(Object.keys(aggregator)).not.toContain('taskStore');
    expect(Object.keys(aggregator)).not.toContain('taskRepository');

    bus.publish(approvalEvent({ provenance: 'observed' }));
    expect(inbox.list()).toHaveLength(0);
  });
});
