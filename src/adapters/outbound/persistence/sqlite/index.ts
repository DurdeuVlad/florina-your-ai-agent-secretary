/**
 * SQLite persistence adapter — canonical outbound implementation of the
 * storage engine (DEC-012, DEC-020, issue #92).
 *
 * Public API:
 * - `StorageDatabase`: connection management + forward-only migrations.
 * - `runMigrations`: standalone migration runner for an existing connection.
 * - Repository classes for every domain object, implementing the core
 *   repository ports in `src/core/application/ports/outbound/repositories.ts`.
 * - Schema statement constants for introspection or custom migrations.
 */
export { StorageDatabase } from './database.js';
export type { DatabaseOptions, OpenResult } from './database.js';
export { runMigrations, MIGRATIONS, MIGRATION_001_INITIAL } from './migrations.js';
export type { Migration } from './migrations.js';
export * from './schema.js';
export * from './repositories/index.js';

/* Runtime metrics time-series persistence (issue #18, DEC-015) */
export { MetricsRepository } from './repositories/metrics.js';
export type { StoredMetricsSnapshot, ListSnapshotsOptions } from './repositories/metrics.js';
