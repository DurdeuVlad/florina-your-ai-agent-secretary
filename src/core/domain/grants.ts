/**
 * Capability grants — durable, scoped permissions granted by the human
 * (DEC-007/010/011, issue #67).
 *
 * A grant is a standing permission scope: "this task may edit `src/`",
 * "this project may reach registry.npmjs.org", "manager agents may spawn
 * codex workers". Every grant is journaled and attributable — who granted
 * it, when, at what authority level — and revocable (revocation takes
 * effect on the next request).
 *
 * Matching is **structured, never LLM-derived** (DEC-010): a request is
 * covered when its capability class matches and every requested scope
 * target falls inside a granted target by the capability-appropriate
 * relation (path prefix for filesystem, suffix for network domains,
 * command-prefix for shell, exact for everything else).
 *
 * Grants only ever *narrow* the escalation path: they can turn an
 * `escalate` into an `allow`, but a policy `deny` is absolute — no grant
 * overrides it (DEC-011).
 */
import type { CapabilityRequest, CapabilityScope, CapabilityType } from './capabilities.js';
import type { ApprovalAuthorityLevel } from './enums.js';
import type { EntityId, ISODateString } from './types.js';

/**
 * A durable capability grant scoped to a project (or one task within it).
 */
export interface CapabilityGrant {
  readonly id: EntityId;
  readonly projectId: EntityId;
  /** When set, the grant only covers requests for this task. */
  readonly taskId?: EntityId;
  /** Capability class the grant covers. */
  readonly capability: CapabilityType;
  /**
   * Structured scope targets (paths, domains, commands, providers).
   * A request is covered when ALL its requested targets are covered.
   */
  readonly scopes: readonly CapabilityScope[];
  /** Grant duration (matches {@link ApprovalScope}; 'one-time' not stored). */
  readonly duration: 'task' | 'project';
  /** Who granted it: 'voice' | 'cli' | 'desktop' | 'api' | a principal id. */
  readonly grantedBy: string;
  /** The authority level used to grant (auditable hierarchy, DEC-010). */
  readonly authorityLevel: ApprovalAuthorityLevel;
  readonly grantedAt: ISODateString;
  /** Optional expiry — after this the grant no longer covers anything. */
  readonly expiresAt?: ISODateString;
  /** Set when revoked — revocation is a record, not a deletion (DEC-012). */
  readonly revokedAt?: ISODateString;
}

/** Input for creating a grant. */
export interface GrantInput {
  readonly projectId: EntityId;
  readonly taskId?: EntityId;
  readonly capability: CapabilityType;
  readonly scopes: readonly CapabilityScope[];
  readonly duration: 'task' | 'project';
  readonly grantedBy: string;
  readonly authorityLevel?: ApprovalAuthorityLevel;
  readonly expiresAt?: ISODateString;
  readonly id?: EntityId;
}

/** Build a {@link CapabilityGrant} with generated id and timestamp. */
export function buildGrant(input: GrantInput): CapabilityGrant {
  if (input.duration === 'task' && input.taskId === undefined) {
    throw new Error('A task-scoped grant requires taskId.');
  }
  if (input.scopes.length === 0) {
    throw new Error('A grant requires at least one scope entry.');
  }
  return {
    id: input.id ?? generateId('grant'),
    projectId: input.projectId,
    ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
    capability: input.capability,
    scopes: input.scopes,
    duration: input.duration,
    grantedBy: input.grantedBy,
    authorityLevel: input.authorityLevel ?? 'authenticatedUI',
    grantedAt: new Date().toISOString(),
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
  };
}

/** Whether a grant is currently usable (not revoked, not expired). */
export function isGrantActive(grant: CapabilityGrant, now: Date = new Date()): boolean {
  if (grant.revokedAt !== undefined) {
    return false;
  }
  if (grant.expiresAt !== undefined && grant.expiresAt <= now.toISOString()) {
    return false;
  }
  return true;
}

/**
 * Whether `grant` covers `request` for `taskId`.
 *
 * Coverage requires:
 * 1. Scope applicability — a task-scoped grant only covers that task; a
 *    project-scoped grant covers any task in the project.
 * 2. Capability match — same capability class.
 * 3. Target coverage — every requested scope target AND the request's
 *    destination is covered by some granted target under the
 *    capability-appropriate relation.
 */
export function grantCoversRequest(
  grant: CapabilityGrant,
  request: CapabilityRequest,
  taskId: EntityId | undefined,
  now: Date = new Date(),
): boolean {
  if (!isGrantActive(grant, now)) {
    return false;
  }
  if (grant.taskId !== undefined && grant.taskId !== taskId) {
    return false;
  }
  if (grant.capability !== request.capability) {
    return false;
  }

  const grantedTargets = grant.scopes
    .filter((s) => s.type === request.capability)
    .flatMap((s) => s.targets);
  if (grantedTargets.length === 0) {
    return false;
  }

  // Every requested scope target must be covered.
  const requestedTargets = request.scope
    .filter((s) => s.type === request.capability)
    .flatMap((s) => s.targets);
  const targets =
    request.destination !== '' ? [...requestedTargets, request.destination] : requestedTargets;

  return targets.every((target) =>
    grantedTargets.some((granted) => covers(request.capability, granted, target)),
  );
}

/**
 * Capability-appropriate target coverage:
 * - `filesystem`/`git` — path prefix (`src/` covers `src/foo.ts`)
 * - `network` — domain suffix (`npmjs.org` covers `registry.npmjs.org`)
 * - `shell`/`push`/`merge`/`deploy` — command prefix (`npm test` covers
 *   `npm test -- --run`)
 * - everything else — exact match
 */
function covers(capability: CapabilityType, granted: string, target: string): boolean {
  if (target === granted) {
    return true;
  }
  switch (capability) {
    case 'filesystem':
    case 'git':
      return target.startsWith(normalizePathPrefix(granted));
    case 'network':
      return target.endsWith(`.${granted}`) || target === granted;
    case 'shell':
    case 'push':
    case 'merge':
    case 'deploy':
      return target.startsWith(`${granted} `);
    default:
      return false;
  }
}

/** Normalize a granted path to a prefix-safe form (`src` → `src/`). */
function normalizePathPrefix(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return `${normalized}/`;
}

/** Generates a reasonably unique id without a crypto dependency. */
function generateId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}
