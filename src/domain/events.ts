/**
 * Canonical `SupervisorEvent` schema (DEC-019).
 *
 * Every agent adapter (Codex app-server, Claude Code hooks, ACP-native, JSON
 * CLI, PTY heuristic) normalizes its provider-specific observations into this
 * single discriminated union before they reach the attention engine, the event
 * journal, or any human-facing surface.
 *
 * Design rules enforced by this module:
 * - The `type` field is the discriminant for the 13-variant union.
 * - Every variant carries the common envelope: `timestamp`, `taskId`,
 *   `sessionId`, `agentId`, and `adapterFidelityTier`.
 * - `ApprovalRequested` and `HumanInputRequested` carry structured capability
 *   fields per DEC-010 — the human authorizes deterministic adapter data, never
 *   an LLM summary. LLM explanation is supplemental only.
 * - `serializeEvent` / `deserializeEvent` round-trip losslessly to JSON and
 *   reject malformed input with clear, typed validation errors.
 *
 * @example AgentStarted
 * ```json
 * {
 *   "type": "AgentStarted",
 *   "timestamp": "2026-08-19T12:00:00.000Z",
 *   "taskId": "task-42",
 *   "sessionId": "sess-7",
 *   "agentId": "codex",
 *   "adapterFidelityTier": "A",
 *   "objective": "Add cursor pagination to invoices",
 *   "workingDir": "/repo/invoices",
 *   "model": "gpt-5"
 * }
 * ```
 *
 * @example ApprovalRequested
 * ```json
 * {
 *   "type": "ApprovalRequested",
 *   "timestamp": "2026-08-19T12:01:00.000Z",
 *   "taskId": "task-42",
 *   "sessionId": "sess-7",
 *   "agentId": "codex",
 *   "adapterFidelityTier": "A",
 *   "task": "Add cursor pagination to invoices",
 *   "agent": "codex",
 *   "capability": "network",
 *   "destination": "registry.npmjs.org",
 *   "command": "npm install",
 *   "workingDir": "/repo/invoices",
 *   "scope": [{ "type": "network", "targets": ["registry.npmjs.org"] }],
 *   "riskLevel": "low"
 * }
 * ```
 */

import type { AdapterFidelityTier } from './enums.js';
import type { SupervisorEventKind } from './types.js';
import { CAPABILITY_TYPE_VALUES, CAPABILITY_RISK_LEVEL_VALUES } from './capabilities.js';
import type {
  CapabilityType,
  CapabilityRiskLevel,
  CapabilityRequest,
  ISO8601Timestamp,
} from './capabilities.js';

// The canonical capability vocabulary (CapabilityType, CapabilityScope,
// CapabilityRequest, CapabilityRiskLevel, ISO8601Timestamp) lives in
// `./capabilities.js` (DEC-010). It is re-exported to consumers via
// `./index.js`; this module imports it only for its own validation logic.
/** Risk classification for a capability request (DEC-010 / DEC-011). */
export type RiskLevel = CapabilityRiskLevel;

/**
 * Adapter fidelity tier (DEC-013 / PRODUCT_DESIGN). The canonical definition
 * lives in `./enums.js`; it is imported here so event variants share a single
 * source of truth.
 */

/** Common envelope shared by every SupervisorEvent variant. */
export interface SupervisorEventBase {
  /** Discriminant identifying the event variant. */
  type: SupervisorEventKind;
  /** ISO-8601 timestamp of when the event was observed. */
  timestamp: ISO8601Timestamp;
  /** Identifier of the Task this event belongs to (DEC-004). */
  taskId: string;
  /** Identifier of the Session (run) that emitted the event. */
  sessionId: string;
  /** Identifier of the agent that produced the event. */
  agentId: string;
  /** Fidelity tier of the adapter that normalized this event. */
  adapterFidelityTier: AdapterFidelityTier;
}

/**
 * The 13 canonical event variant discriminants (DEC-019). This is an alias of
 * the `SupervisorEventKind` defined in `./types.js` so the events module and
 * the journaled `Event` envelope share one source of truth for the kind set.
 */
export type SupervisorEventType = SupervisorEventKind;

/**
 * Emitted when an agent begins working on a task.
 *
 * @example
 * { type: "AgentStarted", objective: "Fix cache bug", workingDir: "/repo", model: "gpt-5" }
 */
export interface AgentStartedEvent extends SupervisorEventBase {
  type: 'AgentStarted';
  /** The objective delegated to the agent. */
  objective: string;
  /** Working directory (worktree) the agent runs in. */
  workingDir: string;
  /** Autonomy/approval policy in effect, if known. */
  autonomyLevel?: string;
  /** Model identifier the agent is using, if known. */
  model?: string;
}

/**
 * Emitted for routine progress / informational updates that do not warrant
 * their own structured event.
 *
 * @example
 * { type: "AgentProgress", message: "Analyzing repository structure", step: 2, totalSteps: 5 }
 */
export interface AgentProgressEvent extends SupervisorEventBase {
  type: 'AgentProgress';
  /** Human-readable progress message. */
  message: string;
  /** Current step index, when the agent reports discrete steps. */
  step?: number;
  /** Total expected steps, when the agent reports discrete steps. */
  totalSteps?: number;
}

/**
 * Emitted when an agent invokes a tool.
 *
 * @example
 * { type: "ToolStarted", toolName: "shell", args: { "cmd": "npm test" } }
 */
export interface ToolStartedEvent extends SupervisorEventBase {
  type: 'ToolStarted';
  /** Name of the tool being invoked. */
  toolName: string;
  /** Structured arguments passed to the tool, if available. */
  args?: Record<string, unknown>;
}

/**
 * Emitted when a tool invocation completes.
 *
 * @example
 * { type: "ToolFinished", toolName: "shell", success: true, durationMs: 1200 }
 */
export interface ToolFinishedEvent extends SupervisorEventBase {
  type: 'ToolFinished';
  /** Name of the tool that was invoked. */
  toolName: string;
  /** Structured arguments passed to the tool, if available. */
  args?: Record<string, unknown>;
  /** Structured result returned by the tool, if available. */
  result?: Record<string, unknown>;
  /** Whether the tool invocation succeeded. */
  success: boolean;
  /** Wall-clock duration of the invocation in milliseconds. */
  durationMs?: number;
  /** Error message when `success` is false. */
  error?: string;
}

/** Kind of filesystem change observed. */
export type FileChangeType = 'created' | 'modified' | 'deleted' | 'renamed';

/**
 * Emitted when a file is changed by an agent.
 *
 * @example
 * { type: "FileChanged", path: "src/auth.ts", changeType: "modified", additions: 12, deletions: 3 }
 */
export interface FileChangedEvent extends SupervisorEventBase {
  type: 'FileChanged';
  /** Repository-relative path of the changed file. */
  path: string;
  /** Nature of the change. */
  changeType: FileChangeType;
  /** Previous path for `renamed` changes. */
  oldPath?: string;
  /** Lines added, when diff stats are available. */
  additions?: number;
  /** Lines deleted, when diff stats are available. */
  deletions?: number;
}

/**
 * Emitted when a test run begins.
 *
 * @example
 * { type: "TestStarted", framework: "vitest", target: "src/auth.test.ts", command: "npm test" }
 */
export interface TestStartedEvent extends SupervisorEventBase {
  type: 'TestStarted';
  /** Test framework name, if known. */
  framework?: string;
  /** Test target (file, directory, or suite), if known. */
  target?: string;
  /** The command used to launch the tests, if known. */
  command?: string;
}

/** Details of a single test failure. */
export interface TestFailure {
  /** Name of the failing test. */
  name: string;
  /** Failure message / assertion detail. */
  message: string;
}

/**
 * Emitted when a test run completes.
 *
 * @example
 * { type: "TestFinished", passed: 23, failed: 1, skipped: 0, durationMs: 4500 }
 */
export interface TestFinishedEvent extends SupervisorEventBase {
  type: 'TestFinished';
  /** Test framework name, if known. */
  framework?: string;
  /** Test target (file, directory, or suite), if known. */
  target?: string;
  /** Number of tests that passed. */
  passed: number;
  /** Number of tests that failed. */
  failed: number;
  /** Number of tests that were skipped. */
  skipped: number;
  /** Wall-clock duration of the run in milliseconds. */
  durationMs?: number;
  /** Details of individual failures, when available. */
  failures?: TestFailure[];
}

/**
 * Emitted when an agent requests approval to perform a capability (DEC-010).
 *
 * The human authorizes the deterministic structured fields below — never an
 * LLM summary. LLM explanation is supplemental only.
 */
export interface ApprovalRequestedEvent extends SupervisorEventBase, CapabilityRequest {
  type: 'ApprovalRequested';
}

/**
 * Emitted when an agent requests human input (a question / clarification).
 *
 * Carries the same structured capability context as `ApprovalRequested` plus a
 * prompt describing the input needed (DEC-010).
 */
export interface HumanInputRequestedEvent extends SupervisorEventBase, CapabilityRequest {
  type: 'HumanInputRequested';
  /** The question or prompt requiring human input. */
  prompt: string;
  /** Kind of input expected. */
  inputType?: 'text' | 'choice' | 'confirm';
  /** Predefined choices when `inputType` is `choice`. */
  choices?: string[];
}

/** Why an agent is blocked. */
export type BlockerType = 'dependency' | 'resource' | 'permission' | 'unknown';

/**
 * Emitted when an agent cannot make progress without external intervention.
 *
 * @example
 * { type: "AgentBlocked", reason: "Waiting on PR review", blockerType: "dependency", retryable: true }
 */
export interface AgentBlockedEvent extends SupervisorEventBase {
  type: 'AgentBlocked';
  /** Human-readable reason the agent is blocked. */
  reason: string;
  /** Category of blocker. */
  blockerType: BlockerType;
  /** Whether the agent can resume without re-delegation once unblocked. */
  retryable: boolean;
  /** Additional structured details, if available. */
  details?: string;
}

/**
 * An artifact or meaningful result produced by a completed task, referenced
 * inline from an `AgentCompletedEvent`. This is the lightweight event payload
 * shape; the full journaled `Deliverable` entity lives in `./types.js`.
 */
export interface EventDeliverable {
  /** Kind of deliverable (e.g. `commit`, `diff`, `pr`, `analysis`). */
  type: string;
  /** Reference to the deliverable (sha, url, path, ...). */
  ref: string;
  /** Short summary of the deliverable. */
  summary?: string;
}

/**
 * Emitted when an agent reports task completion. A successful process exit does
 * not equal task completion — the task may still require human review.
 *
 * @example
 * { type: "AgentCompleted", summary: "Added cursor pagination", deliverables: [{ type: "commit", ref: "abc123" }], exitCode: 0 }
 */
export interface AgentCompletedEvent extends SupervisorEventBase {
  type: 'AgentCompleted';
  /** Agent-authored summary of what was achieved. */
  summary: string;
  /** Deliverables produced by the task. */
  deliverables: EventDeliverable[];
  /** Process exit code, if known. */
  exitCode?: number;
  /** Wall-clock duration of the run in milliseconds. */
  durationMs?: number;
}

/**
 * Emitted when an agent fails.
 *
 * @example
 * { type: "AgentFailed", error: "Non-zero exit", exitCode: 1, recoverable: true }
 */
export interface AgentFailedEvent extends SupervisorEventBase {
  type: 'AgentFailed';
  /** Error message describing the failure. */
  error: string;
  /** Process exit code, if known. */
  exitCode?: number;
  /** Stack trace, if available. */
  stack?: string;
  /** Whether the failure is recoverable (re-delegation may succeed). */
  recoverable: boolean;
}

/** Why an agent was stopped. */
export type StopReason = 'user' | 'timeout' | 'cancelled' | 'system';

/**
 * Emitted when an agent is stopped before completing.
 *
 * @example
 * { type: "AgentStopped", reason: "user", details: "User cancelled via CLI" }
 */
export interface AgentStoppedEvent extends SupervisorEventBase {
  type: 'AgentStopped';
  /** Why the agent was stopped. */
  reason: StopReason;
  /** Additional details about the stop, if available. */
  details?: string;
}

/**
 * The canonical discriminated union of all supervisor event variants (DEC-019).
 */
export type SupervisorEvent =
  | AgentStartedEvent
  | AgentProgressEvent
  | ToolStartedEvent
  | ToolFinishedEvent
  | FileChangedEvent
  | TestStartedEvent
  | TestFinishedEvent
  | ApprovalRequestedEvent
  | HumanInputRequestedEvent
  | AgentBlockedEvent
  | AgentCompletedEvent
  | AgentFailedEvent
  | AgentStoppedEvent;

/** Ordered list of all valid event type discriminants. */
export const SUPERVISOR_EVENT_TYPES: readonly SupervisorEventType[] = [
  'AgentStarted',
  'AgentProgress',
  'ToolStarted',
  'ToolFinished',
  'FileChanged',
  'TestStarted',
  'TestFinished',
  'ApprovalRequested',
  'HumanInputRequested',
  'AgentBlocked',
  'AgentCompleted',
  'AgentFailed',
  'AgentStopped',
] as const;

const ADAPTER_FIDELITY_TIERS: readonly AdapterFidelityTier[] = ['A', 'B', 'C', 'D', 'E'] as const;

const RISK_LEVELS: readonly RiskLevel[] = CAPABILITY_RISK_LEVEL_VALUES;

const CAPABILITY_TYPES: readonly CapabilityType[] = CAPABILITY_TYPE_VALUES;

const FILE_CHANGE_TYPES: readonly FileChangeType[] = [
  'created',
  'modified',
  'deleted',
  'renamed',
] as const;

const BLOCKER_TYPES: readonly BlockerType[] = [
  'dependency',
  'resource',
  'permission',
  'unknown',
] as const;

const STOP_REASONS: readonly StopReason[] = ['user', 'timeout', 'cancelled', 'system'] as const;

/**
 * Error thrown when an event fails validation. Carries a list of human-readable
 * validation problems for clear diagnostics.
 */
export class EventValidationError extends Error {
  /** The list of validation problems found. */
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    const message =
      problems.length === 0
        ? 'SupervisorEvent validation failed'
        : `SupervisorEvent validation failed:\n  - ${problems.join('\n  - ')}`;
    super(message);
    this.name = 'EventValidationError';
    this.problems = problems;
  }
}

const ISO_8601_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && !Number.isNaN(value);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return isString(value) && (allowed as readonly string[]).includes(value);
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return isObject(value);
}

/**
 * Validate an unknown value as a {@link SupervisorEvent}.
 *
 * @param value - The parsed JSON value to validate.
 * @returns The value typed as a {@link SupervisorEvent} if valid.
 * @throws {EventValidationError} when the value is not a valid event, with a
 *   clear list of every problem encountered.
 */
export function validateEvent(value: unknown): SupervisorEvent {
  const problems: string[] = [];

  if (!isObject(value)) {
    throw new EventValidationError(['Event must be a JSON object.']);
  }

  // Common envelope fields.
  if (!isString(value['type'])) {
    problems.push('Missing or non-string required field "type".');
  } else if (!isOneOf(value['type'], SUPERVISOR_EVENT_TYPES)) {
    problems.push(
      `Field "type" must be one of ${SUPERVISOR_EVENT_TYPES.join(', ')}; got "${value['type']}".`,
    );
  }

  if (!isString(value['timestamp'])) {
    problems.push('Missing or non-string required field "timestamp".');
  } else if (!ISO_8601_REGEX.test(value['timestamp'])) {
    problems.push(`Field "timestamp" must be an ISO-8601 string; got "${value['timestamp']}".`);
  }

  if (!isString(value['taskId']) || value['taskId'].length === 0) {
    problems.push('Missing or empty required field "taskId".');
  }
  if (!isString(value['sessionId']) || value['sessionId'].length === 0) {
    problems.push('Missing or empty required field "sessionId".');
  }
  if (!isString(value['agentId']) || value['agentId'].length === 0) {
    problems.push('Missing or empty required field "agentId".');
  }
  if (!isOneOf(value['adapterFidelityTier'], ADAPTER_FIDELITY_TIERS)) {
    problems.push('Field "adapterFidelityTier" must be one of A, B, C, D, E.');
  }

  const type = value['type'];

  switch (type) {
    case 'AgentStarted':
      validateAgentStarted(value, problems);
      break;
    case 'AgentProgress':
      validateAgentProgress(value, problems);
      break;
    case 'ToolStarted':
      validateToolStarted(value, problems);
      break;
    case 'ToolFinished':
      validateToolFinished(value, problems);
      break;
    case 'FileChanged':
      validateFileChanged(value, problems);
      break;
    case 'TestStarted':
      validateTestStarted(value, problems);
      break;
    case 'TestFinished':
      validateTestFinished(value, problems);
      break;
    case 'ApprovalRequested':
      validateCapabilityRequest(value, problems);
      break;
    case 'HumanInputRequested':
      validateCapabilityRequest(value, problems);
      validateHumanInputRequested(value, problems);
      break;
    case 'AgentBlocked':
      validateAgentBlocked(value, problems);
      break;
    case 'AgentCompleted':
      validateAgentCompleted(value, problems);
      break;
    case 'AgentFailed':
      validateAgentFailed(value, problems);
      break;
    case 'AgentStopped':
      validateAgentStopped(value, problems);
      break;
    // Unknown types are already reported via the envelope check above.
    default:
      break;
  }

  if (problems.length > 0) {
    throw new EventValidationError(problems);
  }

  return value as unknown as SupervisorEvent;
}

function validateAgentStarted(value: Record<string, unknown>, problems: string[]): void {
  if (!isString(value['objective']) || value['objective'].length === 0) {
    problems.push('AgentStarted: missing or empty required field "objective".');
  }
  if (!isString(value['workingDir']) || value['workingDir'].length === 0) {
    problems.push('AgentStarted: missing or empty required field "workingDir".');
  }
  if (value['autonomyLevel'] !== undefined && !isString(value['autonomyLevel'])) {
    problems.push('AgentStarted: optional field "autonomyLevel" must be a string.');
  }
  if (value['model'] !== undefined && !isString(value['model'])) {
    problems.push('AgentStarted: optional field "model" must be a string.');
  }
}

function validateAgentProgress(value: Record<string, unknown>, problems: string[]): void {
  if (!isString(value['message']) || value['message'].length === 0) {
    problems.push('AgentProgress: missing or empty required field "message".');
  }
  if (value['step'] !== undefined && !isNumber(value['step'])) {
    problems.push('AgentProgress: optional field "step" must be a number.');
  }
  if (value['totalSteps'] !== undefined && !isNumber(value['totalSteps'])) {
    problems.push('AgentProgress: optional field "totalSteps" must be a number.');
  }
}

function validateToolStarted(value: Record<string, unknown>, problems: string[]): void {
  if (!isString(value['toolName']) || value['toolName'].length === 0) {
    problems.push('ToolStarted: missing or empty required field "toolName".');
  }
  if (value['args'] !== undefined && !isUnknownRecord(value['args'])) {
    problems.push('ToolStarted: optional field "args" must be an object.');
  }
}

function validateToolFinished(value: Record<string, unknown>, problems: string[]): void {
  if (!isString(value['toolName']) || value['toolName'].length === 0) {
    problems.push('ToolFinished: missing or empty required field "toolName".');
  }
  if (!isBoolean(value['success'])) {
    problems.push('ToolFinished: missing or non-boolean required field "success".');
  }
  if (value['args'] !== undefined && !isUnknownRecord(value['args'])) {
    problems.push('ToolFinished: optional field "args" must be an object.');
  }
  if (value['result'] !== undefined && !isUnknownRecord(value['result'])) {
    problems.push('ToolFinished: optional field "result" must be an object.');
  }
  if (value['durationMs'] !== undefined && !isNumber(value['durationMs'])) {
    problems.push('ToolFinished: optional field "durationMs" must be a number.');
  }
  if (value['error'] !== undefined && !isString(value['error'])) {
    problems.push('ToolFinished: optional field "error" must be a string.');
  }
}

function validateFileChanged(value: Record<string, unknown>, problems: string[]): void {
  if (!isString(value['path']) || value['path'].length === 0) {
    problems.push('FileChanged: missing or empty required field "path".');
  }
  if (!isOneOf(value['changeType'], FILE_CHANGE_TYPES)) {
    problems.push(
      `FileChanged: field "changeType" must be one of ${FILE_CHANGE_TYPES.join(', ')}.`,
    );
  }
  if (value['oldPath'] !== undefined && !isString(value['oldPath'])) {
    problems.push('FileChanged: optional field "oldPath" must be a string.');
  }
  if (value['additions'] !== undefined && !isNumber(value['additions'])) {
    problems.push('FileChanged: optional field "additions" must be a number.');
  }
  if (value['deletions'] !== undefined && !isNumber(value['deletions'])) {
    problems.push('FileChanged: optional field "deletions" must be a number.');
  }
}

function validateTestStarted(value: Record<string, unknown>, problems: string[]): void {
  if (value['framework'] !== undefined && !isString(value['framework'])) {
    problems.push('TestStarted: optional field "framework" must be a string.');
  }
  if (value['target'] !== undefined && !isString(value['target'])) {
    problems.push('TestStarted: optional field "target" must be a string.');
  }
  if (value['command'] !== undefined && !isString(value['command'])) {
    problems.push('TestStarted: optional field "command" must be a string.');
  }
}

function validateTestFinished(value: Record<string, unknown>, problems: string[]): void {
  if (!isNumber(value['passed'])) {
    problems.push('TestFinished: missing or non-number required field "passed".');
  }
  if (!isNumber(value['failed'])) {
    problems.push('TestFinished: missing or non-number required field "failed".');
  }
  if (!isNumber(value['skipped'])) {
    problems.push('TestFinished: missing or non-number required field "skipped".');
  }
  if (value['framework'] !== undefined && !isString(value['framework'])) {
    problems.push('TestFinished: optional field "framework" must be a string.');
  }
  if (value['target'] !== undefined && !isString(value['target'])) {
    problems.push('TestFinished: optional field "target" must be a string.');
  }
  if (value['durationMs'] !== undefined && !isNumber(value['durationMs'])) {
    problems.push('TestFinished: optional field "durationMs" must be a number.');
  }
  if (value['failures'] !== undefined) {
    if (!Array.isArray(value['failures'])) {
      problems.push('TestFinished: optional field "failures" must be an array.');
    } else {
      value['failures'].forEach((f, i) => {
        if (!isObject(f)) {
          problems.push(`TestFinished: failures[${i}] must be an object.`);
          return;
        }
        if (!isString(f['name'])) {
          problems.push(`TestFinished: failures[${i}].name must be a string.`);
        }
        if (!isString(f['message'])) {
          problems.push(`TestFinished: failures[${i}].message must be a string.`);
        }
      });
    }
  }
}

function validateCapabilityRequest(value: Record<string, unknown>, problems: string[]): void {
  if (!isString(value['task']) || value['task'].length === 0) {
    problems.push('Capability request: missing or empty required field "task".');
  }
  if (!isString(value['agent']) || value['agent'].length === 0) {
    problems.push('Capability request: missing or empty required field "agent".');
  }
  if (!isOneOf(value['capability'], CAPABILITY_TYPES)) {
    problems.push(
      `Capability request: field "capability" must be one of ${CAPABILITY_TYPES.join(', ')}.`,
    );
  }
  if (!isString(value['destination'])) {
    problems.push('Capability request: missing or non-string required field "destination".');
  }
  if (!isString(value['command'])) {
    problems.push('Capability request: missing or non-string required field "command".');
  }
  if (!isString(value['workingDir'])) {
    problems.push('Capability request: missing or non-string required field "workingDir".');
  }
  if (!isOneOf(value['riskLevel'], RISK_LEVELS)) {
    problems.push(
      `Capability request: field "riskLevel" must be one of ${RISK_LEVELS.join(', ')}.`,
    );
  }
  if (!Array.isArray(value['scope'])) {
    problems.push('Capability request: required field "scope" must be an array.');
  } else {
    value['scope'].forEach((s, i) => {
      if (!isObject(s)) {
        problems.push(`Capability request: scope[${i}] must be an object.`);
        return;
      }
      if (!isOneOf(s['type'], CAPABILITY_TYPES)) {
        problems.push(
          `Capability request: scope[${i}].type must be one of ${CAPABILITY_TYPES.join(', ')}.`,
        );
      }
      if (!Array.isArray(s['targets']) || !s['targets'].every(isString)) {
        problems.push(`Capability request: scope[${i}].targets must be an array of strings.`);
      }
    });
  }
}

function validateHumanInputRequested(value: Record<string, unknown>, problems: string[]): void {
  if (!isString(value['prompt']) || value['prompt'].length === 0) {
    problems.push('HumanInputRequested: missing or empty required field "prompt".');
  }
  if (
    value['inputType'] !== undefined &&
    !isOneOf(value['inputType'], ['text', 'choice', 'confirm'] as const)
  ) {
    problems.push(
      'HumanInputRequested: optional field "inputType" must be one of text, choice, confirm.',
    );
  }
  if (value['choices'] !== undefined) {
    if (!Array.isArray(value['choices']) || !value['choices'].every(isString)) {
      problems.push('HumanInputRequested: optional field "choices" must be an array of strings.');
    }
  }
}

function validateAgentBlocked(value: Record<string, unknown>, problems: string[]): void {
  if (!isString(value['reason']) || value['reason'].length === 0) {
    problems.push('AgentBlocked: missing or empty required field "reason".');
  }
  if (!isOneOf(value['blockerType'], BLOCKER_TYPES)) {
    problems.push(`AgentBlocked: field "blockerType" must be one of ${BLOCKER_TYPES.join(', ')}.`);
  }
  if (!isBoolean(value['retryable'])) {
    problems.push('AgentBlocked: missing or non-boolean required field "retryable".');
  }
  if (value['details'] !== undefined && !isString(value['details'])) {
    problems.push('AgentBlocked: optional field "details" must be a string.');
  }
}

function validateAgentCompleted(value: Record<string, unknown>, problems: string[]): void {
  if (!isString(value['summary']) || value['summary'].length === 0) {
    problems.push('AgentCompleted: missing or empty required field "summary".');
  }
  if (!Array.isArray(value['deliverables'])) {
    problems.push('AgentCompleted: required field "deliverables" must be an array.');
  } else {
    value['deliverables'].forEach((d, i) => {
      if (!isObject(d)) {
        problems.push(`AgentCompleted: deliverables[${i}] must be an object.`);
        return;
      }
      if (!isString(d['type']) || d['type'].length === 0) {
        problems.push(`AgentCompleted: deliverables[${i}].type must be a non-empty string.`);
      }
      if (!isString(d['ref'])) {
        problems.push(`AgentCompleted: deliverables[${i}].ref must be a string.`);
      }
      if (d['summary'] !== undefined && !isString(d['summary'])) {
        problems.push(`AgentCompleted: deliverables[${i}].summary must be a string.`);
      }
    });
  }
  if (value['exitCode'] !== undefined && !isNumber(value['exitCode'])) {
    problems.push('AgentCompleted: optional field "exitCode" must be a number.');
  }
  if (value['durationMs'] !== undefined && !isNumber(value['durationMs'])) {
    problems.push('AgentCompleted: optional field "durationMs" must be a number.');
  }
}

function validateAgentFailed(value: Record<string, unknown>, problems: string[]): void {
  if (!isString(value['error']) || value['error'].length === 0) {
    problems.push('AgentFailed: missing or empty required field "error".');
  }
  if (!isBoolean(value['recoverable'])) {
    problems.push('AgentFailed: missing or non-boolean required field "recoverable".');
  }
  if (value['exitCode'] !== undefined && !isNumber(value['exitCode'])) {
    problems.push('AgentFailed: optional field "exitCode" must be a number.');
  }
  if (value['stack'] !== undefined && !isString(value['stack'])) {
    problems.push('AgentFailed: optional field "stack" must be a string.');
  }
}

function validateAgentStopped(value: Record<string, unknown>, problems: string[]): void {
  if (!isOneOf(value['reason'], STOP_REASONS)) {
    problems.push(`AgentStopped: field "reason" must be one of ${STOP_REASONS.join(', ')}.`);
  }
  if (value['details'] !== undefined && !isString(value['details'])) {
    problems.push('AgentStopped: optional field "details" must be a string.');
  }
}

/**
 * Serialize a {@link SupervisorEvent} to a canonical JSON string.
 *
 * The event is validated first, so malformed in-memory events are caught at
 * the serialization boundary rather than persisted to the journal.
 *
 * @param event - The event to serialize.
 * @returns A JSON string representation.
 * @throws {EventValidationError} when the event is invalid.
 */
export function serializeEvent(event: SupervisorEvent): string {
  validateEvent(event);
  return JSON.stringify(event);
}

/**
 * Deserialize a JSON string into a validated {@link SupervisorEvent}.
 *
 * @param json - The JSON string to parse and validate.
 * @returns The parsed and validated event.
 * @throws {EventValidationError} when the parsed value is not a valid event.
 * @throws {SyntaxError} when the input is not valid JSON.
 */
export function deserializeEvent(json: string): SupervisorEvent {
  const parsed: unknown = JSON.parse(json);
  return validateEvent(parsed);
}
