import { describe, it, expect } from 'vitest';
import { isInScope, detectOutOfScopeEdit } from '../src/core/application/use-cases/attention/scope-edit-trigger.js';
import { AttentionInbox } from '../src/core/application/use-cases/attention/attention-inbox.js';
import { SupervisionLadder, SupervisionLevel } from '../src/core/application/use-cases/attention/supervision-ladder.js';
import type { ExecutionBrief } from '../src/core/domain/execution-brief.js';

function brief(scopePaths?: readonly string[]): ExecutionBrief {
  return {
    objective: 'Fix the pagination bug.',
    relevantContext: [],
    applicableRules: [],
    constraints: ['Do not touch unrelated files.'],
    requiredVerification: ['npm test'],
    definitionOfDone: 'Bug fixed; tests pass.',
    providerRationale: 'Codex.',
    ...(scopePaths !== undefined ? { scopePaths } : {}),
  };
}

describe('isInScope', () => {
  it('matches an exact path', () => {
    expect(isInScope('src/core/pagination.ts', ['src/core/pagination.ts'])).toBe(true);
    expect(isInScope('src/core/other.ts', ['src/core/pagination.ts'])).toBe(false);
  });

  it('matches a directory wildcard (dir/**), including the directory itself', () => {
    expect(isInScope('src/core/domain/memory.ts', ['src/core/domain/**'])).toBe(true);
    expect(isInScope('src/core/domain', ['src/core/domain/**'])).toBe(true);
    expect(isInScope('src/adapters/foo.ts', ['src/core/domain/**'])).toBe(false);
    // Must not match a sibling directory that merely shares the prefix string.
    expect(isInScope('src/core/domain-extra/x.ts', ['src/core/domain/**'])).toBe(false);
  });

  it('matches a trailing prefix wildcard', () => {
    expect(isInScope('tests/pagination.test.ts', ['tests/pagination*'])).toBe(true);
    expect(isInScope('tests/other.test.ts', ['tests/pagination*'])).toBe(false);
  });
});

describe('detectOutOfScopeEdit', () => {
  it('does not signal when no scope was declared (undefined scopePaths)', () => {
    expect(detectOutOfScopeEdit('t1', ['src/anything.ts'], brief())).toBeNull();
  });

  it('does not signal when no scope was declared (empty scopePaths)', () => {
    expect(detectOutOfScopeEdit('t1', ['src/anything.ts'], brief([]))).toBeNull();
  });

  it('does not signal when every diff path is in scope', () => {
    const b = brief(['src/core/domain/**']);
    expect(detectOutOfScopeEdit('t1', ['src/core/domain/memory.ts'], b)).toBeNull();
  });

  it('signals with the specific out-of-scope paths when any diff path is outside scope', () => {
    const b = brief(['src/core/domain/**']);
    const signal = detectOutOfScopeEdit(
      't1',
      ['src/core/domain/memory.ts', 'src/unrelated/config.ts'],
      b,
    );
    expect(signal).not.toBeNull();
    expect(signal!.taskId).toBe('t1');
    expect(signal!.evidence!['outOfScopePaths']).toEqual(['src/unrelated/config.ts']);
  });
});

describe('out-of-scope edit feeding the supervision ladder (#213 integration)', () => {
  it('triggers L2 escalation, and is resolvable there without reaching L4', () => {
    const inbox = new AttentionInbox();
    const b = brief(['src/core/domain/**']);
    const signal = detectOutOfScopeEdit('t1', ['src/unrelated/config.ts'], b)!;
    const ladder = new SupervisionLadder({
      inbox,
      l2Resolvers: [{ resolve: () => true }], // e.g. manager reverts the out-of-scope hunk
    });
    const outcome = ladder.escalate(signal);
    expect(outcome.level).toBe(SupervisionLevel.L2ManagerReasoning);
    expect(inbox.list()).toHaveLength(0);
  });

  it('reaches L4 exactly once when L2 cannot resolve it', () => {
    const inbox = new AttentionInbox();
    const b = brief(['src/core/domain/**']);
    const signal = detectOutOfScopeEdit('t1', ['src/unrelated/config.ts'], b)!;
    const ladder = new SupervisionLadder({ inbox, l2Resolvers: [{ resolve: () => false }] });
    const outcome = ladder.escalate(signal);
    expect(outcome.level).toBe(SupervisionLevel.L4Human);
    expect(inbox.list()).toHaveLength(1);
  });
});
