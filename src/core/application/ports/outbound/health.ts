/**
 * Health observation ports (DEC-008, DEC-037, issue #93).
 *
 * The health use case (`use-cases/health.ts`) queries these narrow outbound
 * ports to build a {@link HealthStatus} snapshot: whether the persistence
 * adapter's connection is usable, and how many live connections the inbound
 * event surface currently has. Concrete adapters implement them; the core
 * never names a database driver or socket library.
 */

/**
 * Persistence health probe. Implementations return `true` when the storage
 * connection is usable (e.g. a trivial query succeeds).
 */
export interface StorageHealthPort {
  healthCheck(): boolean;
}

/**
 * Connection statistics exposed by an inbound connection surface (e.g. the
 * event stream): how many clients are currently subscribed/connected.
 */
export interface ConnectionStatsPort {
  readonly subscriberCount: number;
}
