/**
 * @deprecated Compatibility wrapper — the `ContextRouter` use case lives in
 * `src/core/application/use-cases/context/context-router.js` (DEC-037).
 * Only the concrete `createContextRouter(ContextCapsuleRepository)` factory
 * remains here because its parameter is the legacy storage type.
 */
import type { ContextCapsuleRepository } from '../storage/repositories/context-capsule.js';
import { ContextRouter } from '../core/application/use-cases/context/context-router.js';

export * from '../core/application/use-cases/context/context-router.js';

/**
 * Convenience factory: build a `ContextRouter` backed by a concrete
 * `ContextCapsuleRepository` and a fresh `ContextStore`.
 */
export function createContextRouter(
  repository: ContextCapsuleRepository,
): ContextRouter {
  return new ContextRouter(repository);
}
