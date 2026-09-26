/**
 * Codex app-server JSON-RPC event shapes and mapping functions (DEC-013,
 * DEC-010, issue #10).
 *
 * The Codex app-server exposes a local JSON-RPC API over a WebSocket (or
 * stdio) transport. It streams structured events for thread/turn lifecycle,
 * tool calls, file changes, test runs, and permission requests. This module
 * defines the wire shapes for those events and provides pure mapping
 * functions that normalize them into the canonical {@link SupervisorEvent}
 * schema (DEC-019).
 *
 * Design rules:
 * - Mapping functions are pure: they take a Codex event + envelope context
 *   and return a {@link SupervisorEvent}. No I/O, no side effects.
 * - Permission requests map to `ApprovalRequested` with the full structured
 *   capability fields per DEC-010 (capability, destination, scope, ...).
 * - The mapper never invents data: fields absent on the wire are omitted on
 *   the output (optional fields) or defaulted conservatively.
 */
import type { AdapterFidelityTier } from '../../../core/domain/enums.js';
import type { SupervisorEvent } from '../../../core/domain/events.js';
import type {
  CapabilityType,
  CapabilityRiskLevel,
  CapabilityScope,
} from '../../../core/domain/capabilities.js';
import {
  CapabilityType as CapType,
  CapabilityRiskLevel as RiskLevel,
} from '../../../core/domain/capabilities.js';

/* ------------------------------------------------------------------ *
 * Codex JSON-RPC wire shapes (server -> client notifications)
 * ------------------------------------------------------------------ */

/** Common fields on every Codex streamed event. */
export interface CodexEventBase {
  /** Discriminant identifying the Codex event kind. */
  readonly type: string;
  /** Codex thread id (maps to our sessionId). */
  readonly threadId: string;
  /** Codex turn id within the thread. */
  readonly turnId: string;
}

/** `thread.started` — a Codex thread/turn has begun. */
export interface CodexThreadStartedEvent extends CodexEventBase {
  readonly type: 'thread.started';
  readonly objective: string;
  readonly workingDir: string;
  readonly model?: string;
}

/** `thread.progress` — routine progress update. */
export interface CodexThreadProgressEvent extends CodexEventBase {
  readonly type: 'thread.progress';
  readonly message: string;
  readonly step?: number;
  readonly totalSteps?: number;
}

/** A deliverable produced by a completed turn. */
export interface CodexDeliverable {
  readonly type: string;
  readonly ref: string;
  readonly summary?: string;
}

/** `thread.completed` — the turn finished successfully. */
export interface CodexThreadCompletedEvent extends CodexEventBase {
  readonly type: 'thread.completed';
  readonly summary: string;
  readonly deliverables: readonly CodexDeliverable[];
  readonly exitCode?: number;
  readonly durationMs?: number;
}

/** `thread.failed` — the turn failed. */
export interface CodexThreadFailedEvent extends CodexEventBase {
  readonly type: 'thread.failed';
  readonly error: string;
  readonly exitCode?: number;
  readonly stack?: string;
  readonly recoverable: boolean;
}

/** `thread.stopped` — the turn was stopped before completing. */
export interface CodexThreadStoppedEvent extends CodexEventBase {
  readonly type: 'thread.stopped';
  readonly reason: 'user' | 'timeout' | 'cancelled' | 'system';
  readonly details?: string;
}

/** `tool.started` — the agent invoked a tool. */
export interface CodexToolStartedEvent extends CodexEventBase {
  readonly type: 'tool.started';
  readonly toolName: string;
  readonly args?: Record<string, unknown>;
}

/** `tool.finished` — a tool invocation completed. */
export interface CodexToolFinishedEvent extends CodexEventBase {
  readonly type: 'tool.finished';
  readonly toolName: string;
  readonly args?: Record<string, unknown>;
  readonly result?: Record<string, unknown>;
  readonly success: boolean;
  readonly durationMs?: number;
  readonly error?: string;
}

/** `file.changed` — a file was modified by the agent. */
export interface CodexFileChangedEvent extends CodexEventBase {
  readonly type: 'file.changed';
  readonly path: string;
  readonly changeType: 'created' | 'modified' | 'deleted' | 'renamed';
  readonly oldPath?: string;
  readonly additions?: number;
  readonly deletions?: number;
}

/** `test.started` — a test run began. */
export interface CodexTestStartedEvent extends CodexEventBase {
  readonly type: 'test.started';
  readonly framework?: string;
  readonly target?: string;
  readonly command?: string;
}

/** Details of a single test failure reported by Codex. */
export interface CodexTestFailure {
  readonly name: string;
  readonly message: string;
}

/** `test.finished` — a test run completed. */
export interface CodexTestFinishedEvent extends CodexEventBase {
  readonly type: 'test.finished';
  readonly framework?: string;
  readonly target?: string;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly durationMs?: number;
  readonly failures?: readonly CodexTestFailure[];
}

/** A structured scope entry in a Codex permission request. */
export interface CodexPermissionScope {
  readonly type: string;
  readonly targets: readonly string[];
}

/** `permission.request` — the agent requests approval for a capability. */
export interface CodexPermissionRequestEvent extends CodexEventBase {
  readonly type: 'permission.request';
  /** Unique id for this request (used to match the approval response). */
  readonly requestId: string;
  /** The capability class: `filesystem` or `network`. */
  readonly capability: 'filesystem' | 'network';
  /** Destination/resource the capability targets (path, host, ...). */
  readonly destination: string;
  /** The exact command or operation, if applicable. */
  readonly command: string;
  /** Working directory in which the capability would execute. */
  readonly workingDir: string;
  /** Structured scope boundaries. */
  readonly scope: readonly CodexPermissionScope[];
  /** Risk level determined by Codex. */
  readonly riskLevel: 'low' | 'medium' | 'high' | 'critical';
}

/** Union of all Codex streamed event variants. */
export type CodexEvent =
  | CodexThreadStartedEvent
  | CodexThreadProgressEvent
  | CodexThreadCompletedEvent
  | CodexThreadFailedEvent
  | CodexThreadStoppedEvent
  | CodexToolStartedEvent
  | CodexToolFinishedEvent
  | CodexFileChangedEvent
  | CodexTestStartedEvent
  | CodexTestFinishedEvent
  | CodexPermissionRequestEvent;

/** Ordered list of all recognized Codex event type discriminants. */
export const CODEX_EVENT_TYPES: readonly string[] = [
  'thread.started',
  'thread.progress',
  'thread.completed',
  'thread.failed',
  'thread.stopped',
  'tool.started',
  'tool.finished',
  'file.changed',
  'test.started',
  'test.finished',
  'permission.request',
] as const;

/* ------------------------------------------------------------------ *
 * Envelope context
 * ------------------------------------------------------------------ */

/**
 * Context carried through every mapped event: the common envelope fields
 * that the adapter populates from its run configuration.
 */
export interface MapperContext {
  readonly taskId: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly adapterFidelityTier: AdapterFidelityTier;
  /** The objective delegated to the agent (for ApprovalRequested.task). */
  readonly objective: string;
  /** Working directory for the run (for ApprovalRequested.workingDir fallback). */
  readonly workingDir: string;
}

/* ------------------------------------------------------------------ *
 * Mapping helpers
 * ------------------------------------------------------------------ */

/** Generate an ISO-8601 timestamp for the current instant. */
function now(): string {
  return new Date().toISOString();
}

/**
 * Normalize a Codex capability string (`filesystem` | `network`) into the
 * canonical {@link CapabilityType} vocabulary.
 */
function mapCapabilityType(codexCap: 'filesystem' | 'network'): CapabilityType {
  if (codexCap === 'filesystem') {
    return CapType.Filesystem;
  }
  return CapType.Network;
}

/**
 * Normalize a Codex risk level string into the canonical
 * {@link CapabilityRiskLevel} vocabulary.
 */
function mapRiskLevel(codexRisk: 'low' | 'medium' | 'high' | 'critical'): CapabilityRiskLevel {
  switch (codexRisk) {
    case 'low':
      return RiskLevel.Low;
    case 'medium':
      return RiskLevel.Medium;
    case 'high':
      return RiskLevel.High;
    case 'critical':
      return RiskLevel.Critical;
  }
}

/**
 * Map Codex permission scope entries to canonical {@link CapabilityScope}
 * entries. Each entry's `type` is normalized to a valid CapabilityType.
 */
function mapScope(
  codexScope: readonly CodexPermissionScope[],
  fallbackCapability: CapabilityType,
  fallbackDestination: string,
): CapabilityScope[] {
  if (codexScope.length === 0) {
    return [
      { type: fallbackCapability, targets: fallbackDestination ? [fallbackDestination] : [] },
    ];
  }
  return codexScope.map((entry) => ({
    type: mapCapabilityType(entry.type as 'filesystem' | 'network'),
    targets: [...entry.targets],
  }));
}

/* ------------------------------------------------------------------ *
 * Individual event mappers
 * ------------------------------------------------------------------ */

/** Map `thread.started` → `AgentStarted`. */
export function mapThreadStarted(
  event: CodexThreadStartedEvent,
  ctx: MapperContext,
): SupervisorEvent {
  return {
    type: 'AgentStarted',
    timestamp: now(),
    taskId: ctx.taskId,
    sessionId: ctx.sessionId,
    agentId: ctx.agentId,
    adapterFidelityTier: ctx.adapterFidelityTier,
    objective: event.objective,
    workingDir: event.workingDir,
    model: event.model,
  };
}

/** Map `thread.progress` → `AgentProgress`. */
export function mapThreadProgress(
  event: CodexThreadProgressEvent,
  ctx: MapperContext,
): SupervisorEvent {
  return {
    type: 'AgentProgress',
    timestamp: now(),
    taskId: ctx.taskId,
    sessionId: ctx.sessionId,
    agentId: ctx.agentId,
    adapterFidelityTier: ctx.adapterFidelityTier,
    message: event.message,
    step: event.step,
    totalSteps: event.totalSteps,
  };
}

/** Map `thread.completed` → `AgentCompleted`. */
export function mapThreadCompleted(
  event: CodexThreadCompletedEvent,
  ctx: MapperContext,
): SupervisorEvent {
  return {
    type: 'AgentCompleted',
    timestamp: now(),
    taskId: ctx.taskId,
    sessionId: ctx.sessionId,
    agentId: ctx.agentId,
    adapterFidelityTier: ctx.adapterFidelityTier,
    summary: event.summary,
    deliverables: event.deliverables.map((d) => ({
      type: d.type,
      ref: d.ref,
      summary: d.summary,
    })),
    exitCode: event.exitCode,
    durationMs: event.durationMs,
  };
}

/** Map `thread.failed` → `AgentFailed`. */
export function mapThreadFailed(
  event: CodexThreadFailedEvent,
  ctx: MapperContext,
): SupervisorEvent {
  return {
    type: 'AgentFailed',
    timestamp: now(),
    taskId: ctx.taskId,
    sessionId: ctx.sessionId,
    agentId: ctx.agentId,
    adapterFidelityTier: ctx.adapterFidelityTier,
    error: event.error,
    exitCode: event.exitCode,
    stack: event.stack,
    recoverable: event.recoverable,
  };
}

/** Map `thread.stopped` → `AgentStopped`. */
export function mapThreadStopped(
  event: CodexThreadStoppedEvent,
  ctx: MapperContext,
): SupervisorEvent {
  return {
    type: 'AgentStopped',
    timestamp: now(),
    taskId: ctx.taskId,
    sessionId: ctx.sessionId,
    agentId: ctx.agentId,
    adapterFidelityTier: ctx.adapterFidelityTier,
    reason: event.reason,
    details: event.details,
  };
}

/** Map `tool.started` → `ToolStarted`. */
export function mapToolStarted(event: CodexToolStartedEvent, ctx: MapperContext): SupervisorEvent {
  return {
    type: 'ToolStarted',
    timestamp: now(),
    taskId: ctx.taskId,
    sessionId: ctx.sessionId,
    agentId: ctx.agentId,
    adapterFidelityTier: ctx.adapterFidelityTier,
    toolName: event.toolName,
    args: event.args,
  };
}

/** Map `tool.finished` → `ToolFinished`. */
export function mapToolFinished(
  event: CodexToolFinishedEvent,
  ctx: MapperContext,
): SupervisorEvent {
  return {
    type: 'ToolFinished',
    timestamp: now(),
    taskId: ctx.taskId,
    sessionId: ctx.sessionId,
    agentId: ctx.agentId,
    adapterFidelityTier: ctx.adapterFidelityTier,
    toolName: event.toolName,
    args: event.args,
    result: event.result,
    success: event.success,
    durationMs: event.durationMs,
    error: event.error,
  };
}

/** Map `file.changed` → `FileChanged`. */
export function mapFileChanged(event: CodexFileChangedEvent, ctx: MapperContext): SupervisorEvent {
  return {
    type: 'FileChanged',
    timestamp: now(),
    taskId: ctx.taskId,
    sessionId: ctx.sessionId,
    agentId: ctx.agentId,
    adapterFidelityTier: ctx.adapterFidelityTier,
    path: event.path,
    changeType: event.changeType,
    oldPath: event.oldPath,
    additions: event.additions,
    deletions: event.deletions,
  };
}

/** Map `test.started` → `TestStarted`. */
export function mapTestStarted(event: CodexTestStartedEvent, ctx: MapperContext): SupervisorEvent {
  return {
    type: 'TestStarted',
    timestamp: now(),
    taskId: ctx.taskId,
    sessionId: ctx.sessionId,
    agentId: ctx.agentId,
    adapterFidelityTier: ctx.adapterFidelityTier,
    framework: event.framework,
    target: event.target,
    command: event.command,
  };
}

/** Map `test.finished` → `TestFinished`. */
export function mapTestFinished(
  event: CodexTestFinishedEvent,
  ctx: MapperContext,
): SupervisorEvent {
  return {
    type: 'TestFinished',
    timestamp: now(),
    taskId: ctx.taskId,
    sessionId: ctx.sessionId,
    agentId: ctx.agentId,
    adapterFidelityTier: ctx.adapterFidelityTier,
    framework: event.framework,
    target: event.target,
    passed: event.passed,
    failed: event.failed,
    skipped: event.skipped,
    durationMs: event.durationMs,
    failures: event.failures?.map((f) => ({ name: f.name, message: f.message })),
  };
}

/**
 * Map `permission.request` → `ApprovalRequested` with the full structured
 * capability fields per DEC-010 (capability, destination, command,
 * workingDir, scope, riskLevel).
 *
 * The human authorizes the deterministic adapter fields — never an LLM
 * summary.
 */
export function mapPermissionRequest(
  event: CodexPermissionRequestEvent,
  ctx: MapperContext,
): SupervisorEvent {
  const capability = mapCapabilityType(event.capability);
  return {
    type: 'ApprovalRequested',
    timestamp: now(),
    taskId: ctx.taskId,
    sessionId: ctx.sessionId,
    agentId: ctx.agentId,
    adapterFidelityTier: ctx.adapterFidelityTier,
    task: ctx.objective,
    agent: ctx.agentId,
    capability,
    destination: event.destination,
    command: event.command,
    workingDir: event.workingDir || ctx.workingDir,
    scope: mapScope(event.scope, capability, event.destination),
    riskLevel: mapRiskLevel(event.riskLevel),
  };
}

/* ------------------------------------------------------------------ *
 * Top-level dispatch mapper
 * ------------------------------------------------------------------ */

/**
 * Map any recognized Codex event to its canonical {@link SupervisorEvent}
 * variant. Returns `null` for unrecognized event types so the adapter can
 * skip or log them without crashing.
 *
 * @param event - The parsed Codex JSON-RPC notification payload.
 * @param ctx - Envelope context (taskId, sessionId, agentId, ...).
 * @returns The normalized SupervisorEvent, or `null` if the event type is
 *   not recognized.
 */
export function mapCodexEvent(event: CodexEvent, ctx: MapperContext): SupervisorEvent | null {
  switch (event.type) {
    case 'thread.started':
      return mapThreadStarted(event, ctx);
    case 'thread.progress':
      return mapThreadProgress(event, ctx);
    case 'thread.completed':
      return mapThreadCompleted(event, ctx);
    case 'thread.failed':
      return mapThreadFailed(event, ctx);
    case 'thread.stopped':
      return mapThreadStopped(event, ctx);
    case 'tool.started':
      return mapToolStarted(event, ctx);
    case 'tool.finished':
      return mapToolFinished(event, ctx);
    case 'file.changed':
      return mapFileChanged(event, ctx);
    case 'test.started':
      return mapTestStarted(event, ctx);
    case 'test.finished':
      return mapTestFinished(event, ctx);
    case 'permission.request':
      return mapPermissionRequest(event, ctx);
    default:
      return null;
  }
}

/**
 * Type guard: is the given value a recognized Codex event?
 */
export function isCodexEvent(value: unknown): value is CodexEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const type = (value as Record<string, unknown>).type;
  return typeof type === 'string' && CODEX_EVENT_TYPES.includes(type);
}

/* ------------------------------------------------------------------ *
 * Modern Codex app-server wire shapes (turn/start, thread/start, items)
 * ------------------------------------------------------------------ */

export interface ModernTurnStartedNotification {
  readonly threadId: string;
  readonly turn: {
    readonly id: string;
    readonly status?: string;
    readonly startedAt?: number | null;
  };
}

export interface ModernTurnCompletedNotification {
  readonly threadId: string;
  readonly turn: {
    readonly id: string;
    readonly status: 'completed' | 'interrupted' | 'failed' | 'inProgress';
    readonly error?: { readonly message?: string } | null;
    readonly durationMs?: number | null;
  };
}

export interface ModernItemStartedNotification {
  readonly threadId: string;
  readonly turnId: string;
  readonly item: {
    readonly id: string;
    readonly type: string;
    readonly [key: string]: unknown;
  };
}

export interface ModernItemCompletedNotification {
  readonly threadId: string;
  readonly turnId: string;
  readonly item: {
    readonly id: string;
    readonly type: string;
    readonly [key: string]: unknown;
  };
}

export interface ModernAgentMessageDeltaNotification {
  readonly threadId: string;
  readonly turnId: string;
  readonly delta: string;
}

export interface ModernPatchUpdatedNotification {
  readonly threadId: string;
  readonly turnId: string;
  readonly path?: string;
}

export interface ModernCommandExecutionApprovalParams {
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly command?: string | null;
  readonly cwd?: string | null;
  readonly reason?: string | null;
  readonly kind?: string;
}

export interface ModernFileChangeApprovalParams {
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly changes?: ReadonlyArray<{
    readonly path?: string;
    readonly kind?: string;
    readonly diff?: string;
  }> | null;
}

export interface ModernPermissionsApprovalParams {
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly reason?: string | null;
  readonly permissions?: Record<string, unknown>;
}

/* ------------------------------------------------------------------ *
 * Modern Codex app-server event mappers
 * ------------------------------------------------------------------ */

/** Map modern `turn/started` -> `AgentStarted`. */
export function mapModernTurnStarted(
  _params: ModernTurnStartedNotification,
  ctx: MapperContext,
): SupervisorEvent {
  return {
    type: 'AgentStarted',
    timestamp: now(),
    taskId: ctx.taskId,
    sessionId: ctx.sessionId,
    agentId: ctx.agentId,
    adapterFidelityTier: ctx.adapterFidelityTier,
    objective: ctx.objective,
    workingDir: ctx.workingDir,
  };
}

/** Map modern `turn/completed` -> `AgentCompleted` | `AgentFailed` | `AgentStopped`. */
export function mapModernTurnCompleted(
  params: ModernTurnCompletedNotification,
  ctx: MapperContext,
): SupervisorEvent {
  const turn = params.turn;
  if (turn.status === 'failed') {
    return {
      type: 'AgentFailed',
      timestamp: now(),
      taskId: ctx.taskId,
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      adapterFidelityTier: ctx.adapterFidelityTier,
      error: turn.error?.message ?? 'Codex turn failed',
      recoverable: true,
    };
  }
  if (turn.status === 'interrupted') {
    return {
      type: 'AgentStopped',
      timestamp: now(),
      taskId: ctx.taskId,
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      adapterFidelityTier: ctx.adapterFidelityTier,
      reason: 'user',
      details: 'Codex turn interrupted',
    };
  }
  return {
    type: 'AgentCompleted',
    timestamp: now(),
    taskId: ctx.taskId,
    sessionId: ctx.sessionId,
    agentId: ctx.agentId,
    adapterFidelityTier: ctx.adapterFidelityTier,
    summary: 'Codex turn completed',
    deliverables: [],
    durationMs: turn.durationMs ?? undefined,
  };
}

/** Map modern `item/started` -> `ToolStarted` | `AgentProgress` | null. */
export function mapModernItemStarted(
  params: ModernItemStartedNotification,
  ctx: MapperContext,
): SupervisorEvent | null {
  const item = params.item;
  if (item.type === 'commandExecution') {
    const command = typeof item['command'] === 'string' ? item['command'] : '';
    return {
      type: 'ToolStarted',
      timestamp: now(),
      taskId: ctx.taskId,
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      adapterFidelityTier: ctx.adapterFidelityTier,
      toolName: 'shell',
      args: { command, cwd: item['cwd'] },
    };
  }
  if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') {
    const toolName = typeof item['tool'] === 'string' ? item['tool'] : 'tool';
    return {
      type: 'ToolStarted',
      timestamp: now(),
      taskId: ctx.taskId,
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      adapterFidelityTier: ctx.adapterFidelityTier,
      toolName,
      args: (item['arguments'] as Record<string, unknown>) ?? {},
    };
  }
  if (item.type === 'plan') {
    const text = typeof item['text'] === 'string' ? item['text'] : '';
    return {
      type: 'AgentProgress',
      timestamp: now(),
      taskId: ctx.taskId,
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      adapterFidelityTier: ctx.adapterFidelityTier,
      message: text,
    };
  }
  if (item.type === 'reasoning') {
    const summary = Array.isArray(item['summary'])
      ? item['summary'].join(' ')
      : 'Reasoning...';
    return {
      type: 'AgentProgress',
      timestamp: now(),
      taskId: ctx.taskId,
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      adapterFidelityTier: ctx.adapterFidelityTier,
      message: summary,
    };
  }
  return null;
}

/** Map modern `item/completed` -> `ToolFinished` | `FileChanged` | `AgentProgress` | null. */
export function mapModernItemCompleted(
  params: ModernItemCompletedNotification,
  ctx: MapperContext,
): SupervisorEvent | null {
  const item = params.item;
  if (item.type === 'commandExecution') {
    const command = typeof item['command'] === 'string' ? item['command'] : '';
    const exitCode = typeof item['exitCode'] === 'number' ? item['exitCode'] : 0;
    return {
      type: 'ToolFinished',
      timestamp: now(),
      taskId: ctx.taskId,
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      adapterFidelityTier: ctx.adapterFidelityTier,
      toolName: 'shell',
      args: { command },
      result: {
        exitCode,
        output: typeof item['aggregatedOutput'] === 'string' ? item['aggregatedOutput'] : '',
      },
      success: exitCode === 0,
      durationMs: typeof item['durationMs'] === 'number' ? item['durationMs'] : undefined,
    };
  }
  if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') {
    const toolName = typeof item['tool'] === 'string' ? item['tool'] : 'tool';
    const status = typeof item['status'] === 'string' ? item['status'] : 'completed';
    const success = item['success'] !== undefined ? Boolean(item['success']) : status === 'completed';
    return {
      type: 'ToolFinished',
      timestamp: now(),
      taskId: ctx.taskId,
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      adapterFidelityTier: ctx.adapterFidelityTier,
      toolName,
      args: (item['arguments'] as Record<string, unknown>) ?? {},
      result: (item['result'] as Record<string, unknown>) ?? {},
      success,
      durationMs: typeof item['durationMs'] === 'number' ? item['durationMs'] : undefined,
    };
  }
  if (item.type === 'fileChange') {
    const changes = Array.isArray(item['changes']) ? item['changes'] : [];
    const first = changes[0] as { path?: string; kind?: string } | undefined;
    const path = first?.path ?? 'unknown';
    const changeType =
      first?.kind === 'add'
        ? 'created'
        : first?.kind === 'delete'
          ? 'deleted'
          : 'modified';
    return {
      type: 'FileChanged',
      timestamp: now(),
      taskId: ctx.taskId,
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      adapterFidelityTier: ctx.adapterFidelityTier,
      path,
      changeType,
    };
  }
  if (item.type === 'agentMessage') {
    const text = typeof item['text'] === 'string' ? item['text'] : '';
    if (text.length > 0) {
      return {
        type: 'AgentProgress',
        timestamp: now(),
        taskId: ctx.taskId,
        sessionId: ctx.sessionId,
        agentId: ctx.agentId,
        adapterFidelityTier: ctx.adapterFidelityTier,
        message: text,
      };
    }
  }
  return null;
}

/** Map modern `item/agentMessage/delta` -> `AgentProgress`. */
export function mapModernMessageDelta(
  params: ModernAgentMessageDeltaNotification,
  ctx: MapperContext,
): SupervisorEvent {
  return {
    type: 'AgentProgress',
    timestamp: now(),
    taskId: ctx.taskId,
    sessionId: ctx.sessionId,
    agentId: ctx.agentId,
    adapterFidelityTier: ctx.adapterFidelityTier,
    message: params.delta,
  };
}

/** Map modern command execution approval request -> `ApprovalRequested` (DEC-010/011). */
export function mapCommandExecutionApproval(
  params: ModernCommandExecutionApprovalParams,
  ctx: MapperContext,
): SupervisorEvent {
  const cmd = params.command ?? 'shell';
  return {
    type: 'ApprovalRequested',
    timestamp: now(),
    taskId: ctx.taskId,
    sessionId: ctx.sessionId,
    agentId: ctx.agentId,
    adapterFidelityTier: ctx.adapterFidelityTier,
    task: ctx.objective,
    agent: ctx.agentId,
    capability: CapType.Shell,
    destination: cmd,
    command: cmd,
    workingDir: params.cwd || ctx.workingDir,
    scope: [{ type: CapType.Shell, targets: [cmd] }],
    riskLevel: RiskLevel.High,
  };
}

/** Map modern file change approval request -> `ApprovalRequested` (DEC-010/011). */
export function mapFileChangeApproval(
  params: ModernFileChangeApprovalParams,
  ctx: MapperContext,
): SupervisorEvent {
  const firstChange = params.changes?.[0];
  const path = firstChange?.path ?? 'files';
  return {
    type: 'ApprovalRequested',
    timestamp: now(),
    taskId: ctx.taskId,
    sessionId: ctx.sessionId,
    agentId: ctx.agentId,
    adapterFidelityTier: ctx.adapterFidelityTier,
    task: ctx.objective,
    agent: ctx.agentId,
    capability: CapType.Filesystem,
    destination: path,
    command: firstChange?.kind ?? 'patch',
    workingDir: ctx.workingDir,
    scope: [{ type: CapType.Filesystem, targets: [path] }],
    riskLevel: RiskLevel.High,
  };
}

/** Map modern permissions approval request -> `ApprovalRequested` (DEC-010/011). */
export function mapPermissionsApproval(
  params: ModernPermissionsApprovalParams,
  ctx: MapperContext,
): SupervisorEvent {
  const target = params.reason ?? 'permissions';
  return {
    type: 'ApprovalRequested',
    timestamp: now(),
    taskId: ctx.taskId,
    sessionId: ctx.sessionId,
    agentId: ctx.agentId,
    adapterFidelityTier: ctx.adapterFidelityTier,
    task: ctx.objective,
    agent: ctx.agentId,
    capability: CapType.Other,
    destination: target,
    command: 'request_permissions',
    workingDir: ctx.workingDir,
    scope: [{ type: CapType.Other, targets: [target] }],
    riskLevel: RiskLevel.High,
  };
}

/**
 * Unified notification/request dispatcher: maps either modern top-level
 * methods or legacy wrapped `codex.event` payloads.
 */
export function mapCodexNotification(
  method: string,
  params: unknown,
  ctx: MapperContext,
): SupervisorEvent | null {
  if (method === 'codex.event' && isCodexEvent(params)) {
    return mapCodexEvent(params, ctx);
  }
  switch (method) {
    case 'turn/started':
      return mapModernTurnStarted(params as ModernTurnStartedNotification, ctx);
    case 'turn/completed':
      return mapModernTurnCompleted(params as ModernTurnCompletedNotification, ctx);
    case 'item/started':
      return mapModernItemStarted(params as ModernItemStartedNotification, ctx);
    case 'item/completed':
      return mapModernItemCompleted(params as ModernItemCompletedNotification, ctx);
    case 'item/agentMessage/delta':
      return mapModernMessageDelta(params as ModernAgentMessageDeltaNotification, ctx);
    case 'item/fileChange/patchUpdated': {
      const p = params as ModernPatchUpdatedNotification;
      return {
        type: 'FileChanged',
        timestamp: now(),
        taskId: ctx.taskId,
        sessionId: ctx.sessionId,
        agentId: ctx.agentId,
        adapterFidelityTier: ctx.adapterFidelityTier,
        path: p.path ?? 'unknown',
        changeType: 'modified',
      };
    }
    case 'item/commandExecution/requestApproval':
    case 'execCommandApproval':
      return mapCommandExecutionApproval(params as ModernCommandExecutionApprovalParams, ctx);
    case 'item/fileChange/requestApproval':
    case 'applyPatchApproval':
      return mapFileChangeApproval(params as ModernFileChangeApprovalParams, ctx);
    case 'item/permissions/requestApproval':
      return mapPermissionsApproval(params as ModernPermissionsApprovalParams, ctx);
    default:
      return null;
  }
}

