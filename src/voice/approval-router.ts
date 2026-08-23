/**
 * Approval router — routes approval requests from the daemon to the voice
 * pipeline for spoken approval (issue #23, DEC-010, DEC-011, DEC-007).
 *
 * {@link ApprovalRouter} listens for {@link ApprovalRequestedEvent}s (from an
 * {@link EventBus} or an injected callback), maps each request to a spoken
 * prompt via {@link SpokenPromptBuilder}, runs the voice approval interaction
 * through a {@link VoiceApprover}, and routes the resulting decision back to
 * the daemon as an approve/deny command.
 *
 * Risk-based approval hierarchy (DEC-010 / DEC-011):
 * - **Low risk**: auto-approve when `autoApproveLowRisk` is enabled (default
 *   **off** for safety per DEC-011). When auto-approve is off, low risk is
 *   handled via a normal voice yes/no round.
 * - **Medium risk**: voice approval with a simple yes/no.
 * - **High risk**: voice approval with an explicit "Are you sure?"
 *   confirmation (enforced by {@link VoiceApprover}).
 * - **Critical risk**: **not voice-approvable** — the router rejects
 *   immediately and escalates to a visual/CLI/desktop surface via the
 *   `onEscalate` callback. Voice never authorizes a critical capability.
 *
 * The spoken prompt is built from the **deterministic** structured
 * {@link CapabilityRequest} fields (task, agent, capability, destination,
 * scope) — never from an LLM summary (DEC-010). The human authorizes the
 * structured capability read aloud; the LLM only interprets the spoken
 * yes/no.
 */
import type { ApprovalRequestedEvent, RiskLevel } from '../domain/events.js';
import { CapabilityRiskLevel } from '../domain/capabilities.js';
import type { CapabilityRequest } from '../domain/capabilities.js';
import type { ApproveCommand } from '../daemon/command-api.js';
import type { EventBus } from '../daemon/event-stream.js';
import type { SupervisorEvent } from '../domain/events.js';
import { VoiceApprover } from './voice-approver.js';
import type { ApprovalDecision } from './voice-approver.js';

/* ================================================================== *
 * Types
 * ================================================================== */

/** How an approval request was handled by the router. */
export type ApprovalRouteMode = 'auto' | 'voice' | 'rejected';

/** The result of routing a single approval request. */
export interface ApprovalRoutingResult {
  /** The original approval request event. */
  readonly event: ApprovalRequestedEvent;
  /** A generated approval id used when routing the decision to the daemon. */
  readonly approvalId: string;
  /** The final grant/deny decision. */
  readonly decision: ApprovalDecision;
  /** How the request was handled: auto-approved, voice-approved, or rejected. */
  readonly mode: ApprovalRouteMode;
}

/**
 * Callback invoked when the router reaches a final decision, with the
 * {@link ApproveCommand} that should be dispatched to the daemon.
 */
export type ApprovalDecisionCallback = (result: ApprovalRoutingResult) => void;

/**
 * Callback invoked when a critical-risk request is rejected as not
 * voice-approvable. The host wires this to stage the approval on a
 * visual/CLI/desktop surface (DEC-010).
 */
export type ApprovalEscalationCallback = (event: ApprovalRequestedEvent) => void;

/* ================================================================== *
 * Configuration
 * ================================================================== */

/** Options for {@link ApprovalRouter}. */
export interface ApprovalRouterOptions {
  /**
   * Whether low-risk requests are auto-approved without a voice round.
   * Default **false** — the Secretary narrows permissions, never silently
   * widens them (DEC-011).
   */
  readonly autoApproveLowRisk?: boolean;
}

/* ================================================================== *
 * SpokenPromptBuilder
 * ================================================================== */

/**
 * Builds natural-language spoken prompts from the deterministic
 * {@link CapabilityRequest} fields (DEC-010).
 *
 * The prompt is concise, scannable, and natural for voice interaction. It
 * always surfaces the agent name, the action (capability + command), the
 * destination, and the scope — the structured fields the human is authorizing
 * — never an LLM summary.
 */
export class SpokenPromptBuilder {
  /**
   * Build a spoken approval prompt for a capability request.
   *
   * @example
   * "Codex wants to run npm install on registry.npmjs.org. Allow?"
   */
  build(request: CapabilityRequest): string {
    const agent = this.capitalize(request.agent);
    const action = this.describeAction(request);
    const destination = this.describeDestination(request);
    const scope = this.describeScope(request);

    const parts: string[] = [`${agent} wants to ${action}`];
    if (destination.length > 0) {
      parts.push(`on ${destination}`);
    }
    if (scope.length > 0) {
      parts.push(`scoped to ${scope}`);
    }
    const base = parts.join(' ');
    return `${base}. Allow?`;
  }

  /** Describe the action: capability + command, e.g. "run npm install". */
  private describeAction(request: CapabilityRequest): string {
    const cmd = request.command.trim();
    if (cmd.length > 0) {
      // Shell/network/git commands read more naturally as "run <command>".
      if (
        request.capability === 'shell' ||
        request.capability === 'network' ||
        request.capability === 'git'
      ) {
        return `run ${cmd}`;
      }
      return cmd;
    }
    // Fall back to the capability type when no concrete command is present.
    return this.describeCapability(request.capability);
  }

  /** Describe the destination, e.g. a host, path, or repo. */
  private describeDestination(request: CapabilityRequest): string {
    return request.destination.trim();
  }

  /** Describe the scope boundaries as a compact, spoken list. */
  private describeScope(request: CapabilityRequest): string {
    const targets = request.scope.flatMap((s) => s.targets).filter((t) => t.length > 0);
    if (targets.length === 0) {
      return '';
    }
    // De-duplicate while preserving order.
    const unique = [...new Set(targets)];
    if (unique.length === 1) {
      return unique[0];
    }
    if (unique.length === 2) {
      return `${unique[0]} and ${unique[1]}`;
    }
    return `${unique.slice(0, -1).join(', ')}, and ${unique[unique.length - 1]}`;
  }

  /** Map a capability type to a spoken noun phrase. */
  private describeCapability(capability: CapabilityRequest['capability']): string {
    switch (capability) {
      case 'filesystem':
        return 'access the filesystem';
      case 'network':
        return 'access the network';
      case 'shell':
        return 'run a shell command';
      case 'git':
        return 'perform a git operation';
      case 'secret':
        return 'access a secret';
      case 'push':
        return 'push to the remote';
      case 'merge':
        return 'merge a branch';
      case 'deploy':
        return 'deploy';
      case 'createPR':
        return 'create a pull request';
      case 'destructive':
        return 'perform a destructive action';
      default:
        return `perform a ${capability} operation`;
    }
  }

  /** Capitalize the first letter of a name (e.g. "codex" -> "Codex"). */
  private capitalize(name: string): string {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      return 'The agent';
    }
    return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  }
}

/* ================================================================== *
 * ApprovalRouter
 * ================================================================== */

/**
 * Routes approval requests from the daemon to the voice pipeline.
 *
 * Construct with a {@link VoiceApprover} and optional callbacks, then either:
 * - call {@link ApprovalRouter.start} to subscribe to an {@link EventBus} and
 *   handle events automatically, or
 * - call {@link ApprovalRouter.route} directly for each event (useful in
 *   tests or when the host wants explicit control over dispatch).
 *
 * The router enforces the risk-based hierarchy and invokes the
 * {@link ApprovalDecisionCallback} with the final result (and the
 * {@link ApproveCommand} to dispatch) once a decision is reached.
 */
export class ApprovalRouter {
  private readonly approver: VoiceApprover;
  private readonly promptBuilder: SpokenPromptBuilder;
  private readonly autoApproveLowRisk: boolean;
  private readonly onDecision?: ApprovalDecisionCallback;
  private readonly onEscalate?: ApprovalEscalationCallback;

  private unsubEvent: (() => void) | null = null;

  constructor(
    approver: VoiceApprover,
    options?: ApprovalRouterOptions & {
      readonly onDecision?: ApprovalDecisionCallback;
      readonly onEscalate?: ApprovalEscalationCallback;
    },
  ) {
    this.approver = approver;
    this.promptBuilder = new SpokenPromptBuilder();
    this.autoApproveLowRisk = options?.autoApproveLowRisk ?? false;
    this.onDecision = options?.onDecision;
    this.onEscalate = options?.onEscalate;
  }

  /**
   * Subscribe to an {@link EventBus} and automatically route every
   * {@link ApprovalRequestedEvent} through the voice approval hierarchy.
   */
  start(eventBus: EventBus): void {
    if (this.unsubEvent !== null) {
      return;
    }
    this.unsubEvent = eventBus.onEvent((event: SupervisorEvent) => {
      if (event.type === 'ApprovalRequested') {
        void this.route(event);
      }
    });
  }

  /** Stop listening to the event bus (idempotent). */
  stop(): void {
    this.unsubEvent?.();
    this.unsubEvent = null;
  }

  /**
   * Route a single {@link ApprovalRequestedEvent} through the risk-based
   * hierarchy and invoke the decision callback with the result.
   *
   * @returns The {@link ApprovalRoutingResult} for the request.
   */
  async route(event: ApprovalRequestedEvent): Promise<ApprovalRoutingResult> {
    const approvalId = generateApprovalId();
    const riskLevel: RiskLevel = event.riskLevel;

    // Critical risk: never voice-approvable. Reject and escalate.
    if (riskLevel === CapabilityRiskLevel.Critical) {
      const result: ApprovalRoutingResult = {
        event,
        approvalId,
        decision: {
          decision: 'deny',
          confidence: 1.0,
          rawResponse: '',
          reason: 'denied',
        },
        mode: 'rejected',
      };
      this.onEscalate?.(event);
      this.onDecision?.(result);
      return result;
    }

    // Low risk with auto-approve enabled: grant without a voice round.
    if (riskLevel === CapabilityRiskLevel.Low && this.autoApproveLowRisk) {
      const result: ApprovalRoutingResult = {
        event,
        approvalId,
        decision: {
          decision: 'grant',
          confidence: 1.0,
          rawResponse: '',
          reason: 'granted',
        },
        mode: 'auto',
      };
      this.onDecision?.(result);
      return result;
    }

    // Medium / High / (Low without auto-approve): voice approval round.
    const prompt = this.promptBuilder.build(event);
    const decision = await this.approver.requestApproval(prompt, riskLevel);
    const result: ApprovalRoutingResult = {
      event,
      approvalId,
      decision,
      mode: 'voice',
    };
    this.onDecision?.(result);
    return result;
  }

  /**
   * Build the {@link ApproveCommand} that the daemon should execute for a
   * routing result. Convenience helper for hosts that dispatch via the typed
   * command API (DEC-002 / DEC-026).
   */
  static toCommand(result: ApprovalRoutingResult): ApproveCommand {
    return {
      kind: 'approve',
      taskId: result.event.taskId,
      approvalId: result.approvalId,
      decision: result.decision.decision,
    };
  }
}

/* ================================================================== *
 * Internal helpers
 * ================================================================== */

/** Generate a reasonably unique approval id without a crypto dependency. */
function generateApprovalId(): string {
  return `voiceapproval_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}
