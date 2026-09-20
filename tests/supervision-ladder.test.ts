import { describe, it, expect } from 'vitest';
import { AttentionInbox } from '../src/core/application/use-cases/attention/attention-inbox.js';
import {
  SupervisionLadder,
  SupervisionLevel,
  type SupervisionResolver,
  type SupervisionSignal,
} from '../src/core/application/use-cases/attention/supervision-ladder.js';

function signal(overrides: Partial<SupervisionSignal> = {}): SupervisionSignal {
  return { taskId: 'task-1', reason: 'ambiguous event', ...overrides };
}

function resolverThatReturns(value: boolean, calls: SupervisionSignal[]): SupervisionResolver {
  return {
    resolve(s) {
      calls.push(s);
      return value;
    },
  };
}

describe('SupervisionLadder', () => {
  it('resolves at L2 without trying L3 or creating an item', () => {
    const inbox = new AttentionInbox();
    const l2Calls: SupervisionSignal[] = [];
    const l3Calls: SupervisionSignal[] = [];
    const ladder = new SupervisionLadder({
      inbox,
      l2Resolvers: [resolverThatReturns(true, l2Calls)],
      l3Resolvers: [resolverThatReturns(true, l3Calls)],
    });

    const outcome = ladder.escalate(signal());

    expect(outcome).toEqual({ level: SupervisionLevel.L2ManagerReasoning, resolved: true });
    expect(l2Calls).toHaveLength(1);
    expect(l3Calls).toHaveLength(0);
    expect(inbox.list()).toHaveLength(0);
  });

  it('falls through to L3 when every L2 resolver declines', () => {
    const inbox = new AttentionInbox();
    const l2Calls: SupervisionSignal[] = [];
    const l3Calls: SupervisionSignal[] = [];
    const ladder = new SupervisionLadder({
      inbox,
      l2Resolvers: [resolverThatReturns(false, l2Calls), resolverThatReturns(false, l2Calls)],
      l3Resolvers: [resolverThatReturns(true, l3Calls)],
    });

    const outcome = ladder.escalate(signal());

    expect(outcome).toEqual({ level: SupervisionLevel.L3FlorinaReasoning, resolved: true });
    expect(l2Calls).toHaveLength(2);
    expect(l3Calls).toHaveLength(1);
    expect(inbox.list()).toHaveLength(0);
  });

  it('creates exactly one attention item at L4 when every level declines', () => {
    const inbox = new AttentionInbox();
    const l2Calls: SupervisionSignal[] = [];
    const l3Calls: SupervisionSignal[] = [];
    const ladder = new SupervisionLadder({
      inbox,
      l2Resolvers: [resolverThatReturns(false, l2Calls)],
      l3Resolvers: [resolverThatReturns(false, l3Calls)],
    });

    const outcome = ladder.escalate(signal({ reason: 'retry ceiling exceeded' }));

    expect(outcome.level).toBe(SupervisionLevel.L4Human);
    expect(outcome.resolved).toBe(false);
    expect(outcome.attentionItem).toBeDefined();
    expect(inbox.list()).toHaveLength(1);
    expect(inbox.list()[0]!.payload['reason']).toBe('retry ceiling exceeded');
  });

  it('works with no resolvers configured (escalates straight to L4)', () => {
    const inbox = new AttentionInbox();
    const ladder = new SupervisionLadder({ inbox });
    const outcome = ladder.escalate(signal());
    expect(outcome.level).toBe(SupervisionLevel.L4Human);
    expect(inbox.list()).toHaveLength(1);
  });

  it('never creates more than one item across repeated unresolved calls for distinct signals', () => {
    const inbox = new AttentionInbox();
    const ladder = new SupervisionLadder({ inbox });
    ladder.escalate(signal({ taskId: 'task-a' }));
    ladder.escalate(signal({ taskId: 'task-b' }));
    // Two distinct signals -> two items, each still exactly one per signal.
    expect(inbox.list()).toHaveLength(2);
  });

  it('stops at the first resolver that resolves, never calling later resolvers in the same level', () => {
    const inbox = new AttentionInbox();
    const calls: string[] = [];
    const ladder = new SupervisionLadder({
      inbox,
      l2Resolvers: [
        { resolve: () => (calls.push('first'), true) },
        { resolve: () => (calls.push('second'), true) },
      ],
    });
    ladder.escalate(signal());
    expect(calls).toEqual(['first']);
  });
});
