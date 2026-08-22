/**
 * Health check endpoint for the Secretary daemon (DEC-008).
 *
 * The health check returns daemon + storage status: uptime, whether the
 * SQLite database is connected, and the number of active WebSocket
 * connections. It is exposed both as a method on the control-plane API and
 * as a standalone function the daemon can call.
 */
import type { StorageDatabase } from '../storage/index.js';
import type { EventBus, EventStream } from './event-stream.js';

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
 */
export function collectHealth(
  db: StorageDatabase,
  stream: EventStream,
  bus: EventBus,
  startedAt: number,
): HealthStatus {
  const dbConnected = db.healthCheck();
  const activeConnections = stream.subscriberCount; // subscribers are active connections
  const eventSubscribers = stream.subscriberCount;
  const status: HealthStatus['status'] = dbConnected ? 'ok' : 'degraded';
  return {
    status,
    uptimeMs: Date.now() - startedAt,
    dbConnected,
    activeConnections,
    eventSubscribers,
    eventSeq: bus.currentSeq,
    timestamp: new Date().toISOString(),
  };
}
