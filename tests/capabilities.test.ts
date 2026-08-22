import { describe, it, expect } from 'vitest';
import {
  CapabilityType,
  CapabilityRiskLevel,
  CAPABILITY_TYPE_VALUES,
  CAPABILITY_RISK_LEVEL_VALUES,
  buildCapabilityRequest,
  buildCapabilityApproval,
  type CapabilityRequest,
} from '../src/domain/capabilities.js';
import {
  buildPolicy,
  evaluatePolicy,
  applyLlmRecommendation,
  evaluateWithLlm,
  type Policy,
  type PolicyDecision,
} from '../src/domain/policy.js';
import {
  checkAuthority,
  requiredAuthorityFor,
  canApproveViaVoice,
  CAPABILITY_AUTHORITY_REQUIREMENTS,
  AUTHORITY_LEVEL_ORDER,
  authorityRank,
} from '../src/domain/approval.js';
import { ApprovalAuthorityLevel } from '../src/domain/enums.js';

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** A minimal low-risk filesystem read request. */
function readRequest(overrides: Partial<CapabilityRequest> = {}): CapabilityRequest {
  return buildCapabilityRequest({
    task: 'Read logs',
    agent: 'codex',
    capability: CapabilityType.Filesystem,
    destination: '/var/log/app.log',
    command: 'cat /var/log/app.log',
    workingDir: '/repo',
    riskLevel: CapabilityRiskLevel.Low,
    ...overrides,
  });
}

/** A network request (npm install) — requires authenticated UI. */
function networkRequest(overrides: Partial<CapabilityRequest> = {}): CapabilityRequest {
  return buildCapabilityRequest({
    task: 'Install deps',
    agent: 'codex',
    capability: CapabilityType.Network,
    destination: 'registry.npmjs.org',
    command: 'npm install',
    workingDir: '/repo',
    riskLevel: CapabilityRiskLevel.Low,
    ...overrides,
  });
}

/** A permissive project policy that auto-approves low-risk filesystem reads. */
function permissiveProjectPolicy(): Policy {
  return {
    projectId: 'proj-1',
    allowAutoApproval: true,
    projectRules: [
      {
        name: 'auto-approve-low-risk-filesystem',
        capabilityPattern: [CapabilityType.Filesystem],
        riskLevels: [CapabilityRiskLevel.Low],
        autoApprove: { maxRiskLevel: CapabilityRiskLevel.Low, oneTimeOnly: true },
        decision: 'allow',
      },
      {
        name: 'deny-critical',
        riskLevels: [CapabilityRiskLevel.Critical],
        decision: 'deny',
      },
    ],
    taskRules: [],
  };
}

/* ------------------------------------------------------------------ *
 * CapabilityRequest (DEC-010)
 * ------------------------------------------------------------------ */

describe('CapabilityRequest (DEC-010)', () => {
  it('carries all structured fields: task, agent, capability, destination, command, workingDir, scope, riskLevel', () => {
    const req = readRequest();
    expect(req.task).toBe('Read logs');
    expect(req.agent).toBe('codex');
    expect(req.capability).toBe(CapabilityType.Filesystem);
    expect(req.destination).toBe('/var/log/app.log');
    expect(req.command).toBe('cat /var/log/app.log');
    expect(req.workingDir).toBe('/repo');
    expect(req.scope).toBeInstanceOf(Array);
    expect(req.scope.length).toBeGreaterThan(0);
    expect(req.riskLevel).toBe(CapabilityRiskLevel.Low);
  });

  it('scope defaults to a single entry matching capability/destination', () => {
    const req = networkRequest();
    expect(req.scope).toEqual([{ type: CapabilityType.Network, targets: ['registry.npmjs.org'] }]);
  });

  it('CapabilityType enum includes the extended vocabulary (push, merge, deploy, createPR, ...)', () => {
    expect(CAPABILITY_TYPE_VALUES).toContain(CapabilityType.Push);
    expect(CAPABILITY_TYPE_VALUES).toContain(CapabilityType.Merge);
    expect(CAPABILITY_TYPE_VALUES).toContain(CapabilityType.Deploy);
    expect(CAPABILITY_TYPE_VALUES).toContain(CapabilityType.CreatePR);
    expect(CAPABILITY_TYPE_VALUES).toContain(CapabilityType.Destructive);
    // Original event-level kinds are preserved.
    expect(CAPABILITY_TYPE_VALUES).toContain(CapabilityType.Filesystem);
    expect(CAPABILITY_TYPE_VALUES).toContain(CapabilityType.Network);
    expect(CAPABILITY_TYPE_VALUES).toContain(CapabilityType.Shell);
  });

  it('CapabilityRiskLevel enum covers low, medium, high, critical', () => {
    expect(CAPABILITY_RISK_LEVEL_VALUES).toEqual(['low', 'medium', 'high', 'critical']);
  });
});

/* ------------------------------------------------------------------ *
 * Approval (DEC-010)
 * ------------------------------------------------------------------ */

describe('CapabilityApproval (DEC-010)', () => {
  it('records the exact capability authorized and the authority level used', () => {
    const req = networkRequest();
    const approval = buildCapabilityApproval({
      taskId: 'task-42',
      capability: req,
      approvedBy: 'user-vlad',
      authorityLevelUsed: ApprovalAuthorityLevel.AuthenticatedUI,
      granted: true,
    });
    expect(approval.capability).toBe(req);
    expect(approval.capability.capability).toBe(CapabilityType.Network);
    expect(approval.capability.destination).toBe('registry.npmjs.org');
    expect(approval.authorityLevelUsed).toBe(ApprovalAuthorityLevel.AuthenticatedUI);
    expect(approval.approvedBy).toBe('user-vlad');
    expect(approval.granted).toBe(true);
    expect(approval.taskId).toBe('task-42');
    expect(typeof approval.timestamp).toBe('string');
    expect(approval.id).toBeTruthy();
  });

  it('defaults to granted=false (never silently widen — DEC-011)', () => {
    const approval = buildCapabilityApproval({
      taskId: 'task-1',
      capability: readRequest(),
      approvedBy: 'user',
      authorityLevelUsed: ApprovalAuthorityLevel.AuthenticatedUI,
    });
    expect(approval.granted).toBe(false);
    expect(approval.duration).toBe('one-time');
  });

  it('records the authority level used for each approval rung (auditability)', () => {
    const levels = AUTHORITY_LEVEL_ORDER;
    for (const level of levels) {
      const approval = buildCapabilityApproval({
        taskId: 'task-1',
        capability: readRequest(),
        approvedBy: 'user',
        authorityLevelUsed: level,
        granted: true,
      });
      expect(approval.authorityLevelUsed).toBe(level);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Policy engine (DEC-007, DEC-011)
 * ------------------------------------------------------------------ */

describe('Policy engine (DEC-007, DEC-011)', () => {
  it('allows a request when an auto-approve rule matches', () => {
    const policy = permissiveProjectPolicy();
    const result = evaluatePolicy(readRequest(), policy);
    expect(result.decision).toBe('allow');
    expect(result.autoApproved).toBe(true);
    expect(result.matchedRule?.name).toBe('auto-approve-low-risk-filesystem');
  });

  it('denies a request when a deny rule matches', () => {
    const policy = permissiveProjectPolicy();
    const critical = readRequest({ riskLevel: CapabilityRiskLevel.Critical });
    const result = evaluatePolicy(critical, policy);
    expect(result.decision).toBe('deny');
    expect(result.autoApproved).toBe(false);
  });

  it('escalates to human when no rule matches (never silently allow)', () => {
    const policy = buildPolicy('proj-1');
    const result = evaluatePolicy(networkRequest(), policy);
    expect(result.decision).toBe('escalate');
    expect(result.autoApproved).toBe(false);
  });

  it('does not auto-approve when allowAutoApproval master switch is off', () => {
    const policy = permissiveProjectPolicy();
    policy.allowAutoApproval = false;
    const result = evaluatePolicy(readRequest(), policy);
    // Auto-approve disabled -> falls back to the rule's decision (allow), but
    // not auto-approved.
    expect(result.decision).toBe('allow');
    expect(result.autoApproved).toBe(false);
  });

  it('does not auto-approve when risk exceeds maxRiskLevel', () => {
    const policy = permissiveProjectPolicy();
    const medium = readRequest({ riskLevel: CapabilityRiskLevel.Medium });
    const result = evaluatePolicy(medium, policy);
    // Medium > Low maxRiskLevel -> auto-approve does not fire; rule decision
    // is 'allow' but not auto-approved.
    expect(result.autoApproved).toBe(false);
  });

  it('is configurable per project (DEC-007)', () => {
    const permissive = permissiveProjectPolicy();
    expect(evaluatePolicy(readRequest(), permissive).decision).toBe('allow');

    const restrictive: Policy = {
      projectId: 'proj-2',
      allowAutoApproval: false,
      projectRules: [
        {
          name: 'deny-all-filesystem',
          capabilityPattern: [CapabilityType.Filesystem],
          decision: 'deny',
        },
      ],
      taskRules: [],
    };
    expect(evaluatePolicy(readRequest(), restrictive).decision).toBe('deny');
  });

  it('is configurable per task, and task rules narrow but never widen (DEC-007/DEC-011)', () => {
    // Project allows filesystem reads; task rule denies them -> deny wins.
    const policy = permissiveProjectPolicy();
    policy.taskRules = [
      {
        name: 'task-deny-filesystem',
        capabilityPattern: [CapabilityType.Filesystem],
        decision: 'deny',
      },
    ];
    const result = evaluatePolicy(readRequest(), policy);
    expect(result.decision).toBe('deny');

    // Project denies critical; task rule allows critical -> still deny
    // (task cannot widen).
    const policy2 = permissiveProjectPolicy();
    policy2.taskRules = [
      {
        name: 'task-allow-critical',
        riskLevels: [CapabilityRiskLevel.Critical],
        decision: 'allow',
      },
    ];
    const critical = readRequest({ riskLevel: CapabilityRiskLevel.Critical });
    const result2 = evaluatePolicy(critical, policy2);
    expect(result2.decision).toBe('deny');
  });
});

/* ------------------------------------------------------------------ *
 * DEC-011: LLM risk assessment cannot override a lower-layer deny
 * ------------------------------------------------------------------ */

describe('DEC-011 security hierarchy — LLM cannot override a deny', () => {
  it('a policy deny stays deny regardless of an LLM "allow" recommendation', () => {
    expect(applyLlmRecommendation('deny', 'allow')).toBe('deny');
    expect(applyLlmRecommendation('deny', 'escalate')).toBe('deny');
    expect(applyLlmRecommendation('deny', 'deny')).toBe('deny');
  });

  it('escalation only goes UP — an LLM "allow" cannot turn escalate into allow', () => {
    expect(applyLlmRecommendation('escalate', 'allow')).toBe('escalate');
    expect(applyLlmRecommendation('escalate', 'escalate')).toBe('escalate');
    expect(applyLlmRecommendation('escalate', 'deny')).toBe('deny');
  });

  it('an LLM can narrow an allow to escalate or deny, but never widen', () => {
    expect(applyLlmRecommendation('allow', 'allow')).toBe('allow');
    expect(applyLlmRecommendation('allow', 'escalate')).toBe('escalate');
    expect(applyLlmRecommendation('allow', 'deny')).toBe('deny');
  });

  it('end-to-end: a denied critical request stays denied even if the LLM says safe', () => {
    const policy = permissiveProjectPolicy();
    const critical = readRequest({ riskLevel: CapabilityRiskLevel.Critical });
    const result = evaluateWithLlm(critical, policy, 'allow');
    expect(result.decision).toBe('deny');
  });

  it('end-to-end: an escalated request is not auto-approved by an LLM "safe" verdict', () => {
    const policy = buildPolicy('proj-1'); // no rules -> escalate
    const result = evaluateWithLlm(networkRequest(), policy, 'allow');
    expect(result.decision).toBe('escalate');
  });
});

/* ------------------------------------------------------------------ *
 * Approval authority levels & escalation path
 * ------------------------------------------------------------------ */

describe('Approval authority levels & escalation path', () => {
  it('authority levels are ordered weakest to strongest', () => {
    expect(authorityRank(ApprovalAuthorityLevel.VoiceOnly)).toBe(0);
    expect(authorityRank(ApprovalAuthorityLevel.VoiceScopedPhrase)).toBe(1);
    expect(authorityRank(ApprovalAuthorityLevel.AuthenticatedUI)).toBe(2);
    expect(authorityRank(ApprovalAuthorityLevel.StrongDevice)).toBe(3);
  });

  it('every capability type has a required authority level', () => {
    for (const cap of CAPABILITY_TYPE_VALUES) {
      const required = requiredAuthorityFor(cap);
      expect(AUTHORITY_LEVEL_ORDER).toContain(required);
    }
  });

  it('checkAuthority returns allowed when authority is at or above required', () => {
    // Filesystem requires voiceScopedPhrase.
    expect(
      checkAuthority(CapabilityType.Filesystem, ApprovalAuthorityLevel.VoiceScopedPhrase),
    ).toBe('allowed');
    expect(checkAuthority(CapabilityType.Filesystem, ApprovalAuthorityLevel.AuthenticatedUI)).toBe(
      'allowed',
    );
    expect(checkAuthority(CapabilityType.Filesystem, ApprovalAuthorityLevel.StrongDevice)).toBe(
      'allowed',
    );
    // Network requires authenticatedUI.
    expect(checkAuthority(CapabilityType.Network, ApprovalAuthorityLevel.AuthenticatedUI)).toBe(
      'allowed',
    );
    expect(checkAuthority(CapabilityType.Network, ApprovalAuthorityLevel.StrongDevice)).toBe(
      'allowed',
    );
    // Merge requires strongDevice.
    expect(checkAuthority(CapabilityType.Merge, ApprovalAuthorityLevel.StrongDevice)).toBe(
      'allowed',
    );
  });

  it('covers each authority level in the escalation path', () => {
    // voiceOnly -> denied for every capability (voice-only does read/status/pause).
    for (const cap of CAPABILITY_TYPE_VALUES) {
      expect(checkAuthority(cap, ApprovalAuthorityLevel.VoiceOnly)).toBe('denied');
    }
    // voiceScopedPhrase below required -> stageToVisual.
    expect(checkAuthority(CapabilityType.Network, ApprovalAuthorityLevel.VoiceScopedPhrase)).toBe(
      'stageToVisual',
    );
    expect(checkAuthority(CapabilityType.Merge, ApprovalAuthorityLevel.VoiceScopedPhrase)).toBe(
      'stageToVisual',
    );
    // authenticatedUI below strongDevice requirement -> denied (must escalate
    // to a stronger device, not merely a visual card).
    expect(checkAuthority(CapabilityType.Merge, ApprovalAuthorityLevel.AuthenticatedUI)).toBe(
      'denied',
    );
    expect(checkAuthority(CapabilityType.Deploy, ApprovalAuthorityLevel.AuthenticatedUI)).toBe(
      'denied',
    );
  });
});

/* ------------------------------------------------------------------ *
 * Voice approval boundaries (PRODUCT_DESIGN.md "Voice Experience")
 * ------------------------------------------------------------------ */

describe('Voice approval boundaries', () => {
  it('voice-only cannot approve any capability', () => {
    for (const cap of CAPABILITY_TYPE_VALUES) {
      expect(checkAuthority(cap, ApprovalAuthorityLevel.VoiceOnly)).toBe('denied');
    }
  });

  it('push/PR/network requires authenticated UI (voice+scoped stages to visual)', () => {
    expect(checkAuthority(CapabilityType.Push, ApprovalAuthorityLevel.VoiceScopedPhrase)).toBe(
      'stageToVisual',
    );
    expect(checkAuthority(CapabilityType.CreatePR, ApprovalAuthorityLevel.VoiceScopedPhrase)).toBe(
      'stageToVisual',
    );
    expect(checkAuthority(CapabilityType.Network, ApprovalAuthorityLevel.VoiceScopedPhrase)).toBe(
      'stageToVisual',
    );
    // Authenticated UI is sufficient.
    expect(checkAuthority(CapabilityType.Push, ApprovalAuthorityLevel.AuthenticatedUI)).toBe(
      'allowed',
    );
    expect(checkAuthority(CapabilityType.CreatePR, ApprovalAuthorityLevel.AuthenticatedUI)).toBe(
      'allowed',
    );
  });

  it('merge/deploy requires strong device (authenticated UI is denied)', () => {
    expect(checkAuthority(CapabilityType.Merge, ApprovalAuthorityLevel.AuthenticatedUI)).toBe(
      'denied',
    );
    expect(checkAuthority(CapabilityType.Deploy, ApprovalAuthorityLevel.AuthenticatedUI)).toBe(
      'denied',
    );
    expect(checkAuthority(CapabilityType.Merge, ApprovalAuthorityLevel.StrongDevice)).toBe(
      'allowed',
    );
    expect(checkAuthority(CapabilityType.Deploy, ApprovalAuthorityLevel.StrongDevice)).toBe(
      'allowed',
    );
  });

  it('canApproveViaVoice only allows low-risk one-time voice+scoped capabilities', () => {
    // Filesystem (requires voiceScopedPhrase) + low + one-time -> eligible.
    expect(canApproveViaVoice(CapabilityType.Filesystem, 'low', true)).toBe(true);
    // Non-low risk -> not eligible.
    expect(canApproveViaVoice(CapabilityType.Filesystem, 'medium', true)).toBe(false);
    // Not one-time -> not eligible.
    expect(canApproveViaVoice(CapabilityType.Filesystem, 'low', false)).toBe(false);
    // Capabilities requiring authenticated UI or strong device are never
    // voice-approvable even when low-risk and one-time.
    expect(canApproveViaVoice(CapabilityType.Network, 'low', true)).toBe(false);
    expect(canApproveViaVoice(CapabilityType.Push, 'low', true)).toBe(false);
    expect(canApproveViaVoice(CapabilityType.Merge, 'low', true)).toBe(false);
  });

  it('CAPABILITY_AUTHORITY_REQUIREMENTS maps per the security hierarchy', () => {
    expect(CAPABILITY_AUTHORITY_REQUIREMENTS[CapabilityType.Filesystem]).toBe(
      ApprovalAuthorityLevel.VoiceScopedPhrase,
    );
    expect(CAPABILITY_AUTHORITY_REQUIREMENTS[CapabilityType.Network]).toBe(
      ApprovalAuthorityLevel.AuthenticatedUI,
    );
    expect(CAPABILITY_AUTHORITY_REQUIREMENTS[CapabilityType.Push]).toBe(
      ApprovalAuthorityLevel.AuthenticatedUI,
    );
    expect(CAPABILITY_AUTHORITY_REQUIREMENTS[CapabilityType.CreatePR]).toBe(
      ApprovalAuthorityLevel.AuthenticatedUI,
    );
    expect(CAPABILITY_AUTHORITY_REQUIREMENTS[CapabilityType.Merge]).toBe(
      ApprovalAuthorityLevel.StrongDevice,
    );
    expect(CAPABILITY_AUTHORITY_REQUIREMENTS[CapabilityType.Deploy]).toBe(
      ApprovalAuthorityLevel.StrongDevice,
    );
    expect(CAPABILITY_AUTHORITY_REQUIREMENTS[CapabilityType.Destructive]).toBe(
      ApprovalAuthorityLevel.StrongDevice,
    );
  });
});

/* ------------------------------------------------------------------ *
 * PolicyDecision exhaustiveness sanity
 * ------------------------------------------------------------------ */

describe('PolicyDecision', () => {
  it('the three outcomes are allow, deny, escalate', () => {
    const decisions: PolicyDecision[] = ['allow', 'deny', 'escalate'];
    expect(new Set(decisions).size).toBe(3);
  });

  it('a deny rule with auto-approve conditions still denies when conditions fail', () => {
    const policy: Policy = {
      projectId: 'proj-1',
      allowAutoApproval: true,
      projectRules: [
        {
          name: 'filesystem-rule',
          capabilityPattern: [CapabilityType.Filesystem],
          autoApprove: { maxRiskLevel: CapabilityRiskLevel.Low, oneTimeOnly: true },
          decision: 'deny',
        },
      ],
      taskRules: [],
    };
    // High risk -> auto-approve conditions fail -> falls back to rule decision
    // 'deny'.
    const result = evaluatePolicy(readRequest({ riskLevel: CapabilityRiskLevel.High }), policy);
    expect(result.decision).toBe('deny');
    expect(result.autoApproved).toBe(false);
  });
});
