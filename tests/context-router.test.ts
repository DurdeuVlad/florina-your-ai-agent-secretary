/**
 * Tests for Context Capsule routing & isolation enforcement (#6, DEC-003,
 * DEC-020).
 *
 * Acceptance criteria covered:
 *  - Loading a Task capsule makes only that task's context available
 *  - Switching projects unloads the previous capsule and loads the new one
 *  - Cross-scope queries are rejected or explicitly scoped (no silent
 *    contamination)
 *  - Capsule load/unload does not load the entire DB (only requested scope)
 *  - Tests prove isolation between two concurrent project contexts (rapid
 *    switching)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { StorageDatabase, ContextCapsuleRepository } from '../src/storage/index.js';
import { buildProjectCapsule, buildTaskCapsule, buildSessionCapsule } from '../src/domain/index.js';
import type {
  ContextCapsule,
  ContextCapsuleScope,
  EntityId,
  ProjectCapsule,
  TaskCapsule,
} from '../src/domain/index.js';
import {
  ContextRouter,
  ContextStore,
  ScopeAccessError,
  validateScopeAccess,
  withContextBoundary,
  type CapsuleSource,
} from '../src/daemon/index.js';

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** A real in-memory database + capsule repository. */
function createRepo(): {
  close: () => void;
  repo: ContextCapsuleRepository;
} {
  const db = new StorageDatabase({ path: ':memory:' });
  db.open();
  return {
    repo: new ContextCapsuleRepository(db.connection),
    close: () => db.close(),
  };
}

/** Build a project capsule with distinctive content for a given owner. */
function makeProjectCapsule(ownerId: EntityId, marker: string): ContextCapsule {
  return buildProjectCapsule({
    ownerId,
    content: {
      repoMetadata: { path: `/repo/${marker}` },
      policies: { allowAutoApproval: false, livenessTimeoutMs: 300000, alwaysApprove: [] },
      taskListSummary: [
        { taskId: `task_${marker}`, objective: `objective ${marker}`, state: 'created' },
      ],
    },
  });
}

/** Build a task capsule with distinctive content for a given owner. */
function makeTaskCapsule(ownerId: EntityId, marker: string): ContextCapsule {
  return buildTaskCapsule({
    ownerId,
    content: {
      objective: `task objective ${marker}`,
      agentIds: [`agent_${marker}`],
      runHistory: [],
      deliverableIds: [`deliv_${marker}`],
      rolledUpEventSummaries: [`summary ${marker}`],
    },
  });
}

/** Build a session capsule with distinctive content for a given owner. */
function makeSessionCapsule(ownerId: EntityId, marker: string): ContextCapsule {
  return buildSessionCapsule({
    ownerId,
    content: {
      conversation: [`msg ${marker}`],
      toolCalls: [`tool ${marker}`],
      eventIds: [`event_${marker}`],
    },
  });
}

/**
 * A spy CapsuleSource that records every call to loadByScope / listByScope.
 * Used to prove the router only fetches the requested scope, never the
 * whole database.
 */
class SpySource implements CapsuleSource {
  readonly loadCalls: Array<{ scope: ContextCapsuleScope; ownerId: EntityId }> = [];
  readonly listCalls: Array<{ scope: ContextCapsuleScope }> = [];
  private readonly backing: CapsuleSource;

  constructor(backing: CapsuleSource) {
    this.backing = backing;
  }

  loadByScope(scope: ContextCapsuleScope, ownerId: EntityId): ContextCapsule | null {
    this.loadCalls.push({ scope, ownerId });
    return this.backing.loadByScope(scope, ownerId);
  }

  listByScope(scope: ContextCapsuleScope): ContextCapsule[] {
    this.listCalls.push({ scope });
    return this.backing.listByScope(scope);
  }
}

/* ------------------------------------------------------------------ *
 * ContextStore
 * ------------------------------------------------------------------ */

describe('ContextStore', () => {
  it('starts empty', () => {
    const store = new ContextStore();
    expect(store.getActive()).toBeNull();
    expect(store.hasActive()).toBe(false);
    expect(store.getActiveScope()).toBeNull();
    expect(store.getActiveOwnerId()).toBeNull();
  });

  it('set installs the capsule and getActive returns it', () => {
    const store = new ContextStore();
    const cap = makeProjectCapsule('proj_1', 'A');
    store.set(cap);
    expect(store.hasActive()).toBe(true);
    expect(store.getActive()).toBe(cap);
    expect(store.getActiveScope()).toBe('project');
    expect(store.getActiveOwnerId()).toBe('proj_1');
  });

  it('clear discards the active capsule from memory', () => {
    const store = new ContextStore();
    store.set(makeProjectCapsule('proj_1', 'A'));
    store.clear();
    expect(store.getActive()).toBeNull();
    expect(store.hasActive()).toBe(false);
  });

  it('records load history for debugging/isolation verification', () => {
    const store = new ContextStore();
    store.set(makeProjectCapsule('proj_1', 'A'));
    store.clear();
    store.set(makeTaskCapsule('task_2', 'B'));
    const history = store.getLoadHistory();
    expect(history).toHaveLength(3);
    expect(history[0].action).toBe('load');
    expect(history[0].scope).toBe('project');
    expect(history[1].action).toBe('clear');
    expect(history[2].action).toBe('load');
    expect(history[2].scope).toBe('task');
  });

  it('reset clears both the active capsule and history', () => {
    const store = new ContextStore();
    store.set(makeProjectCapsule('proj_1', 'A'));
    store.reset();
    expect(store.getActive()).toBeNull();
    expect(store.getLoadHistory()).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * Context isolation (validateScopeAccess / withContextBoundary)
 * ------------------------------------------------------------------ */

describe('context isolation enforcement', () => {
  it('validateScopeAccess passes when scope and owner match', () => {
    expect(() => validateScopeAccess('task', 'task_1', 'task', 'task_1')).not.toThrow();
  });

  it('validateScopeAccess throws when no context is active', () => {
    expect(() => validateScopeAccess('task', 'task_1', null, null)).toThrow(ScopeAccessError);
  });

  it('validateScopeAccess throws on scope mismatch (same owner)', () => {
    expect(() => validateScopeAccess('task', 'shared', 'project', 'shared')).toThrow(
      ScopeAccessError,
    );
  });

  it('validateScopeAccess throws on owner mismatch (same scope)', () => {
    expect(() => validateScopeAccess('task', 'task_A', 'task', 'task_B')).toThrow(ScopeAccessError);
  });

  it('ScopeAccessError carries the mismatch details', () => {
    try {
      validateScopeAccess('task', 'task_A', 'project', 'proj_B');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ScopeAccessError);
      const err = e as ScopeAccessError;
      expect(err.requestedScope).toBe('task');
      expect(err.requestedOwnerId).toBe('task_A');
      expect(err.activeScope).toBe('project');
      expect(err.activeOwnerId).toBe('proj_B');
    }
  });

  it('withContextBoundary runs the query only when scope matches', () => {
    const result = withContextBoundary('task', 'task_1', 'task', 'task_1', () => 42);
    expect(result).toBe(42);
  });

  it('withContextBoundary does NOT run the query on mismatch', () => {
    let ran = false;
    expect(() =>
      withContextBoundary('task', 'task_1', 'task', 'task_2', () => {
        ran = true;
        return 'should-not-run';
      }),
    ).toThrow(ScopeAccessError);
    expect(ran).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * ContextRouter — loading & active context
 * ------------------------------------------------------------------ */

describe('ContextRouter: loading a capsule', () => {
  let ctx: ReturnType<typeof createRepo>;

  beforeEach(() => {
    ctx = createRepo();
  });
  afterEach(() => ctx.close());

  it('loadCapsule returns null when no capsule exists and leaves nothing active', () => {
    const router = new ContextRouter(ctx.repo);
    expect(router.loadCapsule('task', 'missing')).toBeNull();
    expect(router.getActiveContext()).toBeNull();
  });

  it('loading a Task capsule makes only that task context available', () => {
    const router = new ContextRouter(ctx.repo);
    const taskCap = makeTaskCapsule('task_42', 'X');
    ctx.repo.insert(taskCap);

    const loaded = router.loadCapsule('task', 'task_42');
    expect(loaded).not.toBeNull();
    expect(loaded!.scope).toBe('task');
    expect(router.getActiveContext()).toBe(loaded);
    expect(router.getActiveScope()).toBe('task');
    expect(router.getActiveOwnerId()).toBe('task_42');

    // The active context is exactly the task capsule — no project/session data.
    const active = router.getActiveContext() as TaskCapsule;
    expect(active.content.objective).toBe('task objective X');
    expect(active.content.deliverableIds).toEqual(['deliv_X']);
  });

  it('loading a project capsule makes only project-level context available', () => {
    const router = new ContextRouter(ctx.repo);
    ctx.repo.insert(makeProjectCapsule('proj_1', 'P'));
    const loaded = router.loadCapsule('project', 'proj_1');
    expect(loaded).not.toBeNull();
    const active = router.getActiveContext() as ProjectCapsule;
    expect(active.scope).toBe('project');
    expect(active.content.repoMetadata.path).toBe('/repo/P');
  });
});

/* ------------------------------------------------------------------ *
 * ContextRouter — unloading
 * ------------------------------------------------------------------ */

describe('ContextRouter: unloading a capsule', () => {
  let ctx: ReturnType<typeof createRepo>;

  beforeEach(() => {
    ctx = createRepo();
  });
  afterEach(() => ctx.close());

  it('unloadCapsule discards the active context from memory', () => {
    const router = new ContextRouter(ctx.repo);
    ctx.repo.insert(makeTaskCapsule('task_1', 'A'));
    router.loadCapsule('task', 'task_1');
    expect(router.getActiveContext()).not.toBeNull();

    const { unloaded } = router.unloadCapsule();
    expect(unloaded).not.toBeNull();
    expect(unloaded!.scope).toBe('task');
    expect(router.getActiveContext()).toBeNull();
    expect(router.getActiveScope()).toBeNull();
  });

  it('unloadCapsule returns null when nothing is active', () => {
    const router = new ContextRouter(ctx.repo);
    const { unloaded } = router.unloadCapsule();
    expect(unloaded).toBeNull();
  });

  it('unloadCapsule does NOT delete the capsule from storage (durable)', () => {
    const router = new ContextRouter(ctx.repo);
    ctx.repo.insert(makeTaskCapsule('task_1', 'A'));
    router.loadCapsule('task', 'task_1');
    router.unloadCapsule();

    // The capsule is still in the database and can be reloaded.
    expect(ctx.repo.loadByScope('task', 'task_1')).not.toBeNull();
    const reloaded = router.loadCapsule('task', 'task_1');
    expect(reloaded).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * ContextRouter — switching scopes
 * ------------------------------------------------------------------ */

describe('ContextRouter: switching scopes', () => {
  let ctx: ReturnType<typeof createRepo>;

  beforeEach(() => {
    ctx = createRepo();
  });
  afterEach(() => ctx.close());

  it('switchScope unloads the previous capsule and loads the new one', () => {
    const router = new ContextRouter(ctx.repo);
    ctx.repo.insert(makeProjectCapsule('proj_A', 'A'));
    ctx.repo.insert(makeProjectCapsule('proj_B', 'B'));

    router.loadCapsule('project', 'proj_A');
    expect(router.getActiveOwnerId()).toBe('proj_A');

    const next = router.switchScope('project', 'proj_B');
    expect(next).not.toBeNull();
    expect(router.getActiveOwnerId()).toBe('proj_B');
    const active = router.getActiveContext() as ProjectCapsule;
    expect(active.content.repoMetadata.path).toBe('/repo/B');

    // The previous capsule (proj_A) is no longer the active context.
    expect(router.getActiveOwnerId()).not.toBe('proj_A');
  });

  it('switchScope across scope types (project -> task) unloads and loads', () => {
    const router = new ContextRouter(ctx.repo);
    ctx.repo.insert(makeProjectCapsule('proj_1', 'P'));
    ctx.repo.insert(makeTaskCapsule('task_1', 'T'));

    router.loadCapsule('project', 'proj_1');
    expect(router.getActiveScope()).toBe('project');

    router.switchScope('task', 'task_1');
    expect(router.getActiveScope()).toBe('task');
    expect(router.getActiveOwnerId()).toBe('task_1');
  });

  it('switching away discards old context so it cannot be queried', () => {
    const router = new ContextRouter(ctx.repo);
    ctx.repo.insert(makeProjectCapsule('proj_A', 'A'));
    ctx.repo.insert(makeProjectCapsule('proj_B', 'B'));

    router.loadCapsule('project', 'proj_A');
    router.switchScope('project', 'proj_B');

    // A query scoped to proj_A must now be rejected — proj_A is no longer
    // the active context.
    expect(() => router.queryActive('project', 'proj_A', () => 'leak')).toThrow(ScopeAccessError);
  });
});

/* ------------------------------------------------------------------ *
 * ContextRouter — cross-scope query rejection (no silent contamination)
 * ------------------------------------------------------------------ */

describe('ContextRouter: cross-scope query rejection', () => {
  let ctx: ReturnType<typeof createRepo>;

  beforeEach(() => {
    ctx = createRepo();
  });
  afterEach(() => ctx.close());

  it('queryActive rejects a different owner within the same scope', () => {
    const router = new ContextRouter(ctx.repo);
    ctx.repo.insert(makeTaskCapsule('task_A', 'A'));
    ctx.repo.insert(makeTaskCapsule('task_B', 'B'));

    router.loadCapsule('task', 'task_A');
    expect(() => router.queryActive('task', 'task_B', () => 'leak')).toThrow(ScopeAccessError);
  });

  it('queryActive rejects a different scope with the same owner', () => {
    const router = new ContextRouter(ctx.repo);
    ctx.repo.insert(makeProjectCapsule('shared', 'P'));
    ctx.repo.insert(makeTaskCapsule('shared', 'T'));

    router.loadCapsule('project', 'shared');
    expect(() => router.queryActive('task', 'shared', () => 'leak')).toThrow(ScopeAccessError);
  });

  it('queryActive rejects when no context is active', () => {
    const router = new ContextRouter(ctx.repo);
    expect(() => router.queryActive('task', 'task_1', () => 'leak')).toThrow(ScopeAccessError);
  });

  it('queryActive runs the query when scope and owner match exactly', () => {
    const router = new ContextRouter(ctx.repo);
    ctx.repo.insert(makeTaskCapsule('task_1', 'A'));
    router.loadCapsule('task', 'task_1');

    const result = router.queryActive('task', 'task_1', () => 'ok');
    expect(result).toBe('ok');
  });

  it('assertScope throws on mismatch without running anything', () => {
    const router = new ContextRouter(ctx.repo);
    ctx.repo.insert(makeTaskCapsule('task_A', 'A'));
    router.loadCapsule('task', 'task_A');
    expect(() => router.assertScope('task', 'task_B')).toThrow(ScopeAccessError);
    expect(() => router.assertScope('task', 'task_A')).not.toThrow();
  });

  it('no silent contamination: a loaded task capsule cannot answer a project query', () => {
    const router = new ContextRouter(ctx.repo);
    ctx.repo.insert(makeProjectCapsule('proj_1', 'P'));
    ctx.repo.insert(makeTaskCapsule('task_1', 'T'));

    router.loadCapsule('task', 'task_1');
    // Even though a project capsule exists in storage, the router must not
    // serve it via the active context — the active context is the task.
    const active = router.getActiveContext();
    expect(active!.scope).toBe('task');
    // A project-scoped query is rejected outright.
    expect(() => router.queryActive('project', 'proj_1', () => 'leak')).toThrow(ScopeAccessError);
  });
});

/* ------------------------------------------------------------------ *
 * ContextRouter — load does not fetch the entire DB
 * ------------------------------------------------------------------ */

describe('ContextRouter: load/unload does not load the entire DB', () => {
  let ctx: ReturnType<typeof createRepo>;

  beforeEach(() => {
    ctx = createRepo();
  });
  afterEach(() => ctx.close());

  it('loadCapsule issues exactly one loadByScope call for the requested scope', () => {
    // Seed the DB with capsules across all scopes and several owners.
    ctx.repo.insert(makeProjectCapsule('proj_A', 'A'));
    ctx.repo.insert(makeProjectCapsule('proj_B', 'B'));
    ctx.repo.insert(makeTaskCapsule('task_A', 'A'));
    ctx.repo.insert(makeTaskCapsule('task_B', 'B'));
    ctx.repo.insert(makeSessionCapsule('sess_A', 'A'));

    const spy = new SpySource(ctx.repo);
    const router = new ContextRouter(spy);

    router.loadCapsule('task', 'task_A');

    // Exactly one scoped fetch — no broad scan.
    expect(spy.loadCalls).toHaveLength(1);
    expect(spy.loadCalls[0]).toEqual({ scope: 'task', ownerId: 'task_A' });
    expect(spy.listCalls).toHaveLength(0);
  });

  it('switchScope issues exactly two loadByScope calls (one per load) and no list', () => {
    ctx.repo.insert(makeProjectCapsule('proj_A', 'A'));
    ctx.repo.insert(makeProjectCapsule('proj_B', 'B'));

    const spy = new SpySource(ctx.repo);
    const router = new ContextRouter(spy);

    router.loadCapsule('project', 'proj_A');
    router.switchScope('project', 'proj_B');

    expect(spy.loadCalls).toHaveLength(2);
    expect(spy.loadCalls[0]).toEqual({ scope: 'project', ownerId: 'proj_A' });
    expect(spy.loadCalls[1]).toEqual({ scope: 'project', ownerId: 'proj_B' });
    expect(spy.listCalls).toHaveLength(0);
  });

  it('unloadCapsule performs no storage calls at all', () => {
    ctx.repo.insert(makeTaskCapsule('task_1', 'A'));
    const spy = new SpySource(ctx.repo);
    const router = new ContextRouter(spy);

    router.loadCapsule('task', 'task_1');
    spy.loadCalls.length = 0;
    router.unloadCapsule();

    expect(spy.loadCalls).toHaveLength(0);
    expect(spy.listCalls).toHaveLength(0);
  });

  it('getGlobalAwareness lists project capsules only (not task/session)', () => {
    ctx.repo.insert(makeProjectCapsule('proj_A', 'A'));
    ctx.repo.insert(makeProjectCapsule('proj_B', 'B'));
    ctx.repo.insert(makeTaskCapsule('task_A', 'A'));
    ctx.repo.insert(makeSessionCapsule('sess_A', 'A'));

    const spy = new SpySource(ctx.repo);
    const router = new ContextRouter(spy);

    const awareness = router.getGlobalAwareness();
    expect(awareness.projects).toHaveLength(2);
    expect(awareness.projects.every((p) => p.scope === 'project')).toBe(true);
    // Global awareness is the only place a list is issued, and only for
    // the project scope.
    expect(spy.listCalls).toHaveLength(1);
    expect(spy.listCalls[0]).toEqual({ scope: 'project' });
  });
});

/* ------------------------------------------------------------------ *
 * ContextRouter — isolation between two concurrent project contexts
 * (simulated via rapid switching)
 * ------------------------------------------------------------------ */

describe('ContextRouter: isolation between two project contexts (rapid switching)', () => {
  let ctx: ReturnType<typeof createRepo>;

  beforeEach(() => {
    ctx = createRepo();
  });
  afterEach(() => ctx.close());

  it('rapid switching between two projects never contaminates either context', () => {
    const router = new ContextRouter(ctx.repo);
    ctx.repo.insert(makeProjectCapsule('proj_Alpha', 'Alpha'));
    ctx.repo.insert(makeProjectCapsule('proj_Beta', 'Beta'));

    // Simulate rapid context switching as a user would when juggling two
    // concurrent projects. After each switch, verify the active context
    // contains ONLY the project just loaded — never a mix.
    for (let i = 0; i < 10; i++) {
      const alphaFirst = i % 2 === 0;
      const first = alphaFirst ? 'proj_Alpha' : 'proj_Beta';
      const second = alphaFirst ? 'proj_Beta' : 'proj_Alpha';
      const firstMarker = alphaFirst ? 'Alpha' : 'Beta';
      const secondMarker = alphaFirst ? 'Beta' : 'Alpha';

      router.switchScope('project', first);
      let active = router.getActiveContext() as ProjectCapsule;
      expect(active.ownerId).toBe(first);
      expect(active.content.repoMetadata.path).toBe(`/repo/${firstMarker}`);
      // Cross-scope query to the OTHER project is rejected.
      expect(() => router.queryActive('project', second, () => 'leak')).toThrow(ScopeAccessError);

      router.switchScope('project', second);
      active = router.getActiveContext() as ProjectCapsule;
      expect(active.ownerId).toBe(second);
      expect(active.content.repoMetadata.path).toBe(`/repo/${secondMarker}`);
      // Now the first project is the rejected one.
      expect(() => router.queryActive('project', first, () => 'leak')).toThrow(ScopeAccessError);
    }
  });

  it('after switching away, the store holds no reference to the previous capsule', () => {
    const store = new ContextStore();
    const router = new ContextRouter(ctx.repo, store);
    ctx.repo.insert(makeProjectCapsule('proj_Alpha', 'Alpha'));
    ctx.repo.insert(makeProjectCapsule('proj_Beta', 'Beta'));

    router.loadCapsule('project', 'proj_Alpha');
    const alphaCap = store.getActive();
    router.switchScope('project', 'proj_Beta');

    // The active capsule is now Beta, and Alpha is not retained.
    expect(store.getActive()).not.toBe(alphaCap);
    expect(store.getActiveOwnerId()).toBe('proj_Beta');
  });

  it('load history shows a clear-then-load pattern on every switch (no overlap)', () => {
    const store = new ContextStore();
    const router = new ContextRouter(ctx.repo, store);
    ctx.repo.insert(makeProjectCapsule('proj_Alpha', 'Alpha'));
    ctx.repo.insert(makeProjectCapsule('proj_Beta', 'Beta'));

    router.loadCapsule('project', 'proj_Alpha');
    router.switchScope('project', 'proj_Beta');

    const history = store.getLoadHistory();
    // load Alpha, clear, load Beta
    expect(history).toHaveLength(3);
    expect(history[0]).toMatchObject({ action: 'load', ownerId: 'proj_Alpha' });
    expect(history[1]).toMatchObject({ action: 'clear' });
    expect(history[2]).toMatchObject({ action: 'load', ownerId: 'proj_Beta' });
  });

  it('two project contexts stay isolated even when interleaved with a task load', () => {
    const router = new ContextRouter(ctx.repo);
    ctx.repo.insert(makeProjectCapsule('proj_Alpha', 'Alpha'));
    ctx.repo.insert(makeProjectCapsule('proj_Beta', 'Beta'));
    ctx.repo.insert(makeTaskCapsule('task_in_alpha', 'T'));

    router.switchScope('project', 'proj_Alpha');
    expect(router.getActiveOwnerId()).toBe('proj_Alpha');

    // Jump to a task — the Alpha project context must be gone.
    router.switchScope('task', 'task_in_alpha');
    expect(router.getActiveScope()).toBe('task');
    expect(() => router.queryActive('project', 'proj_Alpha', () => 'leak')).toThrow(
      ScopeAccessError,
    );

    // Jump back to Beta — the task context must be gone.
    router.switchScope('project', 'proj_Beta');
    expect(router.getActiveScope()).toBe('project');
    expect(router.getActiveOwnerId()).toBe('proj_Beta');
    expect(() => router.queryActive('task', 'task_in_alpha', () => 'leak')).toThrow(
      ScopeAccessError,
    );
  });
});
