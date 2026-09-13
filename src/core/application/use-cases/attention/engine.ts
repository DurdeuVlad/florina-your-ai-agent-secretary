/**
 * Deterministic attention policy engine (DEC-014).
 *
 * Classifies each incoming {@link SupervisorEvent} into one of three actions:
 *
 * - **always-surface**: the event must interrupt the human immediately.
 * - **batch**: the event is routine and should be collapsed into a digest.
 * - **elevate**: the event is security-sensitive and requires human
 *   confirmation with elevated authority (no auto-approve).
 *
 * The engine is **deterministic** (DEC-014): the same input always yields the
 * same output. Stateful checks (repeated failures, liveness timeout) are
 * delegated to {@link FailureTracker} and {@link LivenessMonitor}, or supplied
 * explicitly via {@link TaskContext} for pure-function testability.
 *
 * Adapter fidelity (DEC-013) influences behaviour: Tier D–E events with a
 * permission-like shape are always elevated to human confirmation because the
 * Florina cannot reliably distinguish actual permission requests from other
 * output at those fidelity levels.
 */
import type { SupervisorEvent } from '../../../domain/events.js';
import type {
  AdapterFidelityTier,
  AttentionCategory,
  AttentionPriority,
} from '../../../domain/enums.js';
import { AttentionCategory as Cat, AttentionPriority as Pri } from '../../../domain/enums.js';
import type { CapabilityType } from '../../../domain/capabilities.js';
import { CapabilityType as Cap } from '../../../domain/capabilities.js';
import {
  FailureTracker,
  DEFAULT_FAILURE_THRESHOLD,
  type FailureTrackerConfig,
} from './failure-tracker.js';
import { LivenessMonitor, type LivenessMonitorConfig } from './liveness-monitor.js';

/* ------------------------------------------------------------------ *
 * Public types
 * ------------------------------------------------------------------ */

/** The three deterministic attention actions (DEC-014). */
export type AttentionAction = 'always-surface' | 'batch' | 'elevate';

/**
 * The result of classifying a single event through the attention engine.
 *
 * Deterministic: the same `(event, fidelityTier, taskContext)` triple always
 * produces the same {@link AttentionClassification}.
 */
export interface AttentionClassification {
  /** The action Florina should take for this event. */
  readonly action: AttentionAction;
  /** Attention category (PRODUCT_DESIGN.md "Attention Model"). */
  readonly category: AttentionCategory;
  /** Priority level surfaced to the human. */
  readonly priority: AttentionPriority;
  /** Human-readable reason explaining why this classification was chosen. */
  readonly reason: string;
}

/**
 * Optional task-level context supplied to {@link AttentionEngine.classify}.
 *
 * When provided, the engine uses these values instead of its internal
 * trackers, making the call a pure function of its arguments. When omitted,
 * the engine falls back to its internal {@link FailureTracker} and
 * {@link LivenessMonitor} state.
 */
export interface TaskContext {
  /** The task this classification pertains to. */
  readonly taskId: string;
  /** Current consecutive failure count for the task (including the current
   * event if it is an `AgentFailed`). */
  readonly consecutiveFailures: number;
  /** Whether the liveness timeout has fired for this task. */
  readonly livenessTimedOut: boolean;
}

/** Configuration for {@link AttentionEngine}. */
export interface AttentionEngineConfig {
  /** Consecutive-failure threshold (default 3). */
  readonly failureThreshold?: number;
  /** Liveness timeout in milliseconds (default 5 minutes). */
  readonly livenessTimeoutMs?: number;
  /** Time provider for the internal liveness monitor. */
  readonly now?: () => number;
}

/* ------------------------------------------------------------------ *
 * Sensitive-path detection (ELEVATE rules)
 * ------------------------------------------------------------------ */

/**
 * Regex patterns for paths that, when changed, trigger an ELEVATE
 * classification because they touch security-sensitive areas.
 */
const SENSITIVE_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)secrets?(\.|\/|$)/i,
  /(^|\/)auth\b/i,
  /(^|\/)credentials?(\.|\/|$)/i,
  /(^|\/)\.env\b/i,
  /(^|\/)(private[_-]?)?keys?(\.|\/|$)/i,
  /(^|\/)tokens?(\.|\/|$)/i,
  /(^|\/)\.ssh\//i,
  /(^|\/)certificates?(\.|\/|$)/i,
  /(^|\/)\.aws\//i,
  /(^|\/)\.gnupg\//i,
];

/** Regex patterns for database migration files. */
const MIGRATION_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)migrations?\//i,
  /(^|\/)db\/migrate\//i,
  /(^|\/)flyway\//i,
  /(^|\/)liquibase\//i,
  /(^|\/)alembic\//i,
  /(^|\/)prisma\/migrations\//i,
];

/** Regex patterns for CI/deploy configuration files. */
const CI_DEPLOY_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.github\/workflows\//i,
  /(^|\/)\.gitlab-ci\b/i,
  /(^|\/)Dockerfile/i,
  /(^|\/)docker-compose/i,
  /(^|\/)\.circleci\//i,
  /(^|\/)deploy\//i,
  /(^|\/)\.deploy\//i,
  /(^|\/)Jenkinsfile/i,
  /(^|\/)\.drone\.yml/i,
  /(^|\/)terraform\//i,
  /(^|\/)k8s\//i,
  /(^|\/)kubernetes\//i,
  /(^|\/)\.dockerignore/i,
  /(^|\/)cloudbuild\.yml/i,
];

/** Regex patterns for dependency lockfiles. */
const LOCKFILE_PATTERNS: readonly RegExp[] = [
  /(^|\/)package-lock\.json$/i,
  /(^|\/)yarn\.lock$/i,
  /(^|\/)pnpm-lock\.yaml$/i,
  /(^|\/)Cargo\.lock$/i,
  /(^|\/)go\.sum$/i,
  /(^|\/)Gemfile\.lock$/i,
  /(^|\/)composer\.lock$/i,
  /(^|\/)poetry\.lock$/i,
  /(^|\/)Pipfile\.lock$/i,
  /(^|\/)uv\.lock$/i,
];

/** Capability types that, when requested, trigger an ELEVATE classification. */
const ELEVATE_CAPABILITIES: ReadonlySet<CapabilityType> = new Set<CapabilityType>([
  Cap.Network,
  Cap.Push,
  Cap.Merge,
  Cap.Deploy,
  Cap.Destructive,
]);

/** Adapter fidelity tiers that disallow auto-approval (DEC-013). */
const LOW_FIDELITY_TIERS: ReadonlySet<AdapterFidelityTier> = new Set<AdapterFidelityTier>([
  'D',
  'E',
]);

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Test a path against a list of regex patterns. */
function matchesAny(path: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((p) => p.test(path));
}

/** Whether a `FileChanged` path touches a secrets/auth area. */
function isSensitivePath(path: string): boolean {
  return matchesAny(path, SENSITIVE_PATH_PATTERNS);
}

/** Whether a `FileChanged` path is a database migration. */
function isMigrationPath(path: string): boolean {
  return matchesAny(path, MIGRATION_PATH_PATTERNS);
}

/** Whether a `FileChanged` path is CI/deploy configuration. */
function isCiDeployPath(path: string): boolean {
  return matchesAny(path, CI_DEPLOY_PATH_PATTERNS);
}

/** Whether a `FileChanged` path is a dependency lockfile. */
function isLockfilePath(path: string): boolean {
  return matchesAny(path, LOCKFILE_PATTERNS);
}

/**
 * Detect a sandbox violation from the event payload.
 *
 * Adapters may signal a sandbox violation in several ways:
 * - An explicit `sandboxViolation: true` extra field on any event.
 * - A `ToolFinished` event whose `result` contains `sandboxViolation: true`.
 * - A `ToolFinished` event whose error message mentions sandbox/permission
 *   denial.
 */
function detectSandboxViolation(event: SupervisorEvent): boolean {
  // Explicit flag on the event object (extra adapter field).
  if ('sandboxViolation' in event) {
    const flag = (event as Record<string, unknown>).sandboxViolation;
    if (flag === true) return true;
  }

  if (event.type === 'ToolFinished') {
    // Check result payload.
    if (event.result && event.result['sandboxViolation'] === true) {
      return true;
    }
    // Check error message for sandbox / permission-denied indicators.
    if (!event.success && event.error) {
      const lower = event.error.toLowerCase();
      if (
        lower.includes('sandbox') ||
        lower.includes('permission denied') ||
        lower.includes('operation not permitted')
      ) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Whether an event has a "permission-like shape" — i.e. it represents a
 * request for human approval or input. Used for the Tier D–E elevation rule
 * (DEC-013).
 */
function isPermissionLike(event: SupervisorEvent): boolean {
  if (event.type === 'ApprovalRequested' || event.type === 'HumanInputRequested') {
    return true;
  }
  if (event.type === 'AgentBlocked' && event.blockerType === 'permission') {
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * AttentionEngine
 * ------------------------------------------------------------------ */

/**
 * The deterministic attention policy engine (DEC-014).
 *
 * Classifies {@link SupervisorEvent}s into `always-surface`, `batch`, or
 * `elevate` using rule-based logic. The engine holds a {@link FailureTracker}
 * and a {@link LivenessMonitor} for stateful checks; callers may also supply
 * a {@link TaskContext} to make a single `classify` call a pure function.
 */
export class AttentionEngine {
  private readonly _failureTracker: FailureTracker;
  private readonly _livenessMonitor: LivenessMonitor;
  private readonly _failureThreshold: number;

  constructor(config: AttentionEngineConfig = {}) {
    const failureConfig: FailureTrackerConfig = {
      threshold: config.failureThreshold,
    };
    const livenessConfig: LivenessMonitorConfig = {
      timeoutMs: config.livenessTimeoutMs,
      now: config.now,
    };
    this._failureTracker = new FailureTracker(failureConfig);
    this._livenessMonitor = new LivenessMonitor(livenessConfig);
    this._failureThreshold = config.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
  }

  /** The internal failure tracker. Callers may use it to record/reset
   * failures outside of `classify`. */
  get failureTracker(): FailureTracker {
    return this._failureTracker;
  }

  /** The internal liveness monitor. Callers may use it to seed timestamps
   * or check liveness outside of `classify`. */
  get livenessMonitor(): LivenessMonitor {
    return this._livenessMonitor;
  }

  /** The configured consecutive-failure threshold. */
  get failureThresholdValue(): number {
    return this._failureThreshold;
  }

  /** The configured liveness timeout in milliseconds. */
  get livenessTimeoutMs(): number {
    return this._livenessMonitor.livenessTimeoutMs;
  }

  /**
   * Classify a single event into an attention action.
   *
   * Side effects:
   * - The internal liveness monitor is reset on meaningful events.
   * - The internal failure tracker is updated on `AgentFailed` (increment)
   *   and `AgentCompleted` (reset).
   *
   * When `taskContext` is provided, its `consecutiveFailures` and
   * `livenessTimedOut` fields are used for the state-dependent rules instead
   * of the internal trackers, making the call a pure function of its
   * arguments (deterministic).
   *
   * @param event - The normalized supervisor event to classify.
   * @param fidelityTier - The adapter fidelity tier to use for behaviour
   *   adjustment (DEC-013). May differ from `event.adapterFidelityTier` when
   *   the caller wants to override.
   * @param taskContext - Optional task context for state-dependent rules.
   * @returns The deterministic attention classification.
   */
  classify(
    event: SupervisorEvent,
    fidelityTier: AdapterFidelityTier,
    taskContext?: TaskContext,
  ): AttentionClassification {
    // --- Update internal trackers (side effects) -----------------------

    // Liveness: reset on meaningful events.
    this._livenessMonitor.resetOnEvent(event);

    // Failure tracking: increment on AgentFailed, reset on AgentCompleted.
    if (event.type === 'AgentFailed') {
      this._failureTracker.recordFailure(event.taskId);
    } else if (event.type === 'AgentCompleted') {
      this._failureTracker.resetOnSuccess(event.taskId);
    }

    // --- Resolve state-dependent values --------------------------------

    const taskId = event.taskId;
    const consecutiveFailures =
      taskContext?.consecutiveFailures ?? this._failureTracker.getFailureCount(taskId);
    const livenessTimedOut =
      taskContext?.livenessTimedOut ?? this._livenessMonitor.checkLiveness(taskId);

    // --- Sandbox violation detection -----------------------------------

    const sandboxViolation = detectSandboxViolation(event);

    // --- Classification ------------------------------------------------

    // The classification proceeds in priority order:
    // 1. ELEVATE rules (security-sensitive file changes, risky capabilities)
    // 2. ALWAYS-SURFACE rules (permission requests, failures, completion, ...)
    // 3. Fidelity-tier adjustment (D–E permission-like → elevate)
    // 4. BATCH (default for routine activity)

    // 1. ELEVATE ----------------------------------------------------------

    const elevate = this.checkElevateRules(event);
    if (elevate !== null) {
      return elevate;
    }

    // 2. ALWAYS-SURFACE ---------------------------------------------------

    const alwaysSurface = this.checkAlwaysSurfaceRules(
      event,
      consecutiveFailures,
      livenessTimedOut,
      sandboxViolation,
    );
    if (alwaysSurface !== null) {
      // 3. Fidelity-tier adjustment: D–E permission-like events are elevated.
      if (LOW_FIDELITY_TIERS.has(fidelityTier) && isPermissionLike(event)) {
        return {
          action: 'elevate',
          category: alwaysSurface.category,
          priority: Pri.High,
          reason: `${alwaysSurface.reason} Tier ${fidelityTier} adapter requires human confirmation (no auto-approve, DEC-013).`,
        };
      }
      return alwaysSurface;
    }

    // 3. Fidelity-tier adjustment for permission-like events that would
    //    otherwise be batched (e.g. AgentBlocked with permission blocker on
    //    a D–E tier).
    if (LOW_FIDELITY_TIERS.has(fidelityTier) && isPermissionLike(event)) {
      return {
        action: 'elevate',
        category: Cat.ApprovalRequired,
        priority: Pri.High,
        reason: `Permission-like event from Tier ${fidelityTier} adapter; elevated to human confirmation (DEC-013).`,
      };
    }

    // 4. BATCH (default) --------------------------------------------------

    return this.batchClassification(event);
  }

  /* ---------------------------------------------------------------- *
   * Rule implementations
   * ---------------------------------------------------------------- */

  /**
   * Check ELEVATE rules. Returns a classification if the event matches an
   * elevate rule, or `null` if it does not.
   */
  private checkElevateRules(event: SupervisorEvent): AttentionClassification | null {
    // --- FileChanged: sensitive paths ----------------------------------

    if (event.type === 'FileChanged') {
      if (isSensitivePath(event.path)) {
        return {
          action: 'elevate',
          category: Cat.RiskDetected,
          priority: Pri.High,
          reason: `File change in security-sensitive path: "${event.path}".`,
        };
      }
      if (isMigrationPath(event.path)) {
        return {
          action: 'elevate',
          category: Cat.RiskDetected,
          priority: Pri.High,
          reason: `Database migration changed: "${event.path}".`,
        };
      }
      if (isCiDeployPath(event.path)) {
        return {
          action: 'elevate',
          category: Cat.RiskDetected,
          priority: Pri.High,
          reason: `CI/deploy configuration changed: "${event.path}".`,
        };
      }
      if (isLockfilePath(event.path)) {
        return {
          action: 'elevate',
          category: Cat.RiskDetected,
          priority: Pri.Med,
          reason: `Unexpected lockfile change: "${event.path}".`,
        };
      }
      // Non-sensitive file change → not an elevate rule.
      return null;
    }

    // --- ApprovalRequested: risky capabilities -------------------------

    if (event.type === 'ApprovalRequested') {
      if (ELEVATE_CAPABILITIES.has(event.capability)) {
        return {
          action: 'elevate',
          category: Cat.ApprovalRequired,
          priority: Pri.High,
          reason: `Approval requested for elevated capability "${event.capability}" (destination: ${event.destination}).`,
        };
      }
      // Filesystem scope expansion: a filesystem request whose scope targets
      // paths outside the working directory.
      if (event.capability === Cap.Filesystem) {
        if (isFilesystemScopeExpansion(event)) {
          return {
            action: 'elevate',
            category: Cat.ScopeChanged,
            priority: Pri.Med,
            reason: `Filesystem scope expansion requested (destination: ${event.destination}).`,
          };
        }
      }
      // Non-elevated approval request → falls through to always-surface.
      return null;
    }

    return null;
  }

  /**
   * Check ALWAYS-SURFACE rules. Returns a classification if the event
   * matches an always-surface rule, or `null` if it does not.
   */
  private checkAlwaysSurfaceRules(
    event: SupervisorEvent,
    consecutiveFailures: number,
    livenessTimedOut: boolean,
    sandboxViolation: boolean,
  ): AttentionClassification | null {
    // Sandbox violation (detect from payload) — highest priority.
    if (sandboxViolation) {
      return {
        action: 'always-surface',
        category: Cat.RiskDetected,
        priority: Pri.High,
        reason: 'Sandbox violation detected from event payload.',
      };
    }

    // Liveness timeout.
    if (livenessTimedOut) {
      return {
        action: 'always-surface',
        category: Cat.RiskDetected,
        priority: Pri.High,
        reason: `Liveness timeout: no meaningful events for task "${event.taskId}" within the configured duration.`,
      };
    }

    switch (event.type) {
      // Agent requests permission.
      case 'ApprovalRequested':
        return {
          action: 'always-surface',
          category: Cat.ApprovalRequired,
          priority: riskToPriority(event.riskLevel),
          reason: `Agent requests permission for capability "${event.capability}" (destination: ${event.destination}).`,
        };

      // Agent requests human input.
      case 'HumanInputRequested':
        return {
          action: 'always-surface',
          category: Cat.DecisionRequired,
          priority: Pri.Med,
          reason: `Agent requests human input: "${event.prompt}".`,
        };

      // Agent crashes.
      case 'AgentFailed': {
        // Repeated failures: if the consecutive count reaches the threshold,
        // surface with elevated priority and a repeated-failure reason.
        if (consecutiveFailures >= this._failureThreshold) {
          return {
            action: 'always-surface',
            category: Cat.Failure,
            priority: Pri.High,
            reason: `Repeated failure: ${consecutiveFailures} consecutive AgentFailed events for task "${event.taskId}" (threshold ${this._failureThreshold}).`,
          };
        }
        // Single failure.
        return {
          action: 'always-surface',
          category: Cat.Failure,
          priority: Pri.High,
          reason: `Agent failed: "${event.error}".`,
        };
      }

      // Task completes.
      case 'AgentCompleted':
        return {
          action: 'always-surface',
          category: Cat.Completed,
          priority: Pri.Med,
          reason: `Task completed: "${event.summary}". Human review required.`,
        };

      default:
        return null;
    }
  }

  /**
   * Produce a BATCH classification for routine events.
   */
  private batchClassification(event: SupervisorEvent): AttentionClassification {
    switch (event.type) {
      case 'FileChanged':
        return {
          action: 'batch',
          category: Cat.Fyi,
          priority: Pri.Low,
          reason: `Routine file change: "${event.path}" (${event.changeType}).`,
        };

      case 'ToolStarted':
        return {
          action: 'batch',
          category: Cat.Fyi,
          priority: Pri.Low,
          reason: `Tool started: "${event.toolName}".`,
        };

      case 'ToolFinished':
        return {
          action: 'batch',
          category: Cat.Fyi,
          priority: Pri.Low,
          reason: `Tool finished: "${event.toolName}" (success: ${event.success}).`,
        };

      case 'TestStarted':
        return {
          action: 'batch',
          category: Cat.Fyi,
          priority: Pri.Low,
          reason: 'Test run started.',
        };

      case 'TestFinished':
        return {
          action: 'batch',
          category: Cat.Fyi,
          priority: Pri.Low,
          reason: `Test run finished: ${event.passed} passed, ${event.failed} failed, ${event.skipped} skipped.`,
        };

      case 'AgentProgress':
        return {
          action: 'batch',
          category: Cat.Fyi,
          priority: Pri.Low,
          reason: `Progress: "${event.message}".`,
        };

      case 'AgentStarted':
        return {
          action: 'batch',
          category: Cat.Fyi,
          priority: Pri.Low,
          reason: `Agent started: objective "${event.objective}".`,
        };

      case 'AgentBlocked':
        return {
          action: 'batch',
          category: Cat.Blocked,
          priority: Pri.Low,
          reason: `Agent blocked: "${event.reason}" (${event.blockerType}).`,
        };

      case 'AgentStopped':
        return {
          action: 'batch',
          category: Cat.Fyi,
          priority: Pri.Low,
          reason: `Agent stopped: ${event.reason}.`,
        };

      default:
        // Exhaustive fallback — should never be reached for valid events.
        return {
          action: 'batch',
          category: Cat.Fyi,
          priority: Pri.Low,
          reason: `Routine event of type "${event.type}".`,
        };
    }
  }
}

/* ------------------------------------------------------------------ *
 * Internal helpers
 * ------------------------------------------------------------------ */

/** Map a capability risk level to an attention priority. */
function riskToPriority(risk: string): AttentionPriority {
  switch (risk) {
    case 'critical':
      return Pri.High;
    case 'high':
      return Pri.High;
    case 'medium':
      return Pri.Med;
    case 'low':
    default:
      return Pri.Med;
  }
}

/**
 * Detect filesystem scope expansion: a filesystem capability request whose
 * scope targets paths outside the agent's working directory.
 */
function isFilesystemScopeExpansion(event: {
  readonly capability: CapabilityType;
  readonly workingDir: string;
  readonly destination: string;
  readonly scope: ReadonlyArray<{
    readonly type: CapabilityType;
    readonly targets: readonly string[];
  }>;
}): boolean {
  if (event.capability !== Cap.Filesystem) {
    return false;
  }
  const workingDir = event.workingDir;
  // Check each scope target — if any target is outside the working directory,
  // this is a scope expansion.
  for (const scopeEntry of event.scope) {
    for (const target of scopeEntry.targets) {
      if (!isPathWithin(target, workingDir)) {
        return true;
      }
    }
  }
  // Also check the destination field.
  if (event.destination && !isPathWithin(event.destination, workingDir)) {
    return true;
  }
  return false;
}

/** Whether `path` is within (or equal to) `baseDir`. */
function isPathWithin(path: string, baseDir: string): boolean {
  // Normalize trailing separators.
  const normalizedBase = baseDir.endsWith('/') ? baseDir : `${baseDir}/`;
  const normalizedPath = path.endsWith('/') ? path.slice(0, -1) : path;
  return normalizedPath === baseDir.slice(0, -1) || normalizedPath.startsWith(normalizedBase);
}
