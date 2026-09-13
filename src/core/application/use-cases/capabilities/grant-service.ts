/**
 * Grant service — durable capability grants and scoped auto-approval
 * (DEC-007/010/011, issue #67).
 *
 * The human grants a structured scope once ("this task may edit `src/`",
 * "this project may reach registry.npmjs.org"); the service then
 * auto-approves any adapter permission request that falls inside the
 * granted scope. Everything outside escalates through the normal
 * approval-card hierarchy.
 *
 * Rules enforced:
 * - **Structured matching only** (DEC-010): coverage compares deterministic
 *   fields — capability class, path/domain/command targets — never an LLM
 *   judgment.
 * - **Narrowing only** (DEC-011): a grant can turn a policy `escalate`
 *   into `allow`, never a `deny` into anything. Denies are absolute.
 * - **Tier gate** (PRODUCT_DESIGN): Tier D/E adapters never auto-approve —
 *   their permission data isn't structured enough to trust a scope match.
 * - **Journaled** (DEC-012): grant creation, revocation, and every
 *   auto-approve application are journaled `ApprovalGranted` /
 *   `ApprovalRevoked` events — attributable and auditable.
 */
import type { EntityId, Event } from '../../../domain/types.js';
import type { ApprovalGrantedEvent, ApprovalRevokedEvent } from '../../../domain/events.js';
import type { CapabilityRequest } from '../../../domain/capabilities.js';
import {
  type CapabilityGrant,
  type GrantInput,
  buildGrant,
  grantCoversRequest,
  isGrantActive,
} from '../../../domain/grants.js';
import type { AdapterFidelityTier } from '../../../domain/enums.js';
import type { PolicyDecision } from '../../../domain/policy.js';
import type {
  CapabilityGrantRepositoryPort,
  EventJournalPort,
} from '../../ports/outbound/repositories.js';
import type { EventPublisherPort } from '../../ports/outbound/event-stream.js';

export interface GrantServiceDeps {
  readonly grantStore: CapabilityGrantRepositoryPort;
  readonly journal: EventJournalPort;
  readonly eventBus: EventPublisherPort;
}

/**
 * Attribution context for journaled grant operations. Both ids must
 * reference real rows — the event journal has hard foreign keys to
 * `tasks` and `sessions`.
 */
export interface GrantJournalContext {
  /** The task the operation is attributed to (scope may differ). */
  readonly taskId: EntityId;
  /** A real session id (e.g. the task's latest session). */
  readonly sessionId: EntityId;
  /** Actor attribution for the event payload. */
  readonly agentId?: string;
}

/** Context for a grant auto-approve evaluation. */
export interface GrantEvalContext {
  readonly projectId: EntityId;
  readonly taskId: EntityId;
  readonly sessionId: EntityId;
  /** Adapter fidelity tier of the requesting agent (D/E never auto-approve). */
  readonly adapterFidelityTier: AdapterFidelityTier;
  /** The decision the policy engine reached *before* grant evaluation. */
  readonly policyDecision: PolicyDecision;
}

/** Outcome of {@link GrantService.evaluate}. */
export interface GrantEvaluation {
  /** The final decision after grant evaluation. */
  readonly decision: PolicyDecision;
  /** Whether a covering grant auto-approved the request. */
  readonly autoApproved: boolean;
  /** The grant that covered the request, when auto-approved. */
  readonly coveringGrant?: CapabilityGrant;
  /** Human-readable rationale (journaled). */
  readonly reason: string;
}

/** Tiers whose structured permission data supports auto-approval (A/B/C). */
const AUTO_APPROVABLE_TIERS: readonly AdapterFidelityTier[] = ['A', 'B', 'C'];

export class GrantService {
  private readonly grantStore: CapabilityGrantRepositoryPort;
  private readonly journal: EventJournalPort;
  private readonly eventBus: EventPublisherPort;

  constructor(deps: GrantServiceDeps) {
    this.grantStore = deps.grantStore;
    this.journal = deps.journal;
    this.eventBus = deps.eventBus;
  }

  /**
   * Record a durable capability grant. Validates scope shape, persists the
   * grant, and journals an `ApprovalGranted` event so the grant is
   * attributable ("you granted this on Tuesday for task X").
   */
  grant(input: GrantInput, context: GrantJournalContext): CapabilityGrant {
    const grant = buildGrant(input);
    this.grantStore.insert(grant);
    this.recordGranted(grant, context);
    return grant;
  }

  /**
   * Revoke a grant — sets `revokedAt` (a record, not a deletion) and
   * journals an `ApprovalRevoked` event. Takes effect on the next request.
   *
   * @returns `true` when the grant existed and was still active.
   */
  revoke(grantId: EntityId, context: GrantJournalContext & { reason?: string }): boolean {
    const grant = this.grantStore.getById(grantId);
    if (grant === null || grant.revokedAt !== undefined) {
      return false;
    }
    const revoked: CapabilityGrant = { ...grant, revokedAt: new Date().toISOString() };
    this.grantStore.update(revoked);

    const event: ApprovalRevokedEvent = {
      type: 'ApprovalRevoked',
      timestamp: new Date().toISOString(),
      taskId: context.taskId,
      sessionId: context.sessionId,
      agentId: context.agentId ?? 'secretary',
      adapterFidelityTier: 'B',
      grantId,
      ...(context.reason !== undefined ? { reason: context.reason } : {}),
    };
    this.journal.insert(toJournalEvent(event));
    this.eventBus.publish(event);
    return true;
  }

  /** List grants — optionally filtered to active (non-revoked, unexpired). */
  listGrants(
    filter: { projectId?: EntityId; taskId?: EntityId; activeOnly?: boolean } = {},
  ): CapabilityGrant[] {
    let grants: CapabilityGrant[] = [];
    if (filter.taskId !== undefined) {
      grants = [...this.grantStore.listByTask(filter.taskId)];
    }
    if (filter.projectId !== undefined) {
      grants = [...grants, ...this.grantStore.listByProject(filter.projectId)];
    }
    // A task-scoped list already includes the task's grants; dedupe.
    const seen = new Set<EntityId>();
    const unique = grants.filter((g) => (seen.has(g.id) ? false : (seen.add(g.id), true)));
    if (filter.activeOnly === true) {
      return unique.filter((g) => isGrantActive(g));
    }
    return unique;
  }

  /**
   * Evaluate a capability request against the active grants — the
   * auto-approve path for `escalate` decisions.
   *
   * Narrowing-only ordering (DEC-011):
   * 1. A policy `deny` is absolute — returned unchanged, no grant touched.
   * 2. Tier D/E adapters never auto-approve — escalate stands.
   * 3. A covering active grant turns `escalate` into `allow` (journaled as
   *    an `ApprovalGranted` application with `grantedBy: 'scope-grant'`).
   * 4. Otherwise the policy decision stands.
   */
  evaluate(request: CapabilityRequest, ctx: GrantEvalContext): GrantEvaluation {
    if (ctx.policyDecision === 'deny') {
      return {
        decision: 'deny',
        autoApproved: false,
        reason: 'Policy deny is absolute — grants cannot override it (DEC-011).',
      };
    }

    if (ctx.policyDecision === 'allow') {
      return { decision: 'allow', autoApproved: false, reason: 'Already allowed by policy.' };
    }

    if (!AUTO_APPROVABLE_TIERS.includes(ctx.adapterFidelityTier)) {
      return {
        decision: 'escalate',
        autoApproved: false,
        reason: `Adapter tier "${ctx.adapterFidelityTier}" never auto-approves — escalating.`,
      };
    }

    const covering = this.listGrants({
      projectId: ctx.projectId,
      taskId: ctx.taskId,
      activeOnly: true,
    }).find((grant) => grantCoversRequest(grant, request, ctx.taskId));

    if (covering === undefined) {
      return {
        decision: 'escalate',
        autoApproved: false,
        reason: 'No covering grant — escalating to human.',
      };
    }

    // Journal the auto-approve application — attributable to the grant
    // that authorized it (DEC-012).
    this.recordGranted(covering, {
      taskId: ctx.taskId,
      sessionId: ctx.sessionId,
      agentId: 'scope-grant',
    });
    return {
      decision: 'allow',
      autoApproved: true,
      coveringGrant: covering,
      reason: `Auto-approved under grant ${covering.id} (granted by ${covering.grantedBy} at ${covering.grantedAt}).`,
    };
  }

  /* ---------------------------------------------------------------- *
   * Internal helpers
   * ---------------------------------------------------------------- */

  /** Journal + publish an `ApprovalGranted` event for a grant record. */
  private recordGranted(grant: CapabilityGrant, context: GrantJournalContext): void {
    const event: ApprovalGrantedEvent = {
      type: 'ApprovalGranted',
      timestamp: new Date().toISOString(),
      taskId: context.taskId,
      sessionId: context.sessionId,
      agentId: context.agentId ?? 'secretary',
      adapterFidelityTier: 'B',
      grantId: grant.id,
      capability: grant.capability,
      duration: grant.duration,
      scopes: [...grant.scopes],
      grantedBy: grant.grantedBy,
      authorityLevel: grant.authorityLevel,
    };
    this.journal.insert(toJournalEvent(event));
    this.eventBus.publish(event);
  }
}

/** Convert a supervisor event into a journal row (payload = typed fields). */
function toJournalEvent(event: ApprovalGrantedEvent | ApprovalRevokedEvent): Event {
  const { type, timestamp, taskId, sessionId, agentId, adapterFidelityTier, ...payload } = event;
  return {
    id: `event_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`,
    sessionId,
    taskId,
    timestamp,
    kind: type,
    payload: { agentId, adapterFidelityTier, ...payload },
  };
}
