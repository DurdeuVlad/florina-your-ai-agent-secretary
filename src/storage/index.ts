/**
 * Storage module — SQLite-backed event journal and Context Capsules
 * (DEC-012, DEC-020).
 *
 * Public API:
 * - `StorageDatabase`: connection management + forward-only migrations.
 * - `runMigrations`: standalone migration runner for an existing connection.
 * - Repository classes for every domain object.
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

/* Context resolution — assembling context capsules for agent sessions (#30) */
export {
  estimateTokens,
  estimateCapsuleTokens,
  estimateAssembledTokens,
  classifyEventPriority,
  truncateToBudget,
  DEFAULT_CHARS_PER_TOKEN,
  DEFAULT_TOKEN_BUDGET,
} from './context-estimator.js';
export {
  ContextResolver,
  DEFAULT_EVENT_WINDOW,
  DEFAULT_MAX_DECISIONS,
  DEFAULT_MAX_DIGESTS,
} from './context-resolver.js';
export type {
  AssembledContextCapsule,
  TaskSummary,
  PrioritizedEvent,
  Priority,
  ResolveOptions,
  TaskSource,
  EventSource,
  DecisionSource,
  DigestSource,
  WorktreeStatusSource,
} from './context-resolver.js';
