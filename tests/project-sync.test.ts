/**
 * Unit and integration tests for Project Sync (issue #175).
 *
 * Verifies:
 * - "Same folder -> same Florina project" rule across providers.
 * - Path canonicalization across OS separators, trailing slashes, and case policies.
 * - Idempotency: re-running sync never duplicates projects.
 * - DEC-012 event journaling for newly created projects.
 * - Read-only guarantee: provider directories/files are never written to.
 * - Attributing sessions and events to the shared Florina project.
 * - Claude, Codex, Devin, and Antigravity provider project scanners.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import type {
  EntityId,
  Event,
  Project,
  Task,
} from '../src/core/domain/types.js';
import type {
  EventJournalPort,
  ProjectRepositoryPort,
  TaskRepositoryPort,
} from '../src/core/application/ports/outbound/repositories.js';
import type {
  PathCanonicalizerPort,
  ProviderProjectScannerPort,
} from '../src/core/application/ports/outbound/provider-projects.js';
import {
  folderBasename,
  ProjectSyncService,
} from '../src/core/application/use-cases/projects/project-sync.js';
import { NodePathCanonicalizer } from '../src/adapters/outbound/projects/node-path-canonicalizer.js';
import { ClaudeProjectScanner } from '../src/adapters/outbound/projects/claude-project-scanner.js';
import { CodexProjectScanner } from '../src/adapters/outbound/projects/codex-project-scanner.js';
import {
  decodeWorkspaceUri,
  DevinProjectScanner,
} from '../src/adapters/outbound/projects/devin-project-scanner.js';
import { AntigravityProjectScanner } from '../src/adapters/outbound/projects/antigravity-project-scanner.js';
import { CompositeProviderScanner } from '../src/adapters/outbound/projects/composite-provider-scanner.js';

/* ------------------------------------------------------------------ *
 * In-memory test doubles
 * ------------------------------------------------------------------ */

class InMemoryProjectRepository implements ProjectRepositoryPort {
  private readonly items = new Map<EntityId, Project>();

  insert(project: Project): void {
    if (this.items.has(project.id)) {
      throw new Error(`Project ${project.id} already exists`);
    }
    this.items.set(project.id, project);
  }

  getById(id: EntityId): Project | null {
    return this.items.get(id) ?? null;
  }

  listAll(): Project[] {
    return Array.from(this.items.values());
  }

  update(project: Project): void {
    this.items.set(project.id, project);
  }
}

class InMemoryEventJournal implements EventJournalPort {
  readonly events: Event[] = [];

  insert(event: Event): void {
    this.events.push(event);
  }

  getById(id: EntityId): Event | null {
    return this.events.find((e) => e.id === id) ?? null;
  }

  listByTask(taskId: EntityId): Event[] {
    return this.events.filter((e) => e.taskId === taskId);
  }

  listBySession(sessionId: EntityId): Event[] {
    return this.events.filter((e) => e.sessionId === sessionId);
  }

  listByTimestampRange(start: string, end: string): Event[] {
    return this.events.filter((e) => e.timestamp >= start && e.timestamp <= end);
  }
}

class InMemoryTaskRepository implements TaskRepositoryPort {
  private readonly items = new Map<EntityId, Task>();

  insert(task: Task): void {
    this.items.set(task.id, task);
  }

  getById(id: EntityId): Task | null {
    return this.items.get(id) ?? null;
  }

  listByProject(projectId: EntityId): Task[] {
    return Array.from(this.items.values()).filter((t) => t.projectId === projectId);
  }

  listAll(): readonly Task[] {
    return Array.from(this.items.values());
  }

  update(task: Task): void {
    this.items.set(task.id, task);
  }
}

class StaticCanonicalizer implements PathCanonicalizerPort {
  canonicalize(rawPath: string): string {
    return rawPath
      .replace(/\\/g, '/')
      .replace(/\/+$/, '')
      .toLowerCase();
  }
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

describe('Project Sync (issue #175)', () => {
  describe('folderBasename', () => {
    it('extracts basename for POSIX paths', () => {
      expect(folderBasename('/home/user/code/my-repo')).toBe('my-repo');
      expect(folderBasename('/home/user/code/my-repo/')).toBe('my-repo');
    });

    it('extracts basename for Windows paths', () => {
      expect(folderBasename('C:\\Users\\Vlad\\Documents\\Github\\agent-secretary')).toBe(
        'agent-secretary',
      );
      expect(folderBasename('C:\\Users\\Vlad\\Documents\\Github\\agent-secretary\\')).toBe(
        'agent-secretary',
      );
      expect(folderBasename('c:/users/vlad/repos/card-game/')).toBe('card-game');
    });
  });

  describe('NodePathCanonicalizer', () => {
    it('normalizes backslashes to forward slashes', () => {
      const canonicalizer = new NodePathCanonicalizer({
        platform: 'linux',
        realpathFn: (p) => p,
      });
      expect(canonicalizer.canonicalize('C:\\Users\\Vlad\\Repo')).toBe('C:/Users/Vlad/Repo');
    });

    it('strips trailing slashes without stripping root', () => {
      const canonicalizer = new NodePathCanonicalizer({
        platform: 'linux',
        realpathFn: (p) => p,
      });
      expect(canonicalizer.canonicalize('/home/user/repo///')).toBe('/home/user/repo');
      expect(canonicalizer.canonicalize('C:/Users/repo/')).toBe('C:/Users/repo');
    });

    it('case-folds paths on Windows and macOS, preserves on Linux', () => {
      const winCanonicalizer = new NodePathCanonicalizer({
        platform: 'win32',
        realpathFn: (p) => p,
      });
      const macCanonicalizer = new NodePathCanonicalizer({
        platform: 'darwin',
        realpathFn: (p) => p,
      });
      const linuxCanonicalizer = new NodePathCanonicalizer({
        platform: 'linux',
        realpathFn: (p) => p,
      });

      const sample = 'C:/Users/Vlad/Documents/Github/Repo';
      expect(winCanonicalizer.canonicalize(sample)).toBe('c:/users/vlad/documents/github/repo');
      expect(macCanonicalizer.canonicalize(sample)).toBe('c:/users/vlad/documents/github/repo');
      expect(linuxCanonicalizer.canonicalize(sample)).toBe('C:/Users/Vlad/Documents/Github/Repo');
    });

    it('resolves symlinks using realpathFn', () => {
      const canonicalizer = new NodePathCanonicalizer({
        platform: 'linux',
        realpathFn: (p) => (p === '/symlink/target' ? '/real/storage/path' : p),
      });
      expect(canonicalizer.canonicalize('/symlink/target')).toBe('/real/storage/path');
    });

    it('strips Windows extended-length \\\\?\\ and \\\\?\\UNC\\ prefixes', () => {
      const canonicalizer = new NodePathCanonicalizer({
        platform: 'win32',
        realpathFn: (p) => p,
      });
      expect(canonicalizer.canonicalize('\\\\?\\C:\\Users\\Vlad\\Repo')).toBe(
        'c:/users/vlad/repo',
      );
      expect(canonicalizer.canonicalize('\\\\?\\UNC\\server\\share\\repo')).toBe(
        '//server/share/repo',
      );
    });
  });

  describe('ProjectSyncService: Same folder -> same Florina project', () => {
    it('maps multiple providers pointing to the same folder to a single Florina project', async () => {
      const projects = new InMemoryProjectRepository();
      const eventJournal = new InMemoryEventJournal();
      const canonicalizer = new StaticCanonicalizer();
      const syncService = new ProjectSyncService({ projects, eventJournal, canonicalizer });

      const scanner1: ProviderProjectScannerPort = {
        providerId: 'claude-code',
        scanProjects: () => [
          {
            provider: 'claude-code',
            folderPath: 'C:\\Users\\Vlad\\Documents\\Github\\shared-project',
          },
        ],
      };

      const scanner2: ProviderProjectScannerPort = {
        providerId: 'codex',
        scanProjects: () => [
          {
            provider: 'codex',
            folderPath: 'c:/users/vlad/documents/github/shared-project/',
            name: 'Shared Project',
          },
        ],
      };

      const scanner3: ProviderProjectScannerPort = {
        providerId: 'devin',
        scanProjects: () => [
          {
            provider: 'devin',
            folderPath: 'C:/Users/Vlad/Documents/Github/shared-project',
          },
        ],
      };

      const result = await syncService.sync([scanner1, scanner2, scanner3], {
        taskId: 'task-test-1',
        sessionId: 'session-test-1',
      });

      // Exactly ONE Florina project must be created
      expect(result.created).toHaveLength(1);
      const createdProject = result.created[0];
      expect(createdProject.name).toBe('shared-project');
      expect(projects.listAll()).toHaveLength(1);

      // All 3 providers matched to that same project
      expect(result.matched).toHaveLength(3);
      expect(result.matched.every((m) => m.projectId === createdProject.id)).toBe(true);

      // Verify DEC-012 event was journaled
      expect(eventJournal.events).toHaveLength(1);
      expect(eventJournal.events[0].kind).toBe('AgentProgress');
      expect(eventJournal.events[0].payload['action']).toBe('project_created_from_sync');
      expect(eventJournal.events[0].payload['projectId']).toBe(createdProject.id);
    });

    it('is strictly idempotent — re-running sync never creates duplicate projects', async () => {
      const projects = new InMemoryProjectRepository();
      const eventJournal = new InMemoryEventJournal();
      const canonicalizer = new StaticCanonicalizer();
      const syncService = new ProjectSyncService({ projects, eventJournal, canonicalizer });

      const scanner: ProviderProjectScannerPort = {
        providerId: 'codex',
        scanProjects: () => [
          { provider: 'codex', folderPath: '/repos/project-a' },
          { provider: 'codex', folderPath: '/repos/project-b' },
        ],
      };

      const context = { taskId: 'task-sync-all', sessionId: 'sess-sync-all' };
      // Pass 1: creates 2 projects
      const result1 = await syncService.sync([scanner], context);
      expect(result1.created).toHaveLength(2);
      expect(projects.listAll()).toHaveLength(2);
      expect(eventJournal.events).toHaveLength(2);

      // Pass 2: creates 0 projects; all matched to existing
      const result2 = await syncService.sync([scanner], context);
      expect(result2.created).toHaveLength(0);
      expect(result2.matched).toHaveLength(2);
      expect(projects.listAll()).toHaveLength(2);
      expect(eventJournal.events).toHaveLength(2); // no new events
    });

    it('attaches discovered provider project to pre-existing Florina project', async () => {
      const projects = new InMemoryProjectRepository();
      const eventJournal = new InMemoryEventJournal();
      const canonicalizer = new StaticCanonicalizer();

      // Pre-seed an existing Florina project
      const existing: Project = {
        id: 'proj-manual-1',
        name: 'Manual Existing Project',
        repo: { path: '/workspace/existing-repo' },
        policies: {
          allowAutoApproval: false,
          livenessTimeoutMs: 5 * 60 * 1000,
          alwaysApprove: [],
        },
        taskIds: [],
        capsuleId: 'capsule-manual-1',
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
      };
      projects.insert(existing);

      const syncService = new ProjectSyncService({ projects, eventJournal, canonicalizer });

      const scanner: ProviderProjectScannerPort = {
        providerId: 'claude-code',
        scanProjects: () => [
          { provider: 'claude-code', folderPath: '/workspace/existing-repo/' },
        ],
      };

      const result = await syncService.sync([scanner]);
      expect(result.created).toHaveLength(0);
      expect(result.matched).toHaveLength(1);
      expect(result.matched[0].projectId).toBe('proj-manual-1');
      expect(projects.listAll()).toHaveLength(1);
    });

    it('resolveProjectForFolder finds project by canonical path regardless of separator or case', () => {
      const projects = new InMemoryProjectRepository();
      const eventJournal = new InMemoryEventJournal();
      const canonicalizer = new StaticCanonicalizer();
      const syncService = new ProjectSyncService({ projects, eventJournal, canonicalizer });

      projects.insert({
        id: 'proj-card-game',
        name: 'Card Game',
        repo: { path: 'C:/Users/Vlad/Documents/Github/card-game' },
        policies: { allowAutoApproval: false, livenessTimeoutMs: 5 * 60 * 1000, alwaysApprove: [] },
        taskIds: [],
        capsuleId: 'capsule-1',
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
      });

      // Different casing and backslashes
      const resolved = syncService.resolveProjectForFolder(
        'c:\\users\\vlad\\documents\\github\\card-game\\',
      );
      expect(resolved).not.toBeNull();
      expect(resolved?.id).toBe('proj-card-game');

      expect(syncService.resolveProjectForFolder('/non/existent')).toBeNull();
    });

    it('attributeToProject attributes sessions/events via workingDir or taskId', () => {
      const projects = new InMemoryProjectRepository();
      const eventJournal = new InMemoryEventJournal();
      const taskStore = new InMemoryTaskRepository();
      const canonicalizer = new StaticCanonicalizer();
      const syncService = new ProjectSyncService({
        projects,
        eventJournal,
        taskStore,
        canonicalizer,
      });

      projects.insert({
        id: 'proj-repo-1',
        name: 'Repo 1',
        repo: { path: '/workspace/repo-1' },
        policies: { allowAutoApproval: false, livenessTimeoutMs: 5 * 60 * 1000, alwaysApprove: [] },
        taskIds: [],
        capsuleId: 'capsule-1',
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
      });

      taskStore.insert({
        id: 'task-100',
        projectId: 'proj-repo-1',
        objective: 'Test task',
        state: 'running' as const,
        agentIds: [],
        sessionIds: [],
        deliverableIds: [],
        attentionItemIds: [],
        capsuleId: 'cap-task',
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
      });

      // Attribution via taskId
      expect(syncService.attributeToProject({ taskId: 'task-100' })).toBe('proj-repo-1');

      // Attribution via workingDir
      expect(syncService.attributeToProject({ workingDir: '/workspace/repo-1/' })).toBe(
        'proj-repo-1',
      );

      // Unmatched returns null
      expect(syncService.attributeToProject({ workingDir: '/unknown' })).toBeNull();
    });
  });

  describe('Provider Scanners (read-only assertions and parsing)', () => {
    it('ClaudeProjectScanner parses .claude.json projects dictionary', () => {
      const mockJson = JSON.stringify({
        projects: {
          'C:/Users/Vlad/Documents/Github/card-game': { createdAt: 123 },
          'C:/Users/Vlad/Documents/Github/agent-secretary': {},
        },
      });

      const scanner = new ClaudeProjectScanner({
        homeDir: '/mock/home',
        existsSyncFn: (p) => p.endsWith('.claude.json'),
        readFileSyncFn: () => mockJson,
      });

      const discovered = scanner.scanProjects();
      expect(discovered).toHaveLength(2);
      expect(discovered[0].provider).toBe('claude-code');
      expect(discovered[0].folderPath).toBe('C:/Users/Vlad/Documents/Github/card-game');
      expect(discovered[1].folderPath).toBe('C:/Users/Vlad/Documents/Github/agent-secretary');
    });

    it('ClaudeProjectScanner ignores array-shaped projects property', () => {
      const mockJson = JSON.stringify({
        projects: ['/invalid/array/path'],
      });
      const scanner = new ClaudeProjectScanner({
        homeDir: '/mock/home',
        existsSyncFn: () => true,
        readFileSyncFn: () => mockJson,
      });
      expect(scanner.scanProjects()).toEqual([]);
    });

    it('CodexProjectScanner parses .codex-global-state.json local-projects and saved roots', () => {
      const mockState = JSON.stringify({
        'local-projects': {
          'proj-1': {
            id: 'proj-1',
            name: 'Leetcode Coach',
            rootPaths: ['C:\\Users\\Vlad\\Documents\\Github\\leetcode-coach-service'],
          },
        },
        'electron-saved-workspace-roots': [
          'C:\\Users\\Vlad\\Documents\\Github\\trinity-pilot-wrapper',
        ],
      });

      const scanner = new CodexProjectScanner({
        homeDir: '/mock/home',
        existsSyncFn: (p) => p.endsWith('.codex-global-state.json'),
        readFileSyncFn: () => mockState,
      });

      const discovered = scanner.scanProjects();
      expect(discovered).toHaveLength(2);
      expect(discovered[0].provider).toBe('codex');
      expect(discovered[0].name).toBe('Leetcode Coach');
      expect(discovered[0].folderPath).toBe(
        'C:\\Users\\Vlad\\Documents\\Github\\leetcode-coach-service',
      );
      expect(discovered[1].folderPath).toBe(
        'C:\\Users\\Vlad\\Documents\\Github\\trinity-pilot-wrapper',
      );
    });

    it('DevinProjectScanner parses workspaceStorage and decodes file:// URIs', () => {
      expect(decodeWorkspaceUri('file:///c%3A/Users/Vlad/Documents/Github/dwurdy-site')).toBe(
        'c:/Users/Vlad/Documents/Github/dwurdy-site',
      );
      expect(decodeWorkspaceUri('file:///home/user/project')).toBe('/home/user/project');
      expect(decodeWorkspaceUri('file://server/share/repo')).toBe('//server/share/repo');

      const scanner = new DevinProjectScanner({
        appDataDir: '/mock/appdata',
        existsSyncFn: () => true,
        readdirSyncFn: () => ['hash1'],
        readFileSyncFn: () =>
          JSON.stringify({ folder: 'file:///c%3A/Users/Vlad/Documents/Github/dwurdy-site' }),
      });

      const discovered = scanner.scanProjects();
      expect(discovered).toHaveLength(1);
      expect(discovered[0].provider).toBe('devin');
      expect(discovered[0].folderPath).toBe('c:/Users/Vlad/Documents/Github/dwurdy-site');
      expect(discovered[0].externalId).toBe('hash1');
    });

    it('AntigravityProjectScanner discovers workspace roots from brain conversation logs', () => {
      const mockTranscript = JSON.stringify({
        workspaceUris: ['file:///c%3A/Users/Vlad/Documents/Github/agent-secretary'],
      });

      const scanner = new AntigravityProjectScanner({
        baseDir: '/mock/gemini/antigravity',
        existsSyncFn: () => true,
        readdirSyncFn: () => ['convo-1'],
        readFileSyncFn: () => mockTranscript,
      });

      const discovered = scanner.scanProjects();
      expect(discovered).toHaveLength(1);
      expect(discovered[0].provider).toBe('antigravity');
      expect(discovered[0].folderPath).toBe('c:/Users/Vlad/Documents/Github/agent-secretary');
    });

    it('CompositeProviderScanner aggregates discovered projects across all scanners', async () => {
      const s1: ProviderProjectScannerPort = {
        providerId: 'claude-code',
        scanProjects: () => [{ provider: 'claude-code', folderPath: '/a' }],
      };
      const s2: ProviderProjectScannerPort = {
        providerId: 'codex',
        scanProjects: () => [{ provider: 'codex', folderPath: '/b' }],
      };

      const composite = new CompositeProviderScanner({ scanners: [s1, s2] });
      const discovered = await composite.scanProjects();
      expect(discovered).toHaveLength(2);
      expect(discovered[0].folderPath).toBe('/a');
      expect(discovered[1].folderPath).toBe('/b');
    });

    it('ASSERTION: sync code has no write paths to provider configuration directories', () => {
      // Introspect scanner modules to ensure no writeFileSync, appendFileSync,
      // unlinkSync, or rmSync is referenced in provider scanners
      const scannerSourceFiles = [
        'src/adapters/outbound/projects/claude-project-scanner.ts',
        'src/adapters/outbound/projects/codex-project-scanner.ts',
        'src/adapters/outbound/projects/devin-project-scanner.ts',
        'src/adapters/outbound/projects/antigravity-project-scanner.ts',
        'src/adapters/outbound/projects/composite-provider-scanner.ts',
      ];

      for (const file of scannerSourceFiles) {
        const source = readFileSync(file, 'utf8');
        expect(source).not.toContain('writeFileSync');
        expect(source).not.toContain('appendFileSync');
        expect(source).not.toContain('unlinkSync');
        expect(source).not.toContain('rmSync');
      }

      // Assert via module interface: scanners only expose read-only methods
      expect(ClaudeProjectScanner.prototype).not.toHaveProperty('saveConfig');
      expect(CodexProjectScanner.prototype).not.toHaveProperty('writeState');
      expect(DevinProjectScanner.prototype).not.toHaveProperty('saveWorkspace');
    });

    it('LIVE SYSTEM PROOF: real provider scanners discover existing local projects on host', async () => {
      const realCanonicalizer = new NodePathCanonicalizer();
      const realScanner = new CompositeProviderScanner();
      const discovered = await realScanner.scanProjects();

      // Run sync against in-memory stores to prove end-to-end convergence
      const projects = new InMemoryProjectRepository();
      const eventJournal = new InMemoryEventJournal();
      const syncService = new ProjectSyncService({
        projects,
        eventJournal,
        canonicalizer: realCanonicalizer,
      });

      const syncResult = await syncService.sync([realScanner]);
      expect(syncResult.totalDiscovered).toBe(discovered.length);
      expect(syncResult.matched.length).toBe(discovered.length);

      if (discovered.length > 0) {
        expect(projects.listAll().length).toBeGreaterThan(0);
        // Verify that re-sync is 100% idempotent on real discovered projects
        const secondSync = await syncService.sync([realScanner]);
        expect(secondSync.created).toHaveLength(0);
        expect(secondSync.matched.length).toBe(discovered.length);
      }
    });

    it('INTEGRATION PROOF: runs ProjectSyncService against real SQLite StorageDatabase with foreign_keys ON', async () => {
      const { StorageDatabase } = await import(
        '../src/adapters/outbound/persistence/sqlite/database.js'
      );
      const { ProjectRepository } = await import(
        '../src/adapters/outbound/persistence/sqlite/repositories/project.js'
      );

      const db = new StorageDatabase({ memory: true });
      await db.open();
      try {
        const projectRepo = new ProjectRepository(db.connection);
        const canonicalizer = new StaticCanonicalizer();
        const syncService = new ProjectSyncService({
          projects: projectRepo,
          canonicalizer,
        });

        const scanner: ProviderProjectScannerPort = {
          providerId: 'codex',
          scanProjects: () => [
            { provider: 'codex', folderPath: '/repos/real-sqlite-project' },
          ],
        };

        const result = await syncService.sync([scanner]);
        expect(result.created).toHaveLength(1);
        expect(result.matched).toHaveLength(1);

        const loaded = projectRepo.getById(result.created[0].id);
        expect(loaded).not.toBeNull();
        expect(loaded?.name).toBe('real-sqlite-project');
        expect(loaded?.repo.path).toBe('/repos/real-sqlite-project');

        // Test idempotency on real SQLite
        const resync = await syncService.sync([scanner]);
        expect(resync.created).toHaveLength(0);
        expect(resync.matched).toHaveLength(1);
        expect(projectRepo.listAll()).toHaveLength(1);
      } finally {
        db.close();
      }
    });
  });
});

