import { describe, expect, it } from 'vitest';

import {
  FLORINA_CONTRACT_VERSION,
  renderFlorinaContract,
} from '../src/core/application/use-cases/prompting/florina-method.js';

// Canonical family: the 34 Flux skills (the `flux` router has no capability
// line — the contract block IS its compiled output). If the family grows,
// update this list; the count pin below catches silent drift.
const CAPABILITIES = [
  'accessibility',
  'audit',
  'brainstorm',
  'build',
  'checklist',
  'close-issue',
  'code',
  'decide',
  'define',
  'delivery',
  'design',
  'discovery',
  'docs',
  'evaluate',
  'frontend',
  'goal',
  'intent',
  'milestone',
  'plan',
  'prior-art',
  'pr-flow',
  'pr-review',
  'problem',
  'proof',
  'prototype',
  'research',
  'review',
  'test',
  'ui-test',
  'usability',
  'ux',
  'verify',
  'wayfind',
  'write',
];

describe('renderFlorinaContract (issue #286)', () => {
  const contract = renderFlorinaContract();

  it('is deterministic — repeated renders are identical', () => {
    expect(renderFlorinaContract()).toBe(contract);
    expect(renderFlorinaContract()).toBe(renderFlorinaContract());
  });

  it('embeds the exact exported contract version', () => {
    expect(FLORINA_CONTRACT_VERSION).toMatch(/^florina-method\/\d+\.\d+$/);
    // Journals pin this string — the rendered block must contain the
    // constant verbatim, not a paraphrase that can desync on a bump.
    expect(contract).toContain(FLORINA_CONTRACT_VERSION);
  });

  it('states the single goal: deliver the task working, with proof', () => {
    expect(contract).toMatch(/GOAL/);
    expect(contract).toMatch(/deliver the user's task working/i);
    expect(contract).toMatch(/proof/i);
  });

  it('lists every canonical capability as a line entry with a trigger', () => {
    for (const cap of CAPABILITIES) {
      // Line-anchored: the token at list position followed by a trigger —
      // substring checks let deletions hide inside other words.
      expect(contract).toMatch(new RegExp(`^ {2}${cap}\\s+— `, 'm'));
    }
  });

  it('pins the full family count so additions/removals cannot drift silently', () => {
    const lines = contract.match(/^ {2}\S+\s+— /gm) ?? [];
    expect(lines).toHaveLength(CAPABILITIES.length);
  });

  it('is non-prescriptive — no forced pipeline', () => {
    expect(contract).toMatch(/No fixed order/i);
    expect(contract).toMatch(/none mandatory/i);
    expect(contract).not.toMatch(/always run .{0,40}first/i);
    expect(contract).not.toMatch(/step 1/i);
  });

  it('signals repertoire over pipeline — capability list is alphabetical', () => {
    const lines = (contract.match(/^ {2}(\S+)\s+— /gm) ?? []).map((l) => l.trim().split(/\s+/)[0]);
    expect(lines).toEqual([...CAPABILITIES].sort());
  });

  it('marks capabilities as disciplines, not invocable commands', () => {
    expect(contract).toMatch(/disciplines, not commands/i);
  });

  it('carries the standing rules', () => {
    expect(contract).toContain('STANDING RULES');
    expect(contract).toMatch(/Evidence over assertion/i);
    expect(contract).toMatch(/escalate|surface/i);
    expect(contract).toMatch(/scope growth/i);
    expect(contract).toMatch(/done \/ incomplete \/ blocked \/ unsafe/i);
  });

  it('gives the escalation rule a non-interactive channel', () => {
    // Delegated runs have no interactive stdin — escalation must say
    // where the unresolved decision goes (the report), not "ask".
    expect(contract).toMatch(/surface[\s\S]{0,60}report/i);
    expect(contract).not.toMatch(/\bask the user\b/i);
  });

  it('stays inside the dispatch context budget (≤ 50 lines)', () => {
    expect(contract.split('\n').length).toBeLessThanOrEqual(50);
  });

  it('is brand-clean: no Flux branding, no machine-local paths', () => {
    expect(contract).not.toMatch(/flux/i);
    expect(contract).not.toContain('SKILL.md');
    expect(contract).not.toMatch(/[A-Z]:\\/); // single-backslash drive paths
    expect(contract).not.toMatch(/\\\\/); // UNC prefixes
    expect(contract).not.toMatch(/\/home\/|\/Users\//);
    expect(contract).not.toMatch(/codex|claude|agy|cursor|windsurf/i);
  });

  it('uses Florina naming', () => {
    expect(contract).toContain('Florina');
  });
});
