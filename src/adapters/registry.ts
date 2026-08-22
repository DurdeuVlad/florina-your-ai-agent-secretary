/**
 * Adapter registry (DEC-013, PRODUCT_DESIGN "Agent Adapters").
 *
 * The registry maps stable adapter ids (e.g. `codex`, `claude-code`, `stub`)
 * to factory functions that instantiate the corresponding {@link AgentAdapter}.
 * Factories are registered at startup (by the daemon or by tests) and the
 * daemon selects an adapter by id when a task is delegated.
 *
 * Using factories (rather than pre-instantiated singletons) lets the registry
 * create a fresh adapter per run with the correct {@link EventBus} and
 * configuration, avoiding shared mutable state across concurrent sessions.
 */
import type { EventBus } from '../daemon/event-stream.js';
import type { AgentAdapter } from './base.js';

/**
 * A factory that instantiates an {@link AgentAdapter}.
 *
 * The factory receives the {@link EventBus} the adapter should emit events to
 * (the daemon's live stream) so a fresh adapter is wired into the correct
 * fan-out point for each run.
 */
export type AdapterFactory = (bus: EventBus) => AgentAdapter;

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
 * registry.register('stub', (bus) => new StubAdapter(bus));
 * const adapter = registry.create('stub', daemon.eventBus);
 * ```
 */
export class AdapterRegistry {
  private readonly factories = new Map<string, AdapterFactory>();

  /**
   * Register an adapter factory under a stable id.
   *
   * @param adapterId - Stable identifier (e.g. `codex`, `claude-code`).
   * @param factory - Factory that instantiates the adapter given an EventBus.
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
   * Instantiate the adapter registered under `adapterId`, wiring it to the
   * supplied {@link EventBus}.
   *
   * @throws {UnknownAdapterError} if the id is not registered.
   */
  create(adapterId: string, bus: EventBus): AgentAdapter {
    return this.get(adapterId)(bus);
  }

  /**
   * List all registered adapter ids. Useful for enumerating available
   * adapters to the user (e.g. `secretary adapters`).
   */
  list(): readonly string[] {
    return [...this.factories.keys()];
  }
}
