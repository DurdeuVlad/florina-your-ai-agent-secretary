/**
 * Claude Code hooks event shapes and mapping functions (DEC-013, DEC-010,
 * DEC-011, issue #40).
 *
 * Claude Code supports structured lifecycle hooks (PreToolUse, PostToolUse,
 * PermissionRequest, Stop, Notification, SessionStart, ...) that receive
 * deterministic JSON input on stdin. This module defines the wire shapes for
 * those hook events and provides pure mapping functions that normalize them
 * into the canonical {@link SupervisorEvent} schema (DEC-019).
 *
 * This is the real Tier B path per DEC-013: "installed CLI + structured
 * lifecycle hooks / Agent SDK". Unlike the PTY regex adapter (Tier E,
 * {@link claude-mapper}), hooks expose structured `tool_name` / `tool_input`
 * fields, so the mapper can populate the full DEC-010 capability fields
 * deterministically rather than guessing from unstructured text.
 *
 * Design rules:
 * - Mapping functions are pure: they take a hook event + envelope context and
 *   return zero or more {@link SupervisorEvent}s. No I/O, no side effects.
 * - Permission requests map to `ApprovalRequested` with structured capability
 *   fields per DEC-010. The capability and destination are inferred from the
 *   structured `tool_name` / `tool_input` fields, not from free text.
 * - The Secretary narrows permissions, never silently widens them (DEC-011).
 *   Any unstructured or unknown field falls back to conservative defaults:
 *   `CapabilityType.Other` and `CapabilityRiskLevel.Critical` so the attention
 *   engine never auto-approves an unrecognized request.
 * - The mapper never invents data: fields absent from the hook payload are
 *   defaulted conservatively, never optimistically.
 */
import type { AdapterFidelityTier } from '../domain/enums.js';
import type { SupervisorEvent } from '../domain/events.js';
import type { FileChangeType } from '../domain/events.js';
import {
  CapabilityType,
  CapabilityRiskLevel,
  type CapabilityType as CapType,
  type CapabilityRiskLevel as RiskLevel,
  type CapabilityScope,
} from '../domain/capabilities.js';

/* ------------------------------------------------------------------ *
 * Envelope context
 * ------------------------------------------------------------------ */

/**
 * Context carried through every mapped event: the common envelope fields that
 * the adapter populates from its run configuration. Mirrors the Codex / PTY
 * mapper contexts so all adapters share a consistent envelope contract.
 */
export interface ClaudeHooksMapperContext {
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
 * Claude Code hook event wire shapes (stdin JSON)
 * ------------------------------------------------------------------ */

/**
 * Common fields present on every Claude Code hook event payload (delivered on
 * stdin to the hook command). See the Claude Code hooks reference for the full
 * schema.
 */
export interface HookEventBase {
  /** The hook event name (e.g. `PreToolUse`, `PostToolUse`, `Stop`). */
  readonly hook_event_name: string;
  /** Current Claude Code session identifier. */
  readonly session_id: string;
  /** Current working directory when the hook is invoked. */
  readonly cwd: string;
  /** Current permission mode (e.g. `default`, `auto`, `plan`). */
  readonly permission_mode?: string;
}

/** `SessionStart` hook event — fires when a session begins or resumes. */
export interface SessionStartHookEvent extends HookEventBase {
  readonly hook_event_name: 'SessionStart';
  /** How the session started: `startup`, `resume`, `clear`, `compact`, `fork`. */
  readonly source: string;
  /** The active model identifier, when available. */
  readonly model?: string;
}

/** `PreToolUse` hook event — fires before a tool call executes. */
export interface PreToolUseHookEvent extends HookEventBase {
  readonly hook_event_name: 'PreToolUse';
  /** The tool name Claude is about to invoke (e.g. `Bash`, `Write`, `Edit`). */
  readonly tool_name: string;
  /** Structured arguments passed to the tool. */
  readonly tool_input: Record<string, unknown>;
  /** Unique id for this tool use. */
  readonly tool_use_id?: string;
}

/** `PostToolUse` hook event — fires after a tool call succeeds. */
export interface PostToolUseHookEvent extends HookEventBase {
  readonly hook_event_name: 'PostToolUse';
  /** The tool name that was invoked. */
  readonly tool_name: string;
  /** Structured arguments passed to the tool. */
  readonly tool_input: Record<string, unknown>;
  /** Structured result returned by the tool. */
  readonly tool_response?: Record<string, unknown>;
  /** Unique id for this tool use. */
  readonly tool_use_id?: string;
  /** Tool execution time in milliseconds. */
  readonly duration_ms?: number;
}

/** `PostToolUseFailure` hook event — fires after a tool call fails. */
export interface PostToolUseFailureHookEvent extends HookEventBase {
  readonly hook_event_name: 'PostToolUseFailure';
  readonly tool_name: string;
  readonly tool_input: Record<string, unknown>;
  /** The error returned by the tool. */
  readonly tool_response?: Record<string, unknown>;
  readonly tool_use_id?: string;
  readonly duration_ms?: number;
}

/** `PermissionRequest` hook event — fires when a tool call needs permission. */
export interface PermissionRequestHookEvent extends HookEventBase {
  readonly hook_event_name: 'PermissionRequest';
  readonly tool_name: string;
  readonly tool_input: Record<string, unknown>;
}

/** `Notification` hook event — fires when Claude Code sends a notification. */
export interface NotificationHookEvent extends HookEventBase {
  readonly hook_event_name: 'Notification';
  /** Notification text. */
  readonly message: string;
  /** Optional notification title. */
  readonly title?: string;
  /** Notification type (e.g. `permission_prompt`, `idle_prompt`). */
  readonly notification_type?: string;
}

/** `Stop` hook event — fires when Claude finishes responding. */
export interface StopHookEvent extends HookEventBase {
  readonly hook_event_name: 'Stop';
  /** Whether a stop hook is already active (prevents infinite loops). */
  readonly stop_hook_active?: boolean;
  /** The text content of Claude's final response. */
  readonly last_assistant_message?: string;
}

/** `StopFailure` hook event — fires when the turn ends due to an API error. */
export interface StopFailureHookEvent extends HookEventBase {
  readonly hook_event_name: 'StopFailure';
  /** Error type (e.g. `rate_limit`, `server_error`, `unknown`). */
  readonly error: string;
  /** Additional error details, when available. */
  readonly error_details?: string;
}

/** `SessionEnd` hook event — fires when a session terminates. */
export interface SessionEndHookEvent extends HookEventBase {
  readonly hook_event_name: 'SessionEnd';
}

/** Union of all recognized Claude Code hook event variants. */
export type ClaudeHookEvent =
  | SessionStartHookEvent
  | PreToolUseHookEvent
  | PostToolUseHookEvent
  | PostToolUseFailureHookEvent
  | PermissionRequestHookEvent
  | NotificationHookEvent
  | StopHookEvent
  | StopFailureHookEvent
  | SessionEndHookEvent;

/** Ordered list of all recognized hook event names. */
export const CLAUDE_HOOK_EVENT_NAMES: readonly string[] = [
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'Stop',
  'StopFailure',
  'SessionEnd',
] as const;

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Generate an ISO-8601 timestamp for the current instant. */
function now(): string {
  return new Date().toISOString();
}

/**
 * Infer a {@link CapabilityType} from a structured tool name and its input.
 *
 * Unlike the PTY mapper (which guesses from free text), the hooks mapper has
 * access to the deterministic `tool_name` field, so the inference is reliable:
 * - `Bash` / `PowerShell` → `Shell`
 * - `Write` / `Edit` / `Read` / `NotebookEdit` / `MultiEdit` → `Filesystem`
 * - `WebFetch` / `WebSearch` → `Network`
 * - `Agent` → `Other`
 * - Anything else → `Other` (conservative default, DEC-011)
 */
export function inferCapabilityFromTool(
  toolName: string,
  _toolInput?: Record<string, unknown>,
): CapType {
  switch (toolName) {
    case 'Bash':
    case 'PowerShell':
      return CapabilityType.Shell;
    case 'Write':
    case 'Edit':
    case 'Read':
    case 'NotebookEdit':
    case 'MultiEdit':
      return CapabilityType.Filesystem;
    case 'WebFetch':
    case 'WebSearch':
      return CapabilityType.Network;
    case 'Agent':
      return CapabilityType.Other;
    default:
      // MCP tools (mcp__*) and unknown tools default to Other.
      return CapabilityType.Other;
  }
}

/**
 * Extract a destination string from a structured tool input. The destination
 * is the primary resource the capability targets (path, host, command, ...).
 *
 * Falls back to `'unknown'` (DEC-010 fallback) when no recognizable field is
 * present.
 */
export function inferDestinationFromTool(
  _toolName: string,
  toolInput?: Record<string, unknown>,
): string {
  if (!toolInput) {
    return 'unknown';
  }
  // File tools expose `file_path`.
  const filePath = toolInput['file_path'];
  if (typeof filePath === 'string' && filePath.length > 0) {
    return filePath;
  }
  // Bash / PowerShell expose `command`.
  const command = toolInput['command'];
  if (typeof command === 'string' && command.length > 0) {
    return command;
  }
  // WebFetch exposes `url`; WebSearch exposes `query`.
  const url = toolInput['url'];
  if (typeof url === 'string' && url.length > 0) {
    return url;
  }
  const query = toolInput['query'];
  if (typeof query === 'string' && query.length > 0) {
    return query;
  }
  // Glob / Grep expose `pattern`.
  const pattern = toolInput['pattern'];
  if (typeof pattern === 'string' && pattern.length > 0) {
    return pattern;
  }
  return 'unknown';
}

/**
 * Determine the risk level for a capability request inferred from a tool call.
 *
 * The Secretary narrows permissions, never silently widens them (DEC-011).
 * The default risk for any unrecognized or potentially destructive capability
 * is `critical` so the attention engine never auto-approves it. Known
 * low-risk read-only operations are downgraded conservatively.
 */
export function inferRiskLevel(
  capability: CapType,
  toolName: string,
  toolInput?: Record<string, unknown>,
): RiskLevel {
  // Read-only filesystem access is low risk.
  if (capability === CapabilityType.Filesystem && toolName === 'Read') {
    return CapabilityRiskLevel.Low;
  }
  // Filesystem writes are medium risk (may modify tracked files).
  if (capability === CapabilityType.Filesystem) {
    return CapabilityRiskLevel.Medium;
  }
  // Network fetches to arbitrary URLs are high risk.
  if (capability === CapabilityType.Network) {
    return CapabilityRiskLevel.High;
  }
  // Shell commands are high risk by default; destructive patterns are critical.
  if (capability === CapabilityType.Shell) {
    const command = typeof toolInput?.['command'] === 'string' ? toolInput['command'] : '';
    if (/(rm\s+-rf|git\s+push|git\s+merge|destructive|force|drop|truncate)/i.test(command)) {
      return CapabilityRiskLevel.Critical;
    }
    return CapabilityRiskLevel.High;
  }
  // Unknown / Other defaults to critical (DEC-011).
  return CapabilityRiskLevel.Critical;
}

/**
 * Build a structured {@link CapabilityScope} array from a tool call. The scope
 * narrows what a capability may touch. Defaults to a single entry matching the
 * capability/destination so every request carries a non-empty boundary.
 */
function buildScope(capability: CapType, destination: string): CapabilityScope[] {
  return [{ type: capability, targets: destination ? [destination] : [] }];
}

/**
 * Extract the command string from a tool input (for the `command` field on
 * `ApprovalRequested`). Falls back to `'unknown'` (DEC-010 fallback).
 */
function extractCommand(toolInput?: Record<string, unknown>): string {
  if (!toolInput) {
    return 'unknown';
  }
  const command = toolInput['command'];
  if (typeof command === 'string' && command.length > 0) {
    return command;
  }
  // For file tools, the "command" is the file path being operated on.
  const filePath = toolInput['file_path'];
  if (typeof filePath === 'string' && filePath.length > 0) {
    return filePath;
  }
  const url = toolInput['url'];
  if (typeof url === 'string' && url.length > 0) {
    return url;
  }
  const query = toolInput['query'];
  if (typeof query === 'string' && query.length > 0) {
    return query;
  }
  return 'unknown';
}

/**
 * Infer a {@link FileChangeType} from a tool name.
 * - `Write` → `created` (creates or overwrites a file)
 * - `Edit` / `MultiEdit` / `NotebookEdit` → `modified`
 * - Anything else → `modified` (conservative default)
 */
function inferFileChangeType(toolName: string): FileChangeType {
  if (toolName === 'Write') {
    return 'created';
  }
  return 'modified';
}

/**
 * Extract a file path from a tool input, when the tool is a file-editing tool.
 * Returns `null` when no file path is present.
 */
function extractFilePath(toolInput?: Record<string, unknown>): string | null {
  if (!toolInput) {
    return null;
  }
  const filePath = toolInput['file_path'];
  if (typeof filePath === 'string' && filePath.length > 0) {
    return filePath;
  }
  return null;
}

/** Whether a tool name is a file-editing tool that implies a file change. */
function isFileEditTool(toolName: string): boolean {
  return toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'NotebookEdit';
}

/* ------------------------------------------------------------------ *
 * Individual hook event mappers
 * ------------------------------------------------------------------ */

/**
 * Map `SessionStart` → `AgentStarted`.
 *
 * The hook fires when a session begins. The model and working directory are
 * taken from the structured hook payload when available.
 */
export function mapSessionStart(
  event: SessionStartHookEvent,
  ctx: ClaudeHooksMapperContext,
): SupervisorEvent {
  return {
    type: 'AgentStarted',
    timestamp: now(),
    taskId: ctx.taskId,
    sessionId: ctx.sessionId,
    agentId: ctx.agentId,
    adapterFidelityTier: ctx.adapterFidelityTier,
    objective: ctx.objective,
    workingDir: event.cwd || ctx.workingDir,
    model: event.model,
  };
}

/**
 * Map `PreToolUse` → `ToolStarted` (and `FileChanged` for file-editing tools).
 *
 * The hook fires before a tool call executes. The structured `tool_name` and
 * `tool_input` fields populate the event deterministically.
 */
export function mapPreToolUse(
  event: PreToolUseHookEvent,
  ctx: ClaudeHooksMapperContext,
): SupervisorEvent[] {
  const events: SupervisorEvent[] = [
    {
      type: 'ToolStarted',
      timestamp: now(),
      taskId: ctx.taskId,
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      adapterFidelityTier: ctx.adapterFidelityTier,
      toolName: event.tool_name,
      args: event.tool_input,
    },
  ];
  // File-editing tools imply a file change.
  if (isFileEditTool(event.tool_name)) {
    const filePath = extractFilePath(event.tool_input);
    if (filePath) {
      events.push({
        type: 'FileChanged',
        timestamp: now(),
        taskId: ctx.taskId,
        sessionId: ctx.sessionId,
        agentId: ctx.agentId,
        adapterFidelityTier: ctx.adapterFidelityTier,
        path: filePath,
        changeType: inferFileChangeType(event.tool_name),
      });
    }
  }
  return events;
}

/**
 * Map `PostToolUse` → `ToolFinished` (and `FileChanged` for file-editing tools
 * when not already emitted by PreToolUse).
 *
 * The hook fires after a tool call succeeds. The `tool_response` and
 * `duration_ms` fields populate the event deterministically.
 */
export function mapPostToolUse(
  event: PostToolUseHookEvent,
  ctx: ClaudeHooksMapperContext,
): SupervisorEvent {
  return {
    type: 'ToolFinished',
    timestamp: now(),
    taskId: ctx.taskId,
    sessionId: ctx.sessionId,
    agentId: ctx.agentId,
    adapterFidelityTier: ctx.adapterFidelityTier,
    toolName: event.tool_name,
    args: event.tool_input,
    result: event.tool_response,
    success: true,
    durationMs: event.duration_ms,
  };
}

/**
 * Map `PostToolUseFailure` → `ToolFinished` (with `success: false`).
 */
export function mapPostToolUseFailure(
  event: PostToolUseFailureHookEvent,
  ctx: ClaudeHooksMapperContext,
): SupervisorEvent {
  const errorMessage =
    typeof event.tool_response?.['error'] === 'string'
      ? event.tool_response['error']
      : typeof event.tool_response?.['stderr'] === 'string'
        ? event.tool_response['stderr']
        : `Tool ${event.tool_name} failed`;
  return {
    type: 'ToolFinished',
    timestamp: now(),
    taskId: ctx.taskId,
    sessionId: ctx.sessionId,
    agentId: ctx.agentId,
    adapterFidelityTier: ctx.adapterFidelityTier,
    toolName: event.tool_name,
    args: event.tool_input,
    result: event.tool_response,
    success: false,
    durationMs: event.duration_ms,
    error: errorMessage,
  };
}

/**
 * Map `PermissionRequest` → `ApprovalRequested` with the full structured
 * capability fields per DEC-010 (capability, destination, command, workingDir,
 * scope, riskLevel).
 *
 * The hooks API exposes structured `tool_name` and `tool_input`, so the
 * capability and destination are inferred deterministically — not from free
 * text. The human authorizes the deterministic adapter fields, never an LLM
 * summary.
 *
 * Per DEC-011, any unrecognized tool defaults to `CapabilityType.Other` and
 * `CapabilityRiskLevel.Critical` so the attention engine never auto-approves
 * an unknown request.
 */
export function mapPermissionRequest(
  event: PermissionRequestHookEvent,
  ctx: ClaudeHooksMapperContext,
): SupervisorEvent {
  const capability = inferCapabilityFromTool(event.tool_name, event.tool_input);
  const destination = inferDestinationFromTool(event.tool_name, event.tool_input);
  const command = extractCommand(event.tool_input);
  const riskLevel = inferRiskLevel(capability, event.tool_name, event.tool_input);
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
    destination,
    command,
    workingDir: event.cwd || ctx.workingDir,
    scope: buildScope(capability, destination),
    riskLevel,
  };
}

/**
 * Map `Notification` → `AgentProgress` (or `ApprovalRequested` for
 * `permission_prompt` notifications as a conservative fallback).
 *
 * The `permission_prompt` notification type signals that Claude needs
 * permission approval. Because the hooks API also exposes a dedicated
 * `PermissionRequest` event with structured fields, the `Notification` event
 * is used here only as a conservative fallback: when a `permission_prompt`
 * notification arrives without a preceding `PermissionRequest`, it maps to
 * `ApprovalRequested` with conservative `critical` risk (DEC-011).
 */
export function mapNotification(
  event: NotificationHookEvent,
  ctx: ClaudeHooksMapperContext,
): SupervisorEvent {
  if (event.notification_type === 'permission_prompt') {
    // Conservative fallback: no structured tool fields available, so default
    // to Other / critical (DEC-011: never silently widen permissions).
    return {
      type: 'ApprovalRequested',
      timestamp: now(),
      taskId: ctx.taskId,
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      adapterFidelityTier: ctx.adapterFidelityTier,
      task: ctx.objective,
      agent: ctx.agentId,
      capability: CapabilityType.Other,
      destination: 'unknown',
      command: event.message,
      workingDir: event.cwd || ctx.workingDir,
      scope: buildScope(CapabilityType.Other, 'unknown'),
      riskLevel: CapabilityRiskLevel.Critical,
    };
  }
  // Other notification types are surfaced as progress.
  return {
    type: 'AgentProgress',
    timestamp: now(),
    taskId: ctx.taskId,
    sessionId: ctx.sessionId,
    agentId: ctx.agentId,
    adapterFidelityTier: ctx.adapterFidelityTier,
    message: event.message,
  };
}

/**
 * Map `Stop` → `AgentCompleted`.
 *
 * The `last_assistant_message` field carries Claude's final response text,
 * which becomes the completion summary. Deliverables are empty because the
 * hooks API does not expose a structured deliverables list; the adapter
 * supplements exit code from the process exit when available.
 */
export function mapStop(
  event: StopHookEvent,
  ctx: ClaudeHooksMapperContext,
  exitCode?: number,
): SupervisorEvent {
  return {
    type: 'AgentCompleted',
    timestamp: now(),
    taskId: ctx.taskId,
    sessionId: ctx.sessionId,
    agentId: ctx.agentId,
    adapterFidelityTier: ctx.adapterFidelityTier,
    summary: event.last_assistant_message ?? 'Claude Code session stopped',
    deliverables: [],
    exitCode,
  };
}

/**
 * Map `StopFailure` → `AgentFailed`.
 */
export function mapStopFailure(
  event: StopFailureHookEvent,
  ctx: ClaudeHooksMapperContext,
): SupervisorEvent {
  return {
    type: 'AgentFailed',
    timestamp: now(),
    taskId: ctx.taskId,
    sessionId: ctx.sessionId,
    agentId: ctx.agentId,
    adapterFidelityTier: ctx.adapterFidelityTier,
    error: event.error_details ?? event.error,
    recoverable: event.error === 'rate_limit' || event.error === 'overloaded',
  };
}

/* ------------------------------------------------------------------ *
 * Top-level dispatch mapper
 * ------------------------------------------------------------------ */

/**
 * Map any recognized Claude Code hook event to its canonical
 * {@link SupervisorEvent} variant(s). Returns an array because some events
 * (e.g. `PreToolUse` for file-editing tools) produce more than one event.
 *
 * Returns an empty array for unrecognized event names so the adapter can skip
 * or log them without crashing.
 *
 * @param event - The parsed Claude Code hook event payload.
 * @param ctx - Envelope context (taskId, sessionId, agentId, ...).
 * @returns Zero or more {@link SupervisorEvent}s.
 */
export function mapHookEvent(
  event: ClaudeHookEvent,
  ctx: ClaudeHooksMapperContext,
): SupervisorEvent[] {
  switch (event.hook_event_name) {
    case 'SessionStart':
      return [mapSessionStart(event, ctx)];
    case 'PreToolUse':
      return mapPreToolUse(event, ctx);
    case 'PostToolUse':
      return [mapPostToolUse(event, ctx)];
    case 'PostToolUseFailure':
      return [mapPostToolUseFailure(event, ctx)];
    case 'PermissionRequest':
      return [mapPermissionRequest(event, ctx)];
    case 'Notification':
      return [mapNotification(event, ctx)];
    case 'Stop':
      return [mapStop(event, ctx)];
    case 'StopFailure':
      return [mapStopFailure(event, ctx)];
    case 'SessionEnd':
      // SessionEnd produces no canonical event; the terminal event (Stop /
      // StopFailure) is the completion signal.
      return [];
    default:
      return [];
  }
}

/**
 * Type guard: is the given value a recognized Claude Code hook event?
 *
 * Validates the `hook_event_name` discriminant and the minimal structural
 * requirements (object with a string `hook_event_name` in the known set).
 */
export function isHookEvent(value: unknown): value is ClaudeHookEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const name = (value as Record<string, unknown>).hook_event_name;
  return typeof name === 'string' && CLAUDE_HOOK_EVENT_NAMES.includes(name);
}

/* ------------------------------------------------------------------ *
 * Hooks configuration generation
 * ------------------------------------------------------------------ */

/**
 * A single hook handler entry in the Claude Code hooks configuration. The
 * adapter generates a configuration that routes all lifecycle events to a
 * command that forwards the JSON stdin to the adapter's event sink.
 */
export interface HookHandlerConfig {
  readonly type: 'command';
  readonly command: string;
  readonly args?: readonly string[];
}

/**
 * A matcher group in the Claude Code hooks configuration: an event name with a
 * matcher pattern and a list of handlers.
 */
export interface HookMatcherGroup {
  readonly matcher?: string;
  readonly hooks: readonly HookHandlerConfig[];
}

/**
 * The full Claude Code hooks configuration object, keyed by event name. This
 * is the shape written to `.claude/settings.json` under the `hooks` key.
 */
export type HooksConfig = Record<string, HookMatcherGroup[]>;

/**
 * Build the Claude Code hooks configuration that routes all lifecycle events
 * to the given command. The command receives the hook event JSON on stdin and
 * is expected to forward it to the adapter's event sink (e.g. by appending to
 * a JSONL event file).
 *
 * The configuration covers the events the adapter maps to SupervisorEvents:
 * `SessionStart`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`,
 * `PermissionRequest`, `Notification`, `Stop`, `StopFailure`, `SessionEnd`.
 *
 * @param command - The shell command to invoke for each hook event.
 * @returns The hooks configuration object suitable for `.claude/settings.json`.
 */
export function buildHooksConfig(command: string): HooksConfig {
  const handler: HookHandlerConfig = { type: 'command', command };
  const group: HookMatcherGroup = { hooks: [handler] };
  return {
    SessionStart: [{ matcher: 'startup', hooks: [handler] }],
    PreToolUse: [{ matcher: '*', hooks: [handler] }],
    PostToolUse: [{ matcher: '*', hooks: [handler] }],
    PostToolUseFailure: [{ matcher: '*', hooks: [handler] }],
    PermissionRequest: [{ matcher: '*', hooks: [handler] }],
    Notification: [{ matcher: '*', hooks: [handler] }],
    Stop: [group],
    StopFailure: [group],
    SessionEnd: [group],
  };
}
