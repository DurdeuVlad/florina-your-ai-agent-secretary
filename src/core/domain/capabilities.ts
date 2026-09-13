/**
 * Structured capability / permission request model (DEC-010, DEC-011).
 *
 * Approvals authorize the underlying capability — deterministic adapter data —
 * never an LLM summary. This module is the single source of truth for the
 * capability vocabulary, risk classification, and the structured
 * {@link CapabilityRequest} carried by every approval surface.
 *
 * Design rules enforced here and by the policy/approval modules that consume
 * these types:
 * - A {@link CapabilityRequest} carries every DEC-010 field: task, agent,
 *   capability, destination, command, workingDir, scope, riskLevel.
 * - The {@link CapabilityType} vocabulary is a superset of the event-level
 *   capability kinds so adapters, the policy engine, and the approval
 *   authority mapper share one enumeration.
 * - The Florina narrows permissions, never silently widens them (DEC-011).
 *   An LLM risk assessment can never turn a deny into an allow — that
 *   enforcement lives in `./policy.js`, but the structured fields here are the
 *   deterministic basis it operates on.
 */
import type { ApprovalAuthorityLevel } from './enums.js';

/** ISO-8601 timestamp string (e.g. `2026-08-19T12:00:00.000Z`). */
export type ISO8601Timestamp = string;

/**
 * Risk classification for a capability request (DEC-010 / DEC-011).
 *
 * The ordering is significant: `low < medium < high < critical`. Higher risk
 * requires higher approval authority and may never be auto-approved.
 */
export const CapabilityRiskLevel = {
  Low: 'low',
  Medium: 'medium',
  High: 'high',
  Critical: 'critical',
} as const;

export type CapabilityRiskLevel = (typeof CapabilityRiskLevel)[keyof typeof CapabilityRiskLevel];

/** Ordered list of risk levels from least to most severe. */
export const CAPABILITY_RISK_LEVEL_VALUES: readonly CapabilityRiskLevel[] = [
  CapabilityRiskLevel.Low,
  CapabilityRiskLevel.Medium,
  CapabilityRiskLevel.High,
  CapabilityRiskLevel.Critical,
] as const;

/**
 * The kind of capability being requested by an agent.
 *
 * This is a superset of the event-level capability kinds: it adds the
 * higher-authority git-host actions (`push`, `merge`, `deploy`, `createPR`,
 * `destructive`) that require stronger approval authority per the voice
 * approval security hierarchy (PRODUCT_DESIGN.md "Voice Experience").
 */
export const CapabilityType = {
  Filesystem: 'filesystem',
  Network: 'network',
  Shell: 'shell',
  Git: 'git',
  Secret: 'secret',
  Push: 'push',
  Merge: 'merge',
  Deploy: 'deploy',
  CreatePR: 'createPR',
  Destructive: 'destructive',
  Other: 'other',
} as const;

export type CapabilityType = (typeof CapabilityType)[keyof typeof CapabilityType];

/** Ordered list of every valid capability type. */
export const CAPABILITY_TYPE_VALUES: readonly CapabilityType[] = [
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
] as const;

/**
 * A structured scope boundary for a capability request.
 *
 * Scopes narrow what a capability may touch (paths, hosts, commands, ...).
 * The Florina only ever narrows scope — never silently widens it (DEC-011).
 */
export interface CapabilityScope {
  /** The class of resource the scope constrains. */
  type: CapabilityType;
  /** Concrete targets within the scope (paths, hosts, commands, ...). */
  targets: string[];
}

/**
 * Structured capability request fields per DEC-010.
 *
 * Approval cards must show these deterministic adapter fields. An LLM
 * explanation is supplemental and never the authorization basis. This is the
 * canonical definition shared by the `SupervisorEvent` approval variants and
 * the policy/approval engines.
 */
export interface CapabilityRequest {
  /** Human-readable task name/objective the request belongs to. */
  task: string;
  /** Agent requesting the capability (e.g. `codex`, `claude-code`). */
  agent: string;
  /** The class of capability being requested. */
  capability: CapabilityType;
  /** Destination/resource the capability targets (host, path, repo, ...). */
  destination: string;
  /** The exact command or operation to be performed, if applicable. */
  command: string;
  /** Working directory in which the capability would execute. */
  workingDir: string;
  /** Structured scope boundaries for the requested capability. */
  scope: CapabilityScope[];
  /** Determined risk level for the requested capability. */
  riskLevel: CapabilityRiskLevel;
}

/**
 * The scope/duration of an approval once granted (DEC-007 configurable
 * autonomy). The Florina narrows scope — a one-time approval never silently
 * becomes project-scoped.
 */
export type ApprovalDuration = 'one-time' | 'task' | 'project';

/**
 * A record that a specific capability was approved, by whom, and at what
 * authority level (DEC-010).
 *
 * The approval authorizes the exact structured {@link CapabilityRequest} —
 * never an LLM summary. The `authorityLevelUsed` field makes the security
 * hierarchy auditable: every grant records which rung of the ladder authorized
 * it.
 */
export interface CapabilityApproval {
  /** Stable identifier for this approval record. */
  id: string;
  /** Identifier of the Task this approval belongs to. */
  taskId: string;
  /** The exact capability request that was authorized (deterministic fields). */
  capability: CapabilityRequest;
  /** Identifier of the human (or system principal) that granted the approval. */
  approvedBy: string;
  /** The authority level used to grant the approval. */
  authorityLevelUsed: ApprovalAuthorityLevel;
  /** Duration/scope of the approval. */
  duration: ApprovalDuration;
  /** Whether the approval was granted (true) or explicitly denied (false). */
  granted: boolean;
  /** ISO-8601 timestamp of when the approval decision was recorded. */
  timestamp: ISO8601Timestamp;
  /** Optional expiry timestamp for time-bounded approvals. */
  expiresAt?: ISO8601Timestamp;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Numeric severity rank for a risk level (higher = more severe). */
export function riskRank(level: CapabilityRiskLevel): number {
  return CAPABILITY_RISK_LEVEL_VALUES.indexOf(level);
}

/** Numeric authority rank for a capability type (higher = more sensitive). */
function capabilityTypeRank(type: CapabilityType): number {
  return CAPABILITY_TYPE_VALUES.indexOf(type);
}

/**
 * Compare two capability types for the same vocabulary membership.
 *
 * Returns true when both are known capability types with equal rank. Exposed
 * for the policy engine so it can match capability patterns without reaching
 * into the const array internals.
 */
export function isSameCapabilityType(a: CapabilityType, b: CapabilityType): boolean {
  return capabilityTypeRank(a) === capabilityTypeRank(b) && a === b;
}

/** Generates a reasonably unique id without a crypto dependency. */
function generateId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

/* ------------------------------------------------------------------ *
 * Factories
 * ------------------------------------------------------------------ */

/** Input for {@link buildCapabilityRequest}. */
export interface BuildCapabilityRequestInput {
  readonly task: string;
  readonly agent: string;
  readonly capability: CapabilityType;
  readonly destination: string;
  readonly command: string;
  readonly workingDir: string;
  readonly scope?: CapabilityScope[];
  readonly riskLevel: CapabilityRiskLevel;
}

/**
 * Build a {@link CapabilityRequest} with sensible defaults for optional
 * mechanical fields. `scope` defaults to a single entry matching the
 * capability/destination so every request carries a non-empty boundary.
 */
export function buildCapabilityRequest(input: BuildCapabilityRequestInput): CapabilityRequest {
  return {
    task: input.task,
    agent: input.agent,
    capability: input.capability,
    destination: input.destination,
    command: input.command,
    workingDir: input.workingDir,
    scope: input.scope ?? [
      { type: input.capability, targets: input.destination ? [input.destination] : [] },
    ],
    riskLevel: input.riskLevel,
  };
}

/** Input for {@link buildCapabilityApproval}. */
export interface BuildCapabilityApprovalInput {
  readonly taskId: string;
  readonly capability: CapabilityRequest;
  readonly approvedBy: string;
  readonly authorityLevelUsed: ApprovalAuthorityLevel;
  readonly duration?: ApprovalDuration;
  readonly granted?: boolean;
  readonly id?: string;
  readonly timestamp?: ISO8601Timestamp;
  readonly expiresAt?: ISO8601Timestamp;
}

/**
 * Build a {@link CapabilityApproval} recording the exact capability authorized
 * and the authority level used (DEC-010). `granted` defaults to `false` so an
 * approval must be explicitly confirmed before it permits anything — the
 * Florina narrows permissions, never silently widens them (DEC-011).
 */
export function buildCapabilityApproval(input: BuildCapabilityApprovalInput): CapabilityApproval {
  return {
    id: input.id ?? generateId('capapproval'),
    taskId: input.taskId,
    capability: input.capability,
    approvedBy: input.approvedBy,
    authorityLevelUsed: input.authorityLevelUsed,
    duration: input.duration ?? 'one-time',
    granted: input.granted ?? false,
    timestamp: input.timestamp ?? new Date().toISOString(),
    expiresAt: input.expiresAt,
  };
}
