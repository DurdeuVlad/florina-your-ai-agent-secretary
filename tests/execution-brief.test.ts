import { describe, it, expect } from 'vitest';
import { compileExecutionBrief } from '../src/core/application/use-cases/memory/execution-brief.js';
import type { MemoryItem } from '../src/core/domain/memory.js';

function item(overrides: Partial<MemoryItem> & Pick<MemoryItem, 'id' | 'kind' | 'statement'>): MemoryItem {
  return {
    scope: { type: 'global' },
    provenance: 'explicit',
    confidence: 'high',
    status: 'active',
    createdAt: '2026-09-21T00:00:00.000Z',
    updatedAt: '2026-09-21T00:00:00.000Z',
    ...overrides,
  };
}

describe('compileExecutionBrief — worked example (docs §6.3)', () => {
  it('"Fix this TypeScript API bug" surfaces exactly the bugfix/verification/global-dev rules', () => {
    const scopedDiff = item({
      id: 'r-scoped-diff',
      kind: 'rule',
      statement: 'Keep bug fixes scoped to the reported file/root cause.',
      tags: ['bugfix'],
    });
    const reproduceFirst = item({
      id: 'r-reproduce-first',
      kind: 'rule',
      statement: 'Reproduce the problem before changing code.',
      tags: ['bugfix'],
    });
    const doneMeansProven = item({
      id: 'r-verification',
      kind: 'hard-policy',
      statement: 'A task may not surface as done without verification evidence (DEC-032).',
      tags: ['verification'],
    });
    const inspectConventions = item({
      id: 'r-conventions',
      kind: 'rule',
      statement: 'Inspect existing conventions before adding abstractions.',
      tags: ['global-dev'],
    });
    // Unrelated rules — must NOT be surfaced for this request.
    const frontendResearch = item({
      id: 'r-frontend',
      kind: 'rule',
      statement: 'Research comparable products before frontend UX changes.',
      tags: ['frontend-research-first'],
    });
    const deployApproval = item({
      id: 'r-deploy',
      kind: 'hard-policy',
      statement: 'Never deploy without approval.',
      tags: ['deploy-approval'],
    });
    const hexArchitecture = item({
      id: 'k-hex-arch',
      kind: 'project-knowledge',
      statement: "This project uses hexagonal architecture; new code goes in src/core.",
      scope: { type: 'project', projectId: 'proj-1' },
      tags: ['global-dev'],
    });

    const brief = compileExecutionBrief(
      {
        taskId: 'task-1',
        projectId: 'proj-1',
        objective: 'Fix this TypeScript API bug.',
        topics: ['bugfix', 'verification', 'global-dev'],
      },
      [
        scopedDiff,
        reproduceFirst,
        doneMeansProven,
        inspectConventions,
        frontendResearch,
        deployApproval,
        hexArchitecture,
      ],
    );

    const ruleIds = brief.applicableRules.map((r) => r.id).sort();
    expect(ruleIds).toEqual(
      ['r-conventions', 'r-reproduce-first', 'r-scoped-diff', 'r-verification'].sort(),
    );
    expect(ruleIds).not.toContain('r-frontend');
    expect(ruleIds).not.toContain('r-deploy');
    expect(brief.relevantContext).toContain(hexArchitecture.statement);
    expect(brief.objective).toBe('Fix this TypeScript API bug.');
  });
});

describe('compileExecutionBrief — scope filter', () => {
  it('drops project-scoped rules from a different project', () => {
    const otherProjectRule = item({
      id: 'r-other',
      kind: 'rule',
      statement: 'Only for proj-2.',
      scope: { type: 'project', projectId: 'proj-2' },
      tags: ['bugfix'],
    });
    const brief = compileExecutionBrief(
      { taskId: 't1', projectId: 'proj-1', objective: 'x', topics: ['bugfix'] },
      [otherProjectRule],
    );
    expect(brief.applicableRules).toHaveLength(0);
  });

  it('drops inactive items regardless of tag match', () => {
    const candidateRule = item({
      id: 'r-candidate',
      kind: 'rule',
      statement: 'Not yet confirmed.',
      status: 'candidate',
      tags: ['bugfix'],
    });
    const brief = compileExecutionBrief(
      { taskId: 't1', objective: 'x', topics: ['bugfix'] },
      [candidateRule],
    );
    expect(brief.applicableRules).toHaveLength(0);
  });
});

describe('compileExecutionBrief — same-tag rules that do not conflict', () => {
  it('keeps both when they share a tag but have no conflictsWith link', () => {
    const a = item({ id: 'r-a', kind: 'rule', statement: 'Reproduce first.', tags: ['bugfix'] });
    const b = item({ id: 'r-b', kind: 'rule', statement: 'Keep it scoped.', tags: ['bugfix'] });
    const brief = compileExecutionBrief({ taskId: 't1', objective: 'x', topics: ['bugfix'] }, [a, b]);
    expect(brief.applicableRules.map((r) => r.id).sort()).toEqual(['r-a', 'r-b']);
  });
});

describe('compileExecutionBrief — conflict resolution (explicit conflictsWith links)', () => {
  it('explicit beats inferred-repeated when the two are marked conflicting', () => {
    const explicitRule = item({
      id: 'r-explicit',
      kind: 'rule',
      statement: 'Prefer Sonnet.',
      provenance: 'explicit',
      tags: ['provider-choice'],
      conflictsWith: ['r-inferred'],
    });
    const inferredRule = item({
      id: 'r-inferred',
      kind: 'rule',
      statement: 'Prefer Codex.',
      provenance: 'inferred-repeated',
      tags: ['provider-choice'],
    });
    const brief = compileExecutionBrief(
      { taskId: 't1', objective: 'x', topics: ['provider-choice'] },
      [inferredRule, explicitRule],
    );
    expect(brief.applicableRules.map((r) => r.id)).toEqual(['r-explicit']);
  });

  it('project-scoped beats global when marked conflicting and provenance ties', () => {
    const globalRule = item({
      id: 'r-global',
      kind: 'rule',
      statement: 'Global default.',
      scope: { type: 'global' },
      tags: ['provider-choice'],
    });
    const projectRule = item({
      id: 'r-project',
      kind: 'rule',
      statement: 'Project override.',
      scope: { type: 'project', projectId: 'proj-1' },
      tags: ['provider-choice'],
      conflictsWith: ['r-global'],
    });
    const brief = compileExecutionBrief(
      { taskId: 't1', projectId: 'proj-1', objective: 'x', topics: ['provider-choice'] },
      [globalRule, projectRule],
    );
    expect(brief.applicableRules.map((r) => r.id)).toEqual(['r-project']);
  });

  it('most recent wins remaining ties when marked conflicting', () => {
    const older = item({
      id: 'r-older',
      kind: 'rule',
      statement: 'Old rule.',
      tags: ['bugfix'],
      updatedAt: '2026-09-01T00:00:00.000Z',
    });
    const newer = item({
      id: 'r-newer',
      kind: 'rule',
      statement: 'New rule.',
      tags: ['bugfix'],
      updatedAt: '2026-09-20T00:00:00.000Z',
      conflictsWith: ['r-older'],
    });
    const brief = compileExecutionBrief(
      { taskId: 't1', objective: 'x', topics: ['bugfix'] },
      [older, newer],
    );
    expect(brief.applicableRules.map((r) => r.id)).toEqual(['r-newer']);
  });

  it('never drops a tag-matched hard policy, even when marked conflicting with a higher-ranked rule', () => {
    const hardPolicy = item({
      id: 'r-hard',
      kind: 'hard-policy',
      statement: 'Never X.',
      provenance: 'explicit',
      tags: ['security'],
    });
    const explicitRule = item({
      id: 'r-explicit-security',
      kind: 'rule',
      statement: 'Do Y.',
      provenance: 'explicit',
      tags: ['security'],
      updatedAt: '2026-09-20T00:00:00.000Z',
      conflictsWith: ['r-hard'],
    });
    const brief = compileExecutionBrief(
      { taskId: 't1', objective: 'x', topics: ['security'] },
      [hardPolicy, explicitRule],
    );
    const ids = brief.applicableRules.map((r) => r.id);
    expect(ids).toContain('r-hard');
    expect(ids).not.toContain('r-explicit-security');
  });
});
