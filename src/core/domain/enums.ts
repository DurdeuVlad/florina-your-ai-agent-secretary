/**
 * Domain enums — lifecycle states, attention categories, adapter fidelity
 * tiers, and approval authority levels.
 *
 * Implements parts of DEC-004 (deliverables over sessions), DEC-014
 * (deterministic attention engine categories), and the adapter fidelity /
 * voice approval security hierarchies from PRODUCT_DESIGN.md.
 */

/**
 * Task lifecycle states.
 *
 * `created -> delegated -> running -> attention-needed / blocked -> running
 * -> completed -> reviewed / accepted`. Tasks can also `fail` or be
 * `cancelled`. See PRODUCT_DESIGN.md "Task Lifecycle".
 */
export const TaskState = {
  Created: 'created',
  Delegated: 'delegated',
  Running: 'running',
  AttentionNeeded: 'attention-needed',
  Blocked: 'blocked',
  Completed: 'completed',
  Reviewed: 'reviewed',
  Accepted: 'accepted',
  Failed: 'failed',
  Cancelled: 'cancelled',
} as const;

export type TaskState = (typeof TaskState)[keyof typeof TaskState];

/**
 * Attention categories. Agent state != attention state: a running task may
 * need attention, a waiting task may not. See PRODUCT_DESIGN.md "Attention
 * Model".
 */
export const AttentionCategory = {
  Fyi: 'FYI',
  Completed: 'Completed',
  Blocked: 'Blocked',
  ApprovalRequired: 'ApprovalRequired',
  DecisionRequired: 'DecisionRequired',
  RiskDetected: 'RiskDetected',
  Failure: 'Failure',
  Conflict: 'Conflict',
  ScopeChanged: 'ScopeChanged',
} as const;

export type AttentionCategory = (typeof AttentionCategory)[keyof typeof AttentionCategory];

/**
 * Attention priority levels surfaced to the human.
 */
export const AttentionPriority = {
  High: 'HIGH',
  Med: 'MED',
  Low: 'LOW',
} as const;

export type AttentionPriority = (typeof AttentionPriority)[keyof typeof AttentionPriority];

/**
 * Adapter fidelity tiers (PRODUCT_DESIGN.md "Agent Adapters"). The attention
 * engine adjusts auto-approval behavior based on the tier: A-B allow
 * auto-approve policies, C is conditional, D-E require human confirmation.
 */
export const AdapterFidelityTier = {
  A: 'A',
  B: 'B',
  C: 'C',
  D: 'D',
  E: 'E',
} as const;

export type AdapterFidelityTier = (typeof AdapterFidelityTier)[keyof typeof AdapterFidelityTier];

/**
 * Approval authority levels — the security hierarchy for voice approvals
 * (PRODUCT_DESIGN.md "Voice Experience"). Lower levels handle read/status
 * and narrowly scoped one-time permissions; higher levels require visual or
 * strong-device confirmation.
 */
export const ApprovalAuthorityLevel = {
  VoiceOnly: 'voiceOnly',
  VoiceScopedPhrase: 'voiceScopedPhrase',
  AuthenticatedUI: 'authenticatedUI',
  StrongDevice: 'strongDevice',
} as const;

export type ApprovalAuthorityLevel =
  (typeof ApprovalAuthorityLevel)[keyof typeof ApprovalAuthorityLevel];

/**
 * Context Capsule scopes (DEC-020). Each Project, Task, and Session owns a
 * capsule at the appropriate boundary to ensure strict context isolation
 * (DEC-003).
 */
export const ContextCapsuleScope = {
  Project: 'project',
  Task: 'task',
  Session: 'session',
} as const;

export type ContextCapsuleScope = (typeof ContextCapsuleScope)[keyof typeof ContextCapsuleScope];
