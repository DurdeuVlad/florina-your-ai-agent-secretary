/**
 * Agent Secretary — an open-source attention broker for coding agents.
 *
 * Public entrypoint. Re-exports the primary public API surface from the
 * major modules so consumers can import everything from `agent-secretary`.
 *
 * Voice and desktop are intentionally NOT re-exported here: they have
 * optional native dependencies and are separate surfaces. Import them
 * directly from `agent-secretary/voice` or `agent-secretary/desktop` when
 * needed.
 */
export const VERSION = '0.0.1';

/* Daemon — local control plane (DEC-008) */
export * from './daemon/index.js';

/*
 * Adapters — Codex / Claude Code bridges (DEC-019).
 *
 * Re-exported explicitly (rather than `export *`) because the adapters
 * module exports a `SessionConfig` type that collides with the daemon
 * command API's `SessionConfig`. We surface the adapter one under the
 * alias `AdapterSessionConfig` and let the daemon's `SessionConfig` (the
 * one used by the typed command API) be the default.
 */
export {
  BaseAdapter,
  AdapterRegistry,
  UnknownAdapterError,
  DuplicateAdapterError,
  CodexAdapter,
  CODEX_ADAPTER_ID,
  WebSocketTransport,
  StubAdapter,
  STUB_ADAPTER_ID,
  buildDefaultStubEvents,
  ClaudeHooksAdapter,
  CLAUDE_HOOKS_ADAPTER_ID,
  InMemoryHookEventSink,
  ClaudePtyAdapter,
  CLAUDE_PTY_ADAPTER_ID,
  mapCodexEvent,
  isCodexEvent,
  mapPermissionRequest,
  CODEX_EVENT_TYPES,
  mapHookEvent,
  isHookEvent,
  mapHookPermissionRequest,
  mapHookStop,
  inferCapabilityFromTool,
  inferDestinationFromTool,
  inferRiskLevel,
  buildHooksConfig,
  CLAUDE_HOOK_EVENT_NAMES,
  parsePtyLine,
  stripAnsi,
  mapPtyChunk,
  mapToolStarted,
  mapFileChanged,
  mapProgress,
  mapCompletion,
  mapPermissionPrompt,
  parseAndMapPtyLine,
} from './adapters/index.js';
export type {
  AgentAdapter,
  AdapterFidelityTier,
  AdapterConnectionState,
  StartRunResult,
  AdapterFactory,
  CodexAdapterOptions,
  CodexTransport,
  CodexEvent,
  CodexPermissionRequestEvent,
  MapperContext,
  StubAdapterOptions,
  ClaudeHooksAdapterOptions,
  ClaudeCliProcess,
  ClaudeCliSpawner,
  ClaudeCliSpawnOptions,
  HookEventSink,
  ClaudeHookEvent,
  ClaudeHooksMapperContext,
  SessionStartHookEvent,
  PreToolUseHookEvent,
  PostToolUseHookEvent,
  PostToolUseFailureHookEvent,
  HookPermissionRequestEvent,
  NotificationHookEvent,
  StopHookEvent,
  StopFailureHookEvent,
  SessionEndHookEvent,
  HooksConfig,
  ClaudeAdapterOptions,
  PtyProcess,
  PtySpawner,
  PtySpawnOptions,
  ClaudeMapperContext,
  ParsedPtyChunk,
  ParsedPtyKind,
  SessionConfig as AdapterSessionConfig,
} from './adapters/index.js';

/* Attention — deterministic attention engine (DEC-014) */
export * from './attention/index.js';

/* Storage — SQLite event journal + Context Capsules (DEC-012/020) */
export * from './storage/index.js';

/* Domain — core domain objects, enums, factories (DEC-004) */
export * from './domain/index.js';

/* Security — audit + hardening utilities (DEC-011) */
export * from './security/index.js';

/*
 * Disambiguate `AttentionItem`: both the domain module (types.ts) and the
 * attention module (attention-item.ts) export an `AttentionItem` interface.
 * They are structurally identical; the attention module is the canonical
 * owner, so we explicitly re-export it here to resolve the `export *`
 * ambiguity (TS2308).
 */
export type { AttentionItem } from './attention/attention-item.js';
