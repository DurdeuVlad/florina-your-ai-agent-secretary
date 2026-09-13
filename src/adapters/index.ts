/**
 * Adapters module — bridges to heterogeneous coding agents (Codex, Claude
 * Code) that normalize agent-native events into the canonical
 * `SupervisorEvent` schema (DEC-019).
 *
 * Public API:
 * - {@link AgentAdapter} interface and {@link BaseAdapter} abstract class
 *   with the fidelity tier contract (DEC-013).
 * - {@link AdapterRegistry} for selecting and instantiating adapters by id.
 * - {@link CodexAdapter} (Tier A) for the Codex app-server JSON-RPC protocol.
 * - {@link ClaudeHooksAdapter} (Tier B) for the Claude Code hooks protocol.
 * - {@link ClaudePtyAdapter} (Tier E) for the Claude Code PTY heuristic.
 * - {@link StubAdapter} (Tier E) for end-to-end pipeline testing.
 */
export type {
  AgentAdapter,
  AdapterFidelityTier,
  AdapterConnectionState,
  SessionConfig,
  StartRunResult,
} from './base.js';
export { BaseAdapter } from './base.js';
export { AdapterRegistry } from './registry.js';
export type { AdapterFactory } from './registry.js';
export { UnknownAdapterError, DuplicateAdapterError } from './registry.js';
export { CodexAdapter, CODEX_ADAPTER_ID, WebSocketTransport } from './codex-adapter.js';
export type { CodexAdapterOptions, CodexTransport } from './codex-adapter.js';
export {
  mapCodexEvent,
  isCodexEvent,
  mapPermissionRequest,
  CODEX_EVENT_TYPES,
} from './codex-mapper.js';
export type {
  CodexEvent,
  CodexPermissionRequestEvent,
  MapperContext,
} from './codex-mapper.js';
export { StubAdapter, STUB_ADAPTER_ID, buildDefaultStubEvents } from './stub-adapter.js';
export type { StubAdapterOptions } from './stub-adapter.js';
export { ClaudeHooksAdapter, CLAUDE_HOOKS_ADAPTER_ID, InMemoryHookEventSink } from './claude-hooks-adapter.js';
export type {
  ClaudeHooksAdapterOptions,
  ClaudeCliProcess,
  ClaudeCliSpawner,
  ClaudeCliSpawnOptions,
  HookEventSink,
} from './claude-hooks-adapter.js';
export {
  mapHookEvent,
  isHookEvent,
  mapSessionStart,
  mapPreToolUse,
  mapPostToolUse,
  mapPostToolUseFailure,
  mapPermissionRequest as mapHookPermissionRequest,
  mapNotification,
  mapStop as mapHookStop,
  mapStopFailure,
  inferCapabilityFromTool,
  inferDestinationFromTool,
  inferRiskLevel,
  buildHooksConfig,
  CLAUDE_HOOK_EVENT_NAMES,
} from './claude-hooks-mapper.js';
export type {
  ClaudeHookEvent,
  ClaudeHooksMapperContext,
  SessionStartHookEvent,
  PreToolUseHookEvent,
  PostToolUseHookEvent,
  PostToolUseFailureHookEvent,
  PermissionRequestHookEvent as HookPermissionRequestEvent,
  NotificationHookEvent,
  StopHookEvent,
  StopFailureHookEvent,
  SessionEndHookEvent,
  HooksConfig,
} from './claude-hooks-mapper.js';
export { ClaudePtyAdapter, CLAUDE_PTY_ADAPTER_ID } from './claude-adapter.js';
export type {
  ClaudeAdapterOptions,
  PtyProcess,
  PtySpawner,
  PtySpawnOptions,
} from './claude-adapter.js';
export {
  parsePtyLine,
  stripAnsi,
  mapPtyChunk,
  mapToolStarted,
  mapFileChanged,
  mapProgress,
  mapCompletion,
  mapPermissionPrompt,
  parseAndMapPtyLine,
} from './claude-mapper.js';
export type {
  ClaudeMapperContext,
  ParsedPtyChunk,
  ParsedPtyKind,
} from './claude-mapper.js';

/* Provider quota readers (DEC-029, issue #71) */
export {
  CodexQuotaReader,
  ClaudeQuotaReader,
  QuotaReaderError,
  isQuotaExhaustion,
  reportExhaustion,
  normalizeReset,
  normalizeUsedPct,
  statusFromUsage,
} from './quota-readers.js';
export type {
  QuotaReader,
  JsonRpcRequest,
  CodexQuotaReaderOptions,
  StatuslineSource,
  ClaudeQuotaReaderOptions,
} from './quota-readers.js';

/* Generic ACP adapter (DEC-030, issue #61) */
export {
  AcpAdapter,
  nodeAcpSpawner,
  devinAcpAdapter,
  geminiAcpAdapter,
} from './acp-adapter.js';
export type {
  AcpAdapterOptions,
  AcpProcess,
  AcpSpawner,
  PermissionResponder,
} from './acp-adapter.js';
