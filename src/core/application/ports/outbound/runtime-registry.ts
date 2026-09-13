/**
 * Agent runtime registry port — the core-owned contract for adapter
 * lookup/instantiation (DEC-013, DEC-037).
 *
 * The concrete `AdapterRegistry` under `src/adapters/` satisfies this port;
 * use cases request a fresh {@link AgentRuntimePort} per run. Adapters are
 * created without an event bus — event publication is owned by the session
 * use case, which pipes events yielded by `streamEvents()` exactly once.
 */
import type { AgentRuntimePort } from './agent-runtime.js';

export interface AgentRuntimeRegistryPort {
  create(adapterId: string): AgentRuntimePort;
  has(adapterId: string): boolean;
  list(): readonly string[];
}
