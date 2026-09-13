/**
 * Adapter registry (DEC-013, PRODUCT_DESIGN "Agent Adapters").
 *
 * The registry maps stable adapter ids (e.g. `codex`, `claude-code`, `stub`)
 * to factory functions that instantiate the corresponding
 * {@link AgentRuntimePort}. Factories are registered at startup (by the
 * daemon or by tests) and the daemon selects an adapter by id when a task
 * is delegated.
 *
 * Using factories (rather than pre-instantiated singletons) lets the
 * registry create a fresh adapter per run with the correct configuration,
 * avoiding shared mutable state across concurrent sessions.
 *
 * Adapters are created without an event bus: the session manager is the
 * sole publisher of events yielded by `AgentRuntimePort.streamEvents()`,
 * so injecting a bus at factory time would permit duplicate publication
 * and couple adapter construction to application fan-out.
 *
 * This is an outbound adapter module: it implements the core-owned
 * {@link AgentRuntimeRegistryPort} and never depends on the concrete daemon
 * `EventPublisherPort` or the event-stream ports.
 */
import type { AgentRuntimePort } from '../../../core/application/ports/outbound/agent-runtime.js';
import type { AgentRuntimeRegistryPort } from '../../../core/application/ports/outbound/runtime-registry.js';

/**
 * A factory that instantiates an {@link AgentRuntimePort} with no event
 * bus attached. Event publication is handled by the session manager, which
 * pipes each event yielded by `streamEvents()` onto the bus exactly once.
 */
export type AdapterFactory = () => AgentRuntimePort;

/** Error thrown when an unknown adapter id is requested. */
export class UnknownAdapterError extends Error {
  readonly adapterId: string;

  constructor(adapterId: string) {
    super(`Unknown adapter id: "${adapterId}"`);
    this.name = 'UnknownAdapterError';
    this.adapterId = adapterId;
  }
}

/** Error thrown when an adapter id is registered more than once. */
export class DuplicateAdapterError extends Error {
  readonly adapterId: string;

  constructor(adapterId: string) {
    super(`Adapter id "${adapterId}" is already registered`);
    this.name = 'DuplicateAdapterError';
    this.adapterId = adapterId;
  }
}

/**
 * Registry of available agent adapters.
 *
 * Usage:
 * ```ts
 * const registry = new AdapterRegistry();
 * registry.register('stub', () => new StubAdapter());
 * const adapter = registry.create('stub');
 * ```
 */
export class AdapterRegistry implements AgentRuntimeRegistryPort {
  private readonly factories = new Map<string, AdapterFactory>();

  /**
   * Register an adapter factory under a stable id.
   *
   * @param adapterId - Stable identifier (e.g. `codex`, `claude-code`).
   * @param factory - Factory that instantiates the adapter.
   * @throws {DuplicateAdapterError} if the id is already registered.
   */
  register(adapterId: string, factory: AdapterFactory): void {
    if (this.factories.has(adapterId)) {
      throw new DuplicateAdapterError(adapterId);
    }
    this.factories.set(adapterId, factory);
  }

  /**
   * Whether an adapter is registered under the given id.
   */
  has(adapterId: string): boolean {
    return this.factories.has(adapterId);
  }

  /**
   * Get the factory registered under an id (without instantiating).
   *
   * @throws {UnknownAdapterError} if the id is not registered.
   */
  get(adapterId: string): AdapterFactory {
    const factory = this.factories.get(adapterId);
    if (!factory) {
      throw new UnknownAdapterError(adapterId);
    }
    return factory;
  }

  /**
   * Instantiate the adapter registered under `adapterId`. The adapter is
   * created without an event bus — the session manager publishes the events
   * it streams.
   *
   * @throws {UnknownAdapterError} if the id is not registered.
   */
  create(adapterId: string): AgentRuntimePort {
    return this.get(adapterId)();
  }

  /**
   * List all registered adapter ids. Useful for enumerating available
   * adapters to the user (e.g. `florina adapters`).
   */
  list(): readonly string[] {
    return [...this.factories.keys()];
  }
}
