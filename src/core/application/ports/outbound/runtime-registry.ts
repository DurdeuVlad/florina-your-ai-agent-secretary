/**
 * Agent runtime registry port — the core-owned contract for adapter
 * lookup/instantiation (DEC-013, DEC-037).
 *
 * The concrete `AdapterRegistry` under `src/adapters/` satisfies this port;
 * use cases request a fresh {@link AgentRuntimePort} per run. Adapters are
 * created without an event bus — event publication is owned by the session
 * use case, which pipes events yielded by `streamEvents()` exactly once.
 */
import type { AgentRuntimePort, AgentSessionCapabilities } from './agent-runtime.js';

export interface AgentRuntimeRegistryPort {
  create(adapterId: string): AgentRuntimePort;
  has(adapterId: string): boolean;
  list(): readonly string[];
  /**
   * Static session-reuse capability matrix for an adapter (issue #341).
   * Optional on the port so minimal test doubles remain valid — a
   * registry that cannot answer yields `undefined` at the call site,
   * which callers treat as "capabilities unknown" rather than faking
   * support.
   */
  capabilities?(adapterId: string): AgentSessionCapabilities;
}
