/**
 * Compatibility facade (issue #93). The canonical control-plane API use case
 * lives in `src/core/application/use-cases/control-plane/control-plane-api.ts`;
 * this module re-exports it so existing `src/daemon/api.js` imports keep
 * working.
 */
export * from '../core/application/use-cases/control-plane/control-plane-api.js';
