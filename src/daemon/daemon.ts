/**
 * Compatibility facade (issue #93). The daemon is the composition root —
 * the only place concrete inbound/outbound adapters are combined with core
 * use cases — and lives in `src/bootstrap/daemon.ts`. This module re-exports
 * it so existing `src/daemon/daemon.js` imports keep working.
 */
export * from '../bootstrap/daemon.js';
