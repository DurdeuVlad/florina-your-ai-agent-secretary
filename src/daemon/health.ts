/**
 * Compatibility facade (issue #93). The canonical health use case lives in
 * `src/core/application/use-cases/health.ts`; this module re-exports it so
 * existing `src/daemon/health.js` imports keep working.
 */
export * from '../core/application/use-cases/health.js';
