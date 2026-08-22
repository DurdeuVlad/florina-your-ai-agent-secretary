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
