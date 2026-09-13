/**
 * Claude Code CLI PTY output pattern mappers (DEC-013, DEC-023, DEC-010,
 * issue #11 / #40).
 *
 * The Claude Code PTY adapter is a Tier E adapter (reclassified from B per
 * DEC-023). Unlike the Codex app-server (tier A, structured JSON-RPC) and the
 * Claude Code hooks adapter (tier B, structured lifecycle hooks), the PTY
 * adapter streams unstructured terminal text. This module provides
 * best-effort, defensive regex-based mappers that parse Claude CLI PTY output
 * into the canonical {@link SupervisorEvent} schema (DEC-019).
 *
 * Design rules:
 * - Mapping functions are pure: they take a PTY text chunk + envelope context
 *   and return zero or more {@link SupervisorEvent}s. No I/O, no side effects.
 * - Mappers are **defensive and best-effort**: unrecognized text yields `null`
 *   (skipped) rather than throwing. PTY output is noisy and version-drifting.
 * - Permission prompts map to `ApprovalRequested` per DEC-010. Because PTY
 *   output does not expose structured capability fields, unparseable fields
 *   fall back to `unknown`/conservative defaults (DEC-010 fallback). The
 *   Secretary never silently widens permissions (DEC-011): an unparseable
 *   permission prompt defaults to the highest risk level (`critical`) so it
 *   always requires human confirmation.
 * - The mapper never invents data: fields absent from the text are defaulted
 *   conservatively, never optimistically.
 *
 * Recognized Claude CLI PTY markers (best-effort, version-dependent):
 * - Tool use: `● <ToolName>(<args>)` or `⏺ <ToolName>(<args>)`
 * - File changes: `Edit(<path>)`, `Write(<path>)`, `NotebookEdit(<path>)`
 * - Completion: `✓` / `Task completed` / `Finished` markers
 * - Permission prompts: `Claude needs your permission` / `Do you want to
 *   allow` / `Allow?` / `approve?`
 */
import type { AdapterFidelityTier } from '../../../core/domain/enums.js';
import type { SupervisorEvent } from '../../../core/domain/events.js';
import type { FileChangeType } from '../../../core/domain/events.js';
import {
  CapabilityType,
  CapabilityRiskLevel,
  type CapabilityType as CapType,
  type CapabilityRiskLevel as RiskLevel,
} from '../../../core/domain/capabilities.js';

/* ------------------------------------------------------------------ *
 * Envelope context
 * ------------------------------------------------------------------ */

/**
 * Context carried through every mapped event: the common envelope fields that
 * the adapter populates from its run configuration. Mirrors the Codex mapper
 * context so the two adapters share a consistent envelope contract.
 */
export interface ClaudeMapperContext {
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
 * Parsed PTY chunk model
 * ------------------------------------------------------------------ */

/**
 * The kind of PTY chunk recognized by the parser. Each kind maps to one or
 * more {@link SupervisorEvent} variants (or none, for noise).
 */
export type ParsedPtyKind =
  | 'tool-start'
  | 'tool-finish'
  | 'file-change'
  | 'progress'
  | 'completion'
  | 'permission-prompt'
  | 'noise';

/**
 * A parsed PTY text chunk. The parser converts a raw line of terminal output
 * into a tagged chunk; the mappers then convert chunks into
 * {@link SupervisorEvent}s.
 *
 * Because PTY output is unstructured, all payload fields are optional and
 * best-effort. Consumers must not assume any field is present.
 */
export interface ParsedPtyChunk {
  readonly kind: ParsedPtyKind;
  /** Raw text of the chunk (trimmed). */
  readonly raw: string;
  /** Tool name, when the chunk references a tool invocation. */
  readonly toolName?: string;
  /** Tool argument string (unparsed), when available. */
  readonly toolArgs?: string;
  /** File path, when the chunk references a file change. */
  readonly filePath?: string;
  /** File change type, when the chunk references a file change. */
  readonly changeType?: FileChangeType;
  /** Progress / informational message. */
  readonly message?: string;
  /** Permission prompt text, when the chunk is a permission request. */
  readonly prompt?: string;
  /** Best-effort capability inferred from a permission prompt. */
  readonly capability?: CapType;
  /** Best-effort destination inferred from a permission prompt. */
  readonly destination?: string;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Generate an ISO-8601 timestamp for the current instant. */
function now(): string {
  return new Date().toISOString();
}

/**
 * Infer a {@link CapabilityType} from a permission-prompt text fragment.
 * Best-effort: defaults to {@link CapabilityType.Other} when no signal is
 * recognizable (DEC-010 fallback — `unknown` is represented by `other`).
 */
function inferCapability(text: string): CapType {
  const lower = text.toLowerCase();
  if (/(bash|shell|command|exec|run|terminal)/.test(lower)) {
    return CapabilityType.Shell;
  }
  if (/(file|write|edit|read|path|filesystem)/.test(lower)) {
    return CapabilityType.Filesystem;
  }
  if (/(network|fetch|curl|wget|http|url|api)/.test(lower)) {
    return CapabilityType.Network;
  }
  if (/(git|push|merge|commit)/.test(lower)) {
    return CapabilityType.Git;
  }
  return CapabilityType.Other;
}

/**
 * Infer a destination string from a permission-prompt text fragment.
 * Best-effort: extracts a quoted path/host or a parenthesized argument;
 * defaults to `'unknown'` (DEC-010 fallback) when nothing is recognizable.
 */
function inferDestination(text: string): string {
  // Quoted string (single or double).
  const quoted = text.match(/["']([^"']+)["']/);
  if (quoted?.[1]) {
    return quoted[1];
  }
  // Parenthesized argument, e.g. `Bash(npm install)`.
  const paren = text.match(/\(([^)]+)\)/);
  if (paren?.[1]) {
    return paren[1].trim();
  }
  // Bare path-like token.
  const pathLike = text.match(/([\w./-]+\/[\w./-]+)/);
  if (pathLike?.[1]) {
    return pathLike[1];
  }
  return 'unknown';
}

/* ------------------------------------------------------------------ *
 * PTY text parser
 * ------------------------------------------------------------------ */

// Regexes are intentionally permissive: PTY output includes ANSI escape
// codes, box-drawing glyphs, and color sequences. The parser strips ANSI
// escapes before matching.

/** Matches ANSI CSI escape sequences (colors, cursor moves, ...). */
// eslint-disable-next-line no-control-regex -- PTY output legitimately contains the ESC control character; matching it is required to strip ANSI sequences.
const ANSI_ESCAPE = /\x1b\[[0-9;]*[A-Za-z]/g;

/** Strip ANSI escape codes from a PTY line. */
export function stripAnsi(line: string): string {
  return line.replace(ANSI_ESCAPE, '');
}

// Tool-use markers: `● ToolName(args)` or `⏺ ToolName(args)` or
// `* ToolName(args)`. The leading glyph is optional; some Claude CLI
// versions emit a plain `ToolName(args)` on its own line.
const TOOL_USE_RE = /^(?:[●⏺*]\s*)?([A-Z][A-Za-z]+)\((.*)\)$/;

// File-editing tool names that imply a file change.
const FILE_EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

// Completion markers.
const COMPLETION_RE = /(?:^|\s)(?:✓|✔|finished|task completed|completed successfully|done\.?)\s*$/i;

// Permission-prompt markers.
const PERMISSION_RE =
  /(?:claude needs your permission|do you want to allow|allow\?|approve\?|would you like to (?:allow|approve)|permission (?:required|requested))/i;

/**
 * Parse a single line of Claude CLI PTY output into a {@link ParsedPtyChunk}.
 *
 * The parser is defensive: any line that does not match a known marker is
 * classified as `noise` (and skipped by the mappers). It never throws.
 *
 * @param rawLine - The raw PTY line (may include ANSI escape codes).
 * @returns A parsed chunk. Never `null`; unrecognized lines yield a `noise`
 *   chunk so callers can inspect/log them uniformly.
 */
export function parsePtyLine(rawLine: string): ParsedPtyChunk {
  const line = stripAnsi(rawLine).trim();
  if (line.length === 0) {
    return { kind: 'noise', raw: line };
  }

  // Permission prompt — check before tool-use because some prompts embed a
  // tool name in parentheses.
  if (PERMISSION_RE.test(line)) {
    return {
      kind: 'permission-prompt',
      raw: line,
      prompt: line,
      capability: inferCapability(line),
      destination: inferDestination(line),
    };
  }

  // Tool use.
  const toolMatch = line.match(TOOL_USE_RE);
  if (toolMatch) {
    const toolName = toolMatch[1]!;
    const toolArgs = toolMatch[2] ?? '';
    if (FILE_EDIT_TOOLS.has(toolName)) {
      // A file-editing tool implies both a tool-start and a file change.
      const filePath = inferDestination(toolArgs) || 'unknown';
      return {
        kind: 'file-change',
        raw: line,
        toolName,
        toolArgs,
        filePath,
        changeType: toolName === 'Write' ? 'created' : 'modified',
      };
    }
    return {
      kind: 'tool-start',
      raw: line,
      toolName,
      toolArgs,
    };
  }

  // Completion.
  if (COMPLETION_RE.test(line)) {
    return { kind: 'completion', raw: line, message: line };
  }

  // Everything else is treated as progress noise (best-effort: only non-empty
  // lines that look like agent narration are surfaced as progress).
  if (line.length > 0 && !line.startsWith('>')) {
    return { kind: 'progress', raw: line, message: line };
  }

  return { kind: 'noise', raw: line };
}

/* ------------------------------------------------------------------ *
 * Individual chunk mappers
 * ------------------------------------------------------------------ */

/**
 * Map a `tool-start` chunk → `ToolStarted`.
 *
 * PTY output does not reliably signal tool *completion*, so the adapter emits
 * a best-effort `ToolFinished` only when a follow-up chunk is observed (see
 * {@link mapPtyChunks}). This mapper produces only the `ToolStarted` event.
 */
export function mapToolStarted(
  chunk: ParsedPtyChunk,
  ctx: ClaudeMapperContext,
): SupervisorEvent {
  return {
    type: 'ToolStarted',
    timestamp: now(),
    taskId: ctx.taskId,
    sessionId: ctx.sessionId,
    agentId: ctx.agentId,
    adapterFidelityTier: ctx.adapterFidelityTier,
    toolName: chunk.toolName ?? 'unknown',
    args: chunk.toolArgs ? { raw: chunk.toolArgs } : undefined,
  };
}

/**
 * Map a `file-change` chunk → `FileChanged`. Also implies a `ToolStarted` for
 * the editing tool; callers handle the dual emission.
 */
export function mapFileChanged(
  chunk: ParsedPtyChunk,
  ctx: ClaudeMapperContext,
): SupervisorEvent {
  return {
    type: 'FileChanged',
    timestamp: now(),
    taskId: ctx.taskId,
    sessionId: ctx.sessionId,
    agentId: ctx.agentId,
    adapterFidelityTier: ctx.adapterFidelityTier,
    path: chunk.filePath ?? 'unknown',
    changeType: chunk.changeType ?? 'modified',
  };
}

/** Map a `progress` chunk → `AgentProgress`. */
export function mapProgress(
  chunk: ParsedPtyChunk,
  ctx: ClaudeMapperContext,
): SupervisorEvent {
  return {
    type: 'AgentProgress',
    timestamp: now(),
    taskId: ctx.taskId,
    sessionId: ctx.sessionId,
    agentId: ctx.agentId,
    adapterFidelityTier: ctx.adapterFidelityTier,
    message: chunk.message ?? chunk.raw,
  };
}

/**
 * Map a `completion` chunk → `AgentCompleted`.
 *
 * PTY completion markers carry no structured deliverables, so the
 * `deliverables` array is empty and the summary is the raw completion text
 * (best-effort). The adapter supplements `exitCode`/`durationMs` from the
 * process exit when available.
 */
export function mapCompletion(
  chunk: ParsedPtyChunk,
  ctx: ClaudeMapperContext,
  exitCode?: number,
): SupervisorEvent {
  return {
    type: 'AgentCompleted',
    timestamp: now(),
    taskId: ctx.taskId,
    sessionId: ctx.sessionId,
    agentId: ctx.agentId,
    adapterFidelityTier: ctx.adapterFidelityTier,
    summary: chunk.message ?? (chunk.raw || 'Task completed'),
    deliverables: [],
    exitCode,
  };
}

/**
 * Map a `permission-prompt` chunk → `ApprovalRequested` (DEC-010).
 *
 * PTY permission prompts do not expose structured capability fields. Per the
 * DEC-010 fallback, unparseable fields default to `unknown`/conservative
 * values. Crucially, the risk level defaults to **`critical`** so the
 * attention engine never auto-approves an unparseable prompt (DEC-011: never
 * silently widen permissions). When a capability/destination can be inferred
 * from the prompt text, the risk is downgraded heuristically but still
 * requires human confirmation for tier B.
 */
export function mapPermissionPrompt(
  chunk: ParsedPtyChunk,
  ctx: ClaudeMapperContext,
): SupervisorEvent {
  const capability = chunk.capability ?? CapabilityType.Other;
  const destination = chunk.destination ?? 'unknown';
  // Conservative default: critical. Downgrade only for clearly read-only or
  // low-risk inferred capabilities — but never below `medium` for a PTY
  // prompt, since the structured fields are best-effort.
  let riskLevel: RiskLevel = CapabilityRiskLevel.Critical;
  if (capability === CapabilityType.Filesystem && /read/i.test(chunk.prompt ?? '')) {
    riskLevel = CapabilityRiskLevel.Medium;
  } else if (capability === CapabilityType.Network) {
    riskLevel = CapabilityRiskLevel.High;
  }
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
    // PTY output does not expose the exact command; use the prompt text.
    command: chunk.prompt ?? 'unknown',
    workingDir: ctx.workingDir,
    scope: [{ type: capability, targets: destination ? [destination] : [] }],
    riskLevel,
  };
}

/* ------------------------------------------------------------------ *
 * Top-level dispatch mapper
 * ------------------------------------------------------------------ */

/**
 * Map a parsed PTY chunk to its canonical {@link SupervisorEvent} variant.
 *
 * A single chunk may produce more than one event (e.g. a file-edit tool chunk
 * produces both a `ToolStarted` and a `FileChanged`). This function returns an
 * array to accommodate that; most chunks produce zero or one event.
 *
 * @returns Zero or more {@link SupervisorEvent}s. `noise` and `tool-finish`
 *   chunks produce no events here (tool-finish is synthesized by the adapter
 *   from process state, not from a parsed chunk).
 */
export function mapPtyChunk(
  chunk: ParsedPtyChunk,
  ctx: ClaudeMapperContext,
): SupervisorEvent[] {
  switch (chunk.kind) {
    case 'tool-start':
      return [mapToolStarted(chunk, ctx)];
    case 'file-change':
      // A file-edit tool implies both a tool start and a file change.
      return [mapToolStarted(chunk, ctx), mapFileChanged(chunk, ctx)];
    case 'progress':
      return [mapProgress(chunk, ctx)];
    case 'completion':
      return [mapCompletion(chunk, ctx)];
    case 'permission-prompt':
      return [mapPermissionPrompt(chunk, ctx)];
    case 'tool-finish':
    case 'noise':
    default:
      return [];
  }
}

/**
 * Convenience: parse a raw PTY line and map it in one step.
 *
 * @param rawLine - The raw PTY line (may include ANSI escape codes).
 * @param ctx - Envelope context.
 * @returns Zero or more {@link SupervisorEvent}s.
 */
export function parseAndMapPtyLine(
  rawLine: string,
  ctx: ClaudeMapperContext,
): SupervisorEvent[] {
  return mapPtyChunk(parsePtyLine(rawLine), ctx);
}
