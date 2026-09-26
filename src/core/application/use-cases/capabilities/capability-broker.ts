/**
 * Capability broker — mediates worker action requests against stored
 * credentials (DEC-022).
 *
 * Workers request actions (e.g. `create_pr`, `push_branch`) and the broker:
 * 1. Evaluates the request against the policy engine from #12 (DEC-007,
 *    DEC-011). If the policy denies, the action is refused — no credential is
 *    touched.
 * 2. Retrieves the stored credential from the {@link CredentialVaultPort}.
 * 3. Executes the action via a registered executor function, passing the
 *    credential. The worker never sees the raw credential — only the action
 *    result.
 * 4. Logs every credential use to the immutable event journal (DEC-012),
 *    recording the action, credential used, timestamp, and success/failure.
 *
 * Security hierarchy (DEC-011):
 *
 *   OS/container -> agent sandbox -> capability broker -> Florina policy
 *   -> human approval -> LLM recommendations
 *
 * The capability broker sits at the "capability broker" rung. Policy is
 * evaluated *before* any credential is retrieved — a deny means the
 * credential is never accessed.
 */
import type { EventJournalPort } from '../../ports/outbound/repositories.js';
import type { CredentialVaultPort } from '../../ports/outbound/credential-vault.js';
import type { EntityId, Event } from '../../../domain/types.js';
import {
  type CapabilityRequest,
  type CapabilityType,
  type CapabilityRiskLevel,
  buildCapabilityRequest,
} from '../../../domain/capabilities.js';
import {
  type Policy,
  type PolicyDecision,
  type PolicyEvaluationResult,
  evaluatePolicy,
} from '../../../domain/policy.js';
import type { AdapterFidelityTier } from '../../../domain/enums.js';
import type { GrantEvalContext, GrantEvaluation } from './grant-service.js';

/**
 * A function that executes an action using a retrieved credential.
 *
 * The executor receives the credential value and the action parameters. It
 * must never expose the credential value in its result — only the action
 * outcome (e.g. a PR URL, a success flag, an error message).
 */
export type ActionExecutor = (
  credentialValue: string,
  params: Record<string, unknown>,
) => ActionResult | Promise<ActionResult>;

/**
 * The result of executing a brokered action. This is what the worker receives
 * — never the raw credential.
 */
export interface ActionResult {
  /** Whether the action succeeded. */
  readonly success: boolean;
  /** Human-readable outcome or error message. */
  readonly message: string;
  /** Structured result data (e.g. PR URL, branch name) — never credentials. */
  readonly data?: Record<string, unknown>;
}

/**
 * The full outcome of an {@link CapabilityBroker.executeAction} call, carrying
 * the policy decision, the action result (if executed), and the event journal
 * record id.
 */
export interface BrokerActionOutcome {
  /** The policy decision for the request. */
  readonly decision: PolicyDecision;
  /** The policy evaluation rationale. */
  readonly policyReason: string;
  /** The action result, if the action was executed (decision was `allow`). */
  readonly result?: ActionResult;
  /** The id of the event journal record logging this credential use. */
  readonly eventId?: EntityId;
  /** Whether the credential was actually used (only when decision is `allow`). */
  readonly credentialUsed: boolean;
}

/**
 * Registration for an action executor.
 */
export interface ActionRegistration {
  /** The action name (e.g. `create_pr`, `push_branch`). */
  readonly action: string;
  /** The capability type this action maps to (for policy evaluation). */
  readonly capability: CapabilityType;
  /** The default risk level for this action. */
  readonly riskLevel: CapabilityRiskLevel;
  /** The executor function that performs the action with the credential. */
  readonly executor: ActionExecutor;
}

/** Options for constructing a {@link CapabilityBroker}. */
export interface CapabilityBrokerOptions {
  /** The credential vault. */
  readonly credentials: CredentialVaultPort;
  /** The event journal repository (DEC-012). */
  readonly events: EventJournalPort;
  /** A function that resolves the active policy for a project/task. */
  readonly policyResolver: (projectId: string, taskId?: string) => Policy;
  /**
   * Optional scoped-approval evaluator (issue #67). Consulted when policy
   * returns `escalate`: a covering active grant turns the decision into
   * `allow` (journaled by the evaluator). Grants never override a `deny`
   * — deny paths return before this evaluator runs (DEC-011).
   */
  readonly grantEvaluator?: (request: CapabilityRequest, ctx: GrantEvalContext) => GrantEvaluation;
}

/**
 * Capability broker — mediates worker action requests against stored
 * credentials (DEC-022).
 *
 * Workers call {@link executeAction} with an action name, parameters, and the
 * name of the credential to use. The broker evaluates policy, retrieves the
 * credential, executes the action, and logs the credential use to the event
 * journal. The worker receives only the {@link ActionResult} — never the raw
 * credential.
 */
export class CapabilityBroker {
  private readonly credentials: CredentialVaultPort;
  private readonly events: EventJournalPort;
  private readonly policyResolver: (projectId: string, taskId?: string) => Policy;
  private readonly grantEvaluator?: (
    request: CapabilityRequest,
    ctx: GrantEvalContext,
  ) => GrantEvaluation;
  private readonly registrations = new Map<string, ActionRegistration>();

  constructor(options: CapabilityBrokerOptions) {
    this.credentials = options.credentials;
    this.events = options.events;
    this.policyResolver = options.policyResolver;
    this.grantEvaluator = options.grantEvaluator;
  }

  /**
   * Register an action executor. The action name, capability type, risk level,
   * and executor function are bound together so the broker can build a
   * {@link CapabilityRequest} from a worker's action call.
   */
  registerAction(registration: ActionRegistration): void {
    if (!registration.action) throw new Error('Action name must not be empty.');
    this.registrations.set(registration.action, registration);
  }

  /**
   * Execute a brokered action on behalf of a worker (DEC-022).
   *
   * Flow:
   * 1. Look up the action registration. If unknown, deny.
   * 2. Build a {@link CapabilityRequest} from the action + context.
   * 3. Evaluate the request against the resolved policy. If the decision is
   *    `deny` or `escalate`, return without retrieving any credential.
   * 4. Retrieve the credential from the vault. If missing, log and return a
   *    failure.
   * 5. Execute the action via the registered executor, passing the credential.
   * 6. Log the credential use to the event journal (action, credential,
   *    timestamp, success/failure).
   * 7. Return the {@link ActionResult} to the worker — never the credential.
   *
   * @param action - The action name (e.g. `create_pr`).
   * @param params - Parameters for the action.
   * @param credentialName - The name of the stored credential to use.
   * @param context - Context for policy evaluation (project, task, agent, ...).
   * @returns The outcome with policy decision, action result, and event id.
   */
  async executeAction(
    action: string,
    params: Record<string, unknown>,
    credentialName: string,
    context: ActionContext,
  ): Promise<BrokerActionOutcome> {
    const registration = this.registrations.get(action);
    if (!registration) {
      return {
        decision: 'deny',
        policyReason: `Unknown action "${action}" — no executor registered.`,
        credentialUsed: false,
      };
    }

    // Build a structured capability request for policy evaluation.
    const request = buildCapabilityRequest({
      task: context.task,
      agent: context.agent,
      capability: registration.capability,
      destination: context.destination,
      command: action,
      workingDir: context.workingDir,
      riskLevel: registration.riskLevel,
    });

    // Evaluate policy before touching any credential (DEC-011).
    const policy = this.policyResolver(context.projectId, context.taskId);
    const evaluation = evaluatePolicy(request, policy);

    if (evaluation.decision === 'deny') {
      return {
        decision: 'deny',
        policyReason: evaluation.reason,
        credentialUsed: false,
      };
    }

    let effectiveReason = evaluation.reason;

    if (evaluation.decision === 'escalate') {
      // Scoped approvals (issue #67): a covering grant may satisfy the
      // escalation. Requires a real task + session for the journaled
      // auto-approve event — without them the escalation stands.
      if (
        this.grantEvaluator !== undefined &&
        context.taskId !== undefined &&
        context.sessionId !== undefined
      ) {
        const grantEval = this.grantEvaluator(request, {
          projectId: context.projectId,
          taskId: context.taskId,
          sessionId: context.sessionId,
          // Unknown tier → conservative 'D' (never auto-approves).
          adapterFidelityTier: context.adapterFidelityTier ?? 'D',
          policyDecision: 'escalate',
        });
        if (grantEval.decision !== 'allow') {
          return {
            decision: 'escalate',
            policyReason: grantEval.reason,
            credentialUsed: false,
          };
        }
        effectiveReason = grantEval.reason;
      } else {
        return {
          decision: 'escalate',
          policyReason: evaluation.reason,
          credentialUsed: false,
        };
      }
    }

    // Decision is 'allow' — retrieve the credential.
    const credentialValue = this.credentials.retrieveCredential(credentialName);
    if (credentialValue === null) {
      const eventId = this.logCredentialUse(
        action,
        credentialName,
        context,
        false,
        `Credential "${credentialName}" not found in vault.`,
      );
      return {
        decision: 'allow',
        policyReason: effectiveReason,
        result: {
          success: false,
          message: `Credential "${credentialName}" not found in vault.`,
        },
        eventId,
        credentialUsed: false,
      };
    }

    // Execute the action. The worker never sees the credential value.
    let result: ActionResult;
    try {
      result = await registration.executor(credentialValue, params);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result = { success: false, message };
    }

    // Log every credential use to the event journal (DEC-012).
    const eventId = this.logCredentialUse(
      action,
      credentialName,
      context,
      result.success,
      result.message,
    );

    return {
      decision: 'allow',
      policyReason: effectiveReason,
      result,
      eventId,
      credentialUsed: true,
    };
  }

  /**
   * Log a credential use to the immutable event journal (DEC-012).
   *
   * The event records: the action, the credential name (not value), the
   * timestamp, and success/failure. This makes every credential use auditable.
   */
  private logCredentialUse(
    action: string,
    credentialName: string,
    context: ActionContext,
    success: boolean,
    message: string,
  ): EntityId {
    const event: Event = {
      id: `creduse_${randomId()}`,
      sessionId: context.sessionId ?? 'credential-broker',
      taskId: context.taskId ?? 'credential-broker',
      timestamp: new Date().toISOString(),
      kind: 'ToolFinished',
      payload: {
        broker: 'capability-broker',
        action,
        credentialName,
        success,
        message,
        projectId: context.projectId,
        task: context.task,
        agent: context.agent,
      },
    };
    this.events.insert(event);
    return event.id;
  }
}

/**
 * Context for a brokered action request, used for policy evaluation and event
 * logging.
 */
export interface ActionContext {
  /** Project identifier for policy resolution. */
  readonly projectId: string;
  /** Optional task identifier for task-scoped policy. */
  readonly taskId?: string;
  /** Optional session identifier for event journal logging. */
  readonly sessionId?: string;
  /**
   * Adapter fidelity tier of the requesting agent (issue #67). Tier D/E
   * adapters never auto-approve under a grant; absent → conservative 'D'.
   */
  readonly adapterFidelityTier?: AdapterFidelityTier;
  /** Human-readable task name/objective. */
  readonly task: string;
  /** Agent requesting the action (e.g. `codex`, `claude-code`). */
  readonly agent: string;
  /** Destination/resource the action targets (repo URL, host, ...). */
  readonly destination: string;
  /** Working directory the action executes in. */
  readonly workingDir: string;
}

/** Generate a short random id (no crypto dependency needed for event ids). */
function randomId(): string {
  return `${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

// Re-export policy types for convenience.
export type { Policy, PolicyDecision, PolicyEvaluationResult, CapabilityRequest };
