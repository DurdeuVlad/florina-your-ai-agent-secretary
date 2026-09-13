import { describe, it, expect } from 'vitest';

import {
  buildCapabilityRequest,
  CapabilityRiskLevel,
  CapabilityType,
  type CapabilityRequest,
} from '../src/domain/capabilities.js';
import {
  ApprovalCardViewModel,
  CAPABILITY_LABELS,
  RISK_COLORS,
  RISK_LABELS,
} from '../src/desktop/views/approval-card.js';
import {
  renderApprovalCard,
  renderRiskBadge,
  renderCapabilityDetails,
  renderApprovalActions,
  renderRiskFactors,
} from '../src/desktop/views/approval-templates.js';
import type { ApprovalCardData, RenderTree } from '../src/desktop/views/approval-types.js';
import type { RenderTree as ViewRenderTree } from '../src/desktop/views/view-types.js';

/* ------------------------------------------------------------------ *
 * Test helpers
 * ------------------------------------------------------------------ */

const viewModel = new ApprovalCardViewModel();

/** Build a capability request with sensible defaults. */
function req(
  overrides: Partial<CapabilityRequest> & {
    capability?: CapabilityType;
    riskLevel?: CapabilityRiskLevel;
  } = {},
): CapabilityRequest {
  return buildCapabilityRequest({
    task: 'checkout-refactor',
    agent: 'codex',
    capability: overrides.capability ?? CapabilityType.Shell,
    destination: overrides.destination ?? '',
    command: overrides.command ?? 'npm install --production',
    workingDir: overrides.workingDir ?? '/repo/checkout-refactor',
    scope: overrides.scope,
    riskLevel: overrides.riskLevel ?? CapabilityRiskLevel.Medium,
    ...overrides,
  });
}

/** Recursively assert a value is JSON-serializable (no functions/symbols). */
function assertJsonSerializable(value: unknown, path = 'root'): void {
  if (value === null || value === undefined) return;
  const t = typeof value;
  if (t === 'function') {
    throw new Error(`Non-serializable function at ${path}`);
  }
  if (t === 'symbol') {
    throw new Error(`Non-serializable symbol at ${path}`);
  }
  if (t !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertJsonSerializable(v, `${path}[${i}]`));
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    assertJsonSerializable(v, `${path}.${k}`);
  }
}

/* ------------------------------------------------------------------ *
 * ApprovalCardViewModel.buildCard
 * ------------------------------------------------------------------ */

describe('ApprovalCardViewModel.buildCard', () => {
  it('transforms a shell CapabilityRequest into a display-ready card', () => {
    const request = req({
      capability: CapabilityType.Shell,
      command: 'npm install --production',
      destination: '',
      riskLevel: CapabilityRiskLevel.Medium,
    });
    const card = viewModel.buildCard(request);

    expect(card.capability).toBe(CapabilityType.Shell);
    expect(card.capabilityLabel).toBe('Shell');
    expect(card.command).toBe('npm install --production');
    expect(card.workingDir).toBe('/repo/checkout-refactor');
    expect(card.oneClickAllowed).toBe(true);
    expect(card.context.agentName).toBe('codex');
    expect(card.context.taskName).toBe('checkout-refactor');
    expect(card.request).toBe(request);
  });

  it('extracts and formats filesystem capability fields', () => {
    const request = req({
      capability: CapabilityType.Filesystem,
      destination: '/repo/checkout-refactor/src',
      command: '',
      riskLevel: CapabilityRiskLevel.Low,
    });
    const card = viewModel.buildCard(request);

    expect(card.capability).toBe(CapabilityType.Filesystem);
    expect(card.capabilityLabel).toBe('Filesystem');
    expect(card.destination).toBe('/repo/checkout-refactor/src');
    expect(card.riskAssessment.level).toBe(CapabilityRiskLevel.Low);
    expect(card.riskAssessment.color).toBe('green');
  });

  it('extracts and formats network capability fields', () => {
    const request = req({
      capability: CapabilityType.Network,
      destination: 'npmjs.org',
      command: '',
      riskLevel: CapabilityRiskLevel.Medium,
    });
    const card = viewModel.buildCard(request);

    expect(card.capability).toBe(CapabilityType.Network);
    expect(card.destination).toBe('npmjs.org');
    expect(card.riskAssessment.level).toBe(CapabilityRiskLevel.Medium);
    expect(card.riskAssessment.color).toBe('yellow');
  });

  it('extracts and formats git capability fields', () => {
    const request = req({
      capability: CapabilityType.Git,
      destination: 'origin',
      command: 'git pull',
      riskLevel: CapabilityRiskLevel.Medium,
    });
    const card = viewModel.buildCard(request);

    expect(card.capability).toBe(CapabilityType.Git);
    expect(card.command).toBe('git pull');
    expect(card.destination).toBe('origin');
  });

  it('copies scope boundaries into the card', () => {
    const request = req({
      capability: CapabilityType.Network,
      destination: 'npmjs.org',
      scope: [{ type: CapabilityType.Network, targets: ['npmjs.org', 'github.com'] }],
      riskLevel: CapabilityRiskLevel.Medium,
    });
    const card = viewModel.buildCard(request);

    expect(card.scope).toHaveLength(1);
    expect(card.scope[0].type).toBe(CapabilityType.Network);
    expect(card.scope[0].targets).toEqual(['npmjs.org', 'github.com']);
  });

  it('uses explicit context when provided, falling back to request fields', () => {
    const request = req({ agent: 'codex', task: 'checkout-refactor' });
    const card = viewModel.buildCard(request, {
      agentName: 'Codex',
      taskName: 'Checkout Refactor',
      sessionInfo: 'session-42',
    });

    expect(card.context.agentName).toBe('Codex');
    expect(card.context.taskName).toBe('Checkout Refactor');
    expect(card.context.sessionInfo).toBe('session-42');
  });

  it('falls back to request agent/task when context is omitted', () => {
    const request = req({ agent: 'claude-code', task: 'oauth-migration' });
    const card = viewModel.buildCard(request);

    expect(card.context.agentName).toBe('claude-code');
    expect(card.context.taskName).toBe('oauth-migration');
    expect(card.context.sessionInfo).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * Higher-authority capabilities (DEC-011)
 * ------------------------------------------------------------------ */

describe('higher-authority capabilities (DEC-011)', () => {
  const higherAuthority: CapabilityType[] = [
    CapabilityType.Git,
    CapabilityType.Secret,
    CapabilityType.Push,
    CapabilityType.Merge,
    CapabilityType.Deploy,
    CapabilityType.CreatePR,
    CapabilityType.Destructive,
  ];

  for (const capability of higherAuthority) {
    it(`disables one-click approval for ${capability}`, () => {
      const request = req({ capability, destination: 'origin', command: 'git push' });
      const card = viewModel.buildCard(request);
      expect(card.oneClickAllowed).toBe(false);
      expect(card.riskAssessment.recommendedAction).toMatch(/visual confirmation/i);
    });
  }

  it('allows one-click approval for non-higher-authority capabilities', () => {
    const request = req({ capability: CapabilityType.Shell });
    const card = viewModel.buildCard(request);
    expect(card.oneClickAllowed).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Risk assessment display for all risk levels
 * ------------------------------------------------------------------ */

describe('risk assessment display', () => {
  const cases: Array<{
    level: CapabilityRiskLevel;
    color: string;
    label: string;
  }> = [
    { level: CapabilityRiskLevel.Critical, color: 'red', label: 'Critical' },
    { level: CapabilityRiskLevel.High, color: 'orange', label: 'High' },
    { level: CapabilityRiskLevel.Medium, color: 'yellow', label: 'Medium' },
    { level: CapabilityRiskLevel.Low, color: 'green', label: 'Low' },
  ];

  for (const { level, color, label } of cases) {
    it(`renders ${label} risk with ${color} color`, () => {
      const request = req({ riskLevel: level });
      const card = viewModel.buildCard(request);
      expect(card.riskAssessment.level).toBe(level);
      expect(card.riskAssessment.color).toBe(color);
      expect(RISK_COLORS[level]).toBe(color);
      expect(RISK_LABELS[level]).toBe(label);
    });
  }

  it('includes the risk level as a factor', () => {
    const request = req({ riskLevel: CapabilityRiskLevel.High });
    const card = viewModel.buildCard(request);
    expect(card.riskAssessment.factors[0]).toMatch(/High risk level/i);
  });

  it('recommends denial for critical risk', () => {
    const request = req({ riskLevel: CapabilityRiskLevel.Critical });
    const card = viewModel.buildCard(request);
    expect(card.riskAssessment.recommendedAction).toMatch(/deny/i);
  });

  it('recommends review for high risk', () => {
    const request = req({ riskLevel: CapabilityRiskLevel.High });
    const card = viewModel.buildCard(request);
    expect(card.riskAssessment.recommendedAction).toMatch(/review/i);
  });

  it('recommends approval for low risk', () => {
    const request = req({ riskLevel: CapabilityRiskLevel.Low });
    const card = viewModel.buildCard(request);
    expect(card.riskAssessment.recommendedAction).toMatch(/low risk/i);
  });
});

/* ------------------------------------------------------------------ *
 * Human-readable summary generation
 * ------------------------------------------------------------------ */

describe('human-readable summary generation', () => {
  it('generates a shell execution summary', () => {
    const request = req({
      capability: CapabilityType.Shell,
      command: 'npm install --production',
      agent: 'codex',
    });
    const card = viewModel.buildCard(request, { agentName: 'Codex' });
    expect(card.summary).toBe('Codex wants to execute: npm install --production');
  });

  it('generates a network access summary', () => {
    const request = req({
      capability: CapabilityType.Network,
      destination: 'npmjs.org',
      command: '',
    });
    const card = viewModel.buildCard(request, { agentName: 'Codex' });
    expect(card.summary).toBe('Codex wants to access network: npmjs.org');
  });

  it('generates a filesystem access summary', () => {
    const request = req({
      capability: CapabilityType.Filesystem,
      destination: '/repo/src',
      command: '',
    });
    const card = viewModel.buildCard(request, { agentName: 'Claude' });
    expect(card.summary).toBe('Claude wants to access filesystem: /repo/src');
  });

  it('generates a git operation summary', () => {
    const request = req({
      capability: CapabilityType.Git,
      command: 'git pull',
      destination: 'origin',
    });
    const card = viewModel.buildCard(request, { agentName: 'Codex' });
    expect(card.summary).toBe('Codex wants to run a git operation: git pull');
  });

  it('generates a push summary', () => {
    const request = req({
      capability: CapabilityType.Push,
      destination: 'origin',
      command: 'git push',
    });
    const card = viewModel.buildCard(request, { agentName: 'Codex' });
    expect(card.summary).toBe('Codex wants to push to remote: origin');
  });

  it('falls back to request agent when context agentName is omitted', () => {
    const request = req({ agent: 'codex', capability: CapabilityType.Shell, command: 'ls' });
    const card = viewModel.buildCard(request);
    expect(card.summary).toBe('codex wants to execute: ls');
  });
});

/* ------------------------------------------------------------------ *
 * Risk factors
 * ------------------------------------------------------------------ */

describe('risk factors', () => {
  it('surfaces network destination as a factor', () => {
    const request = req({
      capability: CapabilityType.Network,
      destination: 'npmjs.org',
    });
    const card = viewModel.buildCard(request);
    expect(card.riskAssessment.factors).toContain('Network access to npmjs.org');
  });

  it('surfaces shell command as a factor', () => {
    const request = req({
      capability: CapabilityType.Shell,
      command: 'rm -rf /',
    });
    const card = viewModel.buildCard(request);
    expect(card.riskAssessment.factors).toContain('Shell command: rm -rf /');
  });

  it('surfaces higher-authority factor for push', () => {
    const request = req({
      capability: CapabilityType.Push,
      destination: 'origin',
      command: 'git push',
    });
    const card = viewModel.buildCard(request);
    expect(card.riskAssessment.factors.some((f) => f.includes('higher authority'))).toBe(true);
  });

  it('surfaces scope target count as a factor', () => {
    const request = req({
      capability: CapabilityType.Network,
      destination: 'npmjs.org',
      scope: [{ type: CapabilityType.Network, targets: ['npmjs.org', 'github.com'] }],
    });
    const card = viewModel.buildCard(request);
    expect(card.riskAssessment.factors).toContain('Scope covers 2 targets');
  });
});

/* ------------------------------------------------------------------ *
 * Template functions
 * ------------------------------------------------------------------ */

describe('template functions', () => {
  const request = req({
    capability: CapabilityType.Shell,
    command: 'npm install --production',
    destination: '',
    riskLevel: CapabilityRiskLevel.Medium,
  });
  const card = viewModel.buildCard(request, { agentName: 'Codex' });

  it('renderApprovalCard produces a serializable RenderTree', () => {
    const tree = renderApprovalCard(card);
    expect(tree.tag).toBe('ApprovalCard');
    expect(tree.children).toBeDefined();
    expect(tree.children!.length).toBeGreaterThan(0);
    assertJsonSerializable(tree);
  });

  it('renderRiskBadge produces a colored badge for each risk level', () => {
    const levels: CapabilityRiskLevel[] = [
      CapabilityRiskLevel.Critical,
      CapabilityRiskLevel.High,
      CapabilityRiskLevel.Medium,
      CapabilityRiskLevel.Low,
    ];
    for (const level of levels) {
      const badge = renderRiskBadge(level);
      expect(badge.tag).toBe('RiskBadge');
      expect(badge.props!.riskLevel).toBe(level);
      expect(badge.props!.color).toBe(RISK_COLORS[level]);
    }
  });

  it('renderCapabilityDetails surfaces all structured fields', () => {
    const details = renderCapabilityDetails(card);
    expect(details.tag).toBe('CapabilityDetails');
    const labels = JSON.stringify(details).match(/"Capability"/g);
    expect(labels).not.toBeNull();
    // Should contain capability, destination, command, working dir, scope.
    const serialized = JSON.stringify(details);
    expect(serialized).toContain('Capability');
    expect(serialized).toContain('Destination');
    expect(serialized).toContain('Command');
    expect(serialized).toContain('Working directory');
    expect(serialized).toContain('Scope');
  });

  it('renderApprovalActions produces grant, deny, inspect buttons', () => {
    const actions = renderApprovalActions(card);
    expect(actions.tag).toBe('ApprovalActions');
    const buttons = actions.children as ViewRenderTree[];
    expect(buttons).toHaveLength(3);
    const commands = buttons.map((b) => b.props!.command as string);
    expect(commands.some((c) => c.startsWith('approval:grant:'))).toBe(true);
    expect(commands.some((c) => c.startsWith('approval:deny:'))).toBe(true);
    expect(commands.some((c) => c.startsWith('approval:inspect:'))).toBe(true);
  });

  it('disables the grant button for higher-authority capabilities', () => {
    const pushCard = viewModel.buildCard(
      req({ capability: CapabilityType.Push, destination: 'origin', command: 'git push' }),
      { agentName: 'Codex' },
    );
    const actions = renderApprovalActions(pushCard);
    const buttons = actions.children as ViewRenderTree[];
    const grant = buttons[0];
    expect(grant.props!.disabled).toBe(true);
    expect(grant.children![0]).toBe('Confirm visually');
  });

  it('disables one-click approval and grant button for Git (StrongDevice)', () => {
    const gitCard = viewModel.buildCard(
      req({ capability: CapabilityType.Git, destination: 'origin', command: 'git pull' }),
      { agentName: 'Codex' },
    );
    expect(gitCard.oneClickAllowed).toBe(false);
    expect(gitCard.riskAssessment.recommendedAction).toMatch(/visual confirmation/i);
    const actions = renderApprovalActions(gitCard);
    const buttons = actions.children as ViewRenderTree[];
    const grant = buttons[0];
    expect(grant.props!.disabled).toBe(true);
    expect(grant.children![0]).toBe('Confirm visually');
  });

  it('disables one-click approval and grant button for Secret (StrongDevice)', () => {
    const secretCard = viewModel.buildCard(
      req({ capability: CapabilityType.Secret, destination: 'vault://prod/db' }),
      { agentName: 'Codex' },
    );
    expect(secretCard.oneClickAllowed).toBe(false);
    expect(secretCard.riskAssessment.recommendedAction).toMatch(/visual confirmation/i);
    const actions = renderApprovalActions(secretCard);
    const buttons = actions.children as ViewRenderTree[];
    const grant = buttons[0];
    expect(grant.props!.disabled).toBe(true);
    expect(grant.children![0]).toBe('Confirm visually');
  });

  it('renderRiskFactors renders a list of factors', () => {
    const factors = ['High risk level', 'Shell command: rm -rf /'];
    const tree = renderRiskFactors(factors);
    expect(tree.tag).toBe('RiskFactors');
    expect(tree.children!.length).toBe(2);
    assertJsonSerializable(tree);
  });

  it('renderRiskFactors handles empty factor list', () => {
    const tree = renderRiskFactors([]);
    expect(tree.tag).toBe('RiskFactors');
    expect(tree.children!.length).toBe(1);
  });

  it('all templates produce JSON-serializable trees', () => {
    assertJsonSerializable(renderApprovalCard(card));
    assertJsonSerializable(renderRiskBadge(CapabilityRiskLevel.High));
    assertJsonSerializable(renderCapabilityDetails(card));
    assertJsonSerializable(renderApprovalActions(card));
    assertJsonSerializable(renderRiskFactors(card.riskAssessment.factors));
  });
});

/* ------------------------------------------------------------------ *
 * Action button command identifiers
 * ------------------------------------------------------------------ */

describe('action button command identifiers', () => {
  it('grant command follows approval:grant:<capability>:<destination>', () => {
    const card = viewModel.buildCard(
      req({ capability: CapabilityType.Network, destination: 'npmjs.org' }),
    );
    const actions = renderApprovalActions(card);
    const buttons = actions.children as ViewRenderTree[];
    const grant = buttons.find((b) => (b.props!.command as string).startsWith('approval:grant:'));
    expect(grant).toBeDefined();
    expect(grant!.props!.command).toBe('approval:grant:network:npmjs.org');
  });

  it('deny command follows approval:deny:<capability>:<destination>', () => {
    const card = viewModel.buildCard(req({ capability: CapabilityType.Shell, destination: '' }));
    const actions = renderApprovalActions(card);
    const buttons = actions.children as ViewRenderTree[];
    const deny = buttons.find((b) => (b.props!.command as string).startsWith('approval:deny:'));
    expect(deny).toBeDefined();
    expect(deny!.props!.command).toBe('approval:deny:shell:');
  });

  it('inspect command follows approval:inspect:<capability>:<destination>', () => {
    const card = viewModel.buildCard(
      req({ capability: CapabilityType.Git, destination: 'origin' }),
    );
    const actions = renderApprovalActions(card);
    const buttons = actions.children as ViewRenderTree[];
    const inspect = buttons.find((b) =>
      (b.props!.command as string).startsWith('approval:inspect:'),
    );
    expect(inspect).toBeDefined();
    expect(inspect!.props!.command).toBe('approval:inspect:git:origin');
  });
});

/* ------------------------------------------------------------------ *
 * JSON serializability
 * ------------------------------------------------------------------ */

describe('JSON serializability', () => {
  it('ApprovalCardData is JSON-serializable', () => {
    const request = req({
      capability: CapabilityType.Push,
      destination: 'origin',
      command: 'git push',
      riskLevel: CapabilityRiskLevel.High,
    });
    const card = viewModel.buildCard(request, { agentName: 'Codex' });
    assertJsonSerializable(card);
    const json = JSON.stringify(card);
    expect(json).toContain('ApprovalCardData'.replace('ApprovalCardData', 'request'));
    // Round-trip through JSON.
    const parsed = JSON.parse(json) as ApprovalCardData;
    expect(parsed.capability).toBe(CapabilityType.Push);
    expect(parsed.riskAssessment.color).toBe('orange');
  });

  it('a full rendered card survives JSON round-trip', () => {
    const request = req({
      capability: CapabilityType.Network,
      destination: 'npmjs.org',
      riskLevel: CapabilityRiskLevel.Medium,
    });
    const card = viewModel.buildCard(request, { agentName: 'Codex' });
    const tree = renderApprovalCard(card);
    const json = JSON.stringify(tree);
    const parsed = JSON.parse(json) as RenderTree;
    expect(parsed.tag).toBe('ApprovalCard');
    expect(parsed.children).toBeDefined();
  });

  it('CAPABILITY_LABELS covers every capability type', () => {
    const allTypes: CapabilityType[] = [
      CapabilityType.Filesystem,
      CapabilityType.Network,
      CapabilityType.Shell,
      CapabilityType.Git,
      CapabilityType.Secret,
      CapabilityType.Push,
      CapabilityType.Merge,
      CapabilityType.Deploy,
      CapabilityType.CreatePR,
      CapabilityType.Destructive,
      CapabilityType.Other,
    ];
    for (const t of allTypes) {
      expect(CAPABILITY_LABELS[t]).toBeTruthy();
    }
  });
});
