/**
 * Health check endpoint for the Florina daemon (DEC-008).
 *
 * The health check returns daemon + storage status: uptime, whether the
 * persistence connection is usable, and the number of active WebSocket
 * connections. It is exposed both as a method on the control-plane API and
 * as a standalone function the composition root can call.
 *
 * This use case depends on narrow ports only — {@link StorageHealthPort}
 * (persistence probe), {@link ConnectionStatsPort} (connection surface), and
 * {@link EventSubscriberPort} (event sequence) — never concrete adapters.
 */
import type {
  ConnectionStatsPort,
  StorageHealthPort,
} from '../ports/outbound/health.js';
import type { EventSubscriberPort } from '../ports/outbound/event-stream.js';

/** Health check response payload. */
export interface HealthStatus {
  /** `ok` when the daemon is running and storage is reachable. */
  readonly status: 'ok' | 'degraded' | 'down';
  /** Daemon uptime in milliseconds. */
  readonly uptimeMs: number;
  /** Whether the SQLite database connection is usable. */
  readonly dbConnected: boolean;
  /** Number of currently connected WebSocket clients. */
  readonly activeConnections: number;
  /** Number of clients subscribed to the live event stream. */
  readonly eventSubscribers: number;
  /** Highest event sequence number published this session. */
  readonly eventSeq: number;
  /** ISO-8601 timestamp the health check was taken. */
  readonly timestamp: string;
}

/**
 * Collect a {@link HealthStatus} snapshot from the daemon's components.
 *
 * `now` is invoked once so `uptimeMs` and `timestamp` share a single clock
 * reading; tests inject a fixed clock for determinism.
 */
export function collectHealth(
  storage: StorageHealthPort,
  connections: ConnectionStatsPort,
  events: EventSubscriberPort,
  startedAt: number,
  now: () => Date = () => new Date(),
): HealthStatus {
  const nowDate = now();
  const dbConnected = storage.healthCheck();
  const activeConnections = connections.subscriberCount; // subscribers are active connections
  const eventSubscribers = connections.subscriberCount;
  const status: HealthStatus['status'] = dbConnected ? 'ok' : 'degraded';
  return {
    status,
    uptimeMs: nowDate.getTime() - startedAt,
    dbConnected,
    activeConnections,
    eventSubscribers,
    eventSeq: events.currentSeq,
    timestamp: nowDate.toISOString(),
  };
}
