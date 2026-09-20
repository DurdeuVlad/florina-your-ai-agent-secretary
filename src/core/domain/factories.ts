/**
 * Factory / builder helpers for constructing domain objects with required
 * fields. Each factory fills in sensible defaults for purely mechanical
 * fields (timestamps, ids) so callers only specify the meaningful data.
 */
import {
  AdapterFidelityTier,
  ApprovalAuthorityLevel,
  AttentionCategory,
  AttentionPriority,
  ContextCapsuleScope,
  TaskState,
} from './enums.js';
import type {
  Agent,
  AgentRuntime,
  Approval,
  ApprovalScope,
  AttentionItem,
  ContextCapsule,
  Decision,
  Deliverable,
  DeliverableType,
  EntityId,
  Event,
  ISODateString,
  Project,
  ProjectCapsuleContent,
  UserCapsuleContent,
  ProjectPolicies,
  RepoMetadata,
  Session,
  SessionCapsuleContent,
  SessionStatus,
  SupervisorEventKind,
  Task,
  TaskCapsuleContent,
} from './types.js';

/** Generates a reasonably unique id without a crypto dependency. */
function generateId(prefix: string): EntityId {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

function now(): ISODateString {
  return new Date().toISOString();
}

/* ------------------------------------------------------------------ *
 * Project
 * ------------------------------------------------------------------ */

export interface BuildProjectInput {
  readonly name: string;
  readonly repo: RepoMetadata;
  readonly policies?: Partial<ProjectPolicies>;
  readonly capsuleId?: EntityId;
  readonly id?: EntityId;
}

const DEFAULT_POLICIES: ProjectPolicies = {
  allowAutoApproval: false,
  livenessTimeoutMs: 5 * 60 * 1000,
  alwaysApprove: [],
};

export function buildProject(input: BuildProjectInput): Project {
  const ts = now();
  return {
    id: input.id ?? generateId('project'),
    name: input.name,
    repo: input.repo,
    policies: { ...DEFAULT_POLICIES, ...input.policies },
    taskIds: [],
    capsuleId: input.capsuleId ?? generateId('capsule'),
    createdAt: ts,
    updatedAt: ts,
  };
}

/* ------------------------------------------------------------------ *
 * Task
 * ------------------------------------------------------------------ */

export interface BuildTaskInput {
  readonly projectId: EntityId;
  readonly objective: string;
  readonly capsuleId?: EntityId;
  readonly worktreePath?: string;
  readonly id?: EntityId;
  /** Optional Agent Profile reference (issue #196); omit for no role binding. */
  readonly agentProfileId?: EntityId;
}

export function buildTask(input: BuildTaskInput): Task {
  const ts = now();
  return {
    id: input.id ?? generateId('task'),
    projectId: input.projectId,
    objective: input.objective,
    state: TaskState.Created,
    agentIds: [],
    sessionIds: [],
    deliverableIds: [],
    attentionItemIds: [],
    capsuleId: input.capsuleId ?? generateId('capsule'),
    worktreePath: input.worktreePath,
    agentProfileId: input.agentProfileId,
    createdAt: ts,
    updatedAt: ts,
  };
}

/* ------------------------------------------------------------------ *
 * Agent
 * ------------------------------------------------------------------ */

export interface BuildAgentInput {
  readonly name: string;
  readonly provider: string;
  readonly fidelityTier: AdapterFidelityTier;
  readonly runtime: AgentRuntime;
  readonly id?: EntityId;
}

export function buildAgent(input: BuildAgentInput): Agent {
  return {
    id: input.id ?? generateId('agent'),
    name: input.name,
    provider: input.provider,
    fidelityTier: input.fidelityTier,
    runtime: input.runtime,
    createdAt: now(),
  };
}

/* ------------------------------------------------------------------ *
 * Session (Run)
 * ------------------------------------------------------------------ */

export interface BuildSessionInput {
  readonly taskId: EntityId;
  readonly agentId: EntityId;
  readonly status?: SessionStatus;
  readonly capsuleId?: EntityId;
  readonly id?: EntityId;
}

export function buildSession(input: BuildSessionInput): Session {
  return {
    id: input.id ?? generateId('session'),
    taskId: input.taskId,
    agentId: input.agentId,
    status: input.status ?? 'pending',
    startedAt: now(),
    eventIds: [],
    deliverableIds: [],
    capsuleId: input.capsuleId ?? generateId('capsule'),
  };
}

/* ------------------------------------------------------------------ *
 * Deliverable
 * ------------------------------------------------------------------ */

export interface BuildDeliverableInput {
  readonly taskId: EntityId;
  readonly type: DeliverableType;
  readonly title: string;
  readonly description: string;
  readonly sessionId?: EntityId;
  readonly id?: EntityId;
}

export function buildDeliverable(input: BuildDeliverableInput): Deliverable {
  return {
    id: input.id ?? generateId('deliverable'),
    taskId: input.taskId,
    sessionId: input.sessionId,
    type: input.type,
    title: input.title,
    description: input.description,
    artifacts: {},
    createdAt: now(),
  };
}

/* ------------------------------------------------------------------ *
 * Event
 * ------------------------------------------------------------------ */

export interface BuildEventInput {
  readonly sessionId: EntityId;
  readonly taskId: EntityId;
  readonly kind: SupervisorEventKind;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly id?: EntityId;
}

export function buildEvent(input: BuildEventInput): Event {
  return {
    id: input.id ?? generateId('event'),
    sessionId: input.sessionId,
    taskId: input.taskId,
    timestamp: now(),
    kind: input.kind,
    payload: input.payload ?? {},
  };
}

/* ------------------------------------------------------------------ *
 * AttentionItem
 * ------------------------------------------------------------------ */

export interface BuildAttentionItemInput {
  readonly taskId: EntityId;
  readonly category: AttentionCategory;
  readonly priority: AttentionPriority;
  readonly reason: string;
  readonly decisionRequested: string;
  readonly affectedCapability?: string;
  readonly suggestedSafeOptions?: readonly string[];
  readonly deadline?: ISODateString;
  readonly blockingImpact?: boolean;
  readonly relatedEventIds?: readonly EntityId[];
  readonly id?: EntityId;
}

export function buildAttentionItem(input: BuildAttentionItemInput): AttentionItem {
  return {
    id: input.id ?? generateId('attention'),
    taskId: input.taskId,
    category: input.category,
    priority: input.priority,
    reason: input.reason,
    decisionRequested: input.decisionRequested,
    affectedCapability: input.affectedCapability,
    suggestedSafeOptions: input.suggestedSafeOptions ?? [],
    deadline: input.deadline,
    blockingImpact: input.blockingImpact ?? false,
    relatedEventIds: input.relatedEventIds ?? [],
    resolved: false,
    createdAt: now(),
  };
}

/* ------------------------------------------------------------------ *
 * Decision
 * ------------------------------------------------------------------ */

export interface BuildDecisionInput {
  readonly taskId: EntityId;
  readonly question: string;
  readonly options?: readonly string[];
  readonly attentionItemId?: EntityId;
  readonly id?: EntityId;
}

export function buildDecision(input: BuildDecisionInput): Decision {
  return {
    id: input.id ?? generateId('decision'),
    taskId: input.taskId,
    attentionItemId: input.attentionItemId,
    question: input.question,
    options: input.options ?? [],
    status: 'open',
    createdAt: now(),
  };
}

/* ------------------------------------------------------------------ *
 * Approval
 * ------------------------------------------------------------------ */

export interface BuildApprovalInput {
  readonly taskId: EntityId;
  readonly capability: string;
  readonly scope?: ApprovalScope;
  readonly authorityLevel?: ApprovalAuthorityLevel;
  readonly destination?: string;
  readonly attentionItemId?: EntityId;
  readonly id?: EntityId;
}

export function buildApproval(input: BuildApprovalInput): Approval {
  return {
    id: input.id ?? generateId('approval'),
    taskId: input.taskId,
    attentionItemId: input.attentionItemId,
    capability: input.capability,
    destination: input.destination,
    scope: input.scope ?? 'one-time',
    authorityLevel: input.authorityLevel ?? ApprovalAuthorityLevel.AuthenticatedUI,
    granted: false,
  };
}

/* ------------------------------------------------------------------ *
 * ContextCapsule (DEC-020) — distinct factory per scope
 * ------------------------------------------------------------------ */

export interface BuildProjectCapsuleInput {
  readonly ownerId: EntityId;
  readonly content: ProjectCapsuleContent;
  readonly id?: EntityId;
}

export function buildProjectCapsule(input: BuildProjectCapsuleInput): ContextCapsule {
  const ts = now();
  return {
    id: input.id ?? generateId('capsule'),
    scope: ContextCapsuleScope.Project,
    ownerId: input.ownerId,
    content: input.content,
    createdAt: ts,
    updatedAt: ts,
  };
}

export interface BuildTaskCapsuleInput {
  readonly ownerId: EntityId;
  readonly content: TaskCapsuleContent;
  readonly id?: EntityId;
}

export function buildTaskCapsule(input: BuildTaskCapsuleInput): ContextCapsule {
  const ts = now();
  return {
    id: input.id ?? generateId('capsule'),
    scope: ContextCapsuleScope.Task,
    ownerId: input.ownerId,
    content: input.content,
    createdAt: ts,
    updatedAt: ts,
  };
}

export interface BuildUserCapsuleInput {
  readonly ownerId: EntityId;
  readonly content: UserCapsuleContent;
  readonly id?: EntityId;
}

export function buildUserCapsule(input: BuildUserCapsuleInput): ContextCapsule {
  const ts = now();
  return {
    id: input.id ?? generateId('capsule'),
    scope: ContextCapsuleScope.User,
    ownerId: input.ownerId,
    content: input.content,
    createdAt: ts,
    updatedAt: ts,
  };
}

export interface BuildSessionCapsuleInput {
  readonly ownerId: EntityId;
  readonly content: SessionCapsuleContent;
  readonly id?: EntityId;
}

export function buildSessionCapsule(input: BuildSessionCapsuleInput): ContextCapsule {
  const ts = now();
  return {
    id: input.id ?? generateId('capsule'),
    scope: ContextCapsuleScope.Session,
    ownerId: input.ownerId,
    content: input.content,
    createdAt: ts,
    updatedAt: ts,
  };
}
