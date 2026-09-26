/**
 * Project sync across providers use case (issue #175).
 *
 * Each provider CLI (Claude Code, Codex, Devin, Antigravity) keeps its own
 * notion of "the project" rooted at a working directory. This service implements
 * the core rule:
 *
 *   "Same folder -> same Florina project."
 *
 * On sync, providers' projects are matched to Florina projects by canonicalized
 * working-directory path (normalized separators, case-policy per OS, symlinks
 * resolved). A folder mapping to an existing Florina project attaches to it;
 * an unknown folder creates a new Florina project named from its folder
 * basename and journals the creation (DEC-012).
 *
 * Read-only on provider state: this service and its outbound scanners never
 * write to or modify provider configs or directories.
 */
import type {
  EntityId,
  Project,
} from '../../../domain/types.js';
import type {
  EventJournalPort,
  ProjectRepositoryPort,
  TaskRepositoryPort,
} from '../../ports/outbound/repositories.js';
import type {
  DiscoveredProviderProject,
  PathCanonicalizerPort,
  ProviderProjectScannerPort,
} from '../../ports/outbound/provider-projects.js';

export interface ProjectSyncContext {
  readonly taskId?: EntityId;
  readonly sessionId?: EntityId;
}

export interface ProjectSyncOptions {
  readonly projects: ProjectRepositoryPort;
  readonly canonicalizer: PathCanonicalizerPort;
  readonly eventJournal?: EventJournalPort;
  readonly taskStore?: TaskRepositoryPort;
  readonly now?: () => string;
}

export interface MatchedProviderProject {
  readonly provider: string;
  readonly folderPath: string;
  readonly canonicalPath: string;
  readonly projectId: EntityId;
  readonly name?: string;
  readonly externalId?: string;
}

export interface ProjectSyncResult {
  /** Provider projects mapped to an existing or newly created Florina project. */
  readonly matched: readonly MatchedProviderProject[];
  /** New Florina projects created during this sync pass. */
  readonly created: readonly Project[];
  /** Total count of provider projects discovered across all scanners. */
  readonly totalDiscovered: number;
}

/** Pure helper to extract the folder basename across Windows and POSIX separators. */
export function folderBasename(folderPath: string): string {
  const trimmed = folderPath.replace(/[/\\]+$/, '');
  const lastSlash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (lastSlash === -1) return trimmed || 'project';
  return trimmed.slice(lastSlash + 1) || 'project';
}

function sanitizeSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
}

export class ProjectSyncService {
  private readonly projects: ProjectRepositoryPort;
  private readonly canonicalizer: PathCanonicalizerPort;
  private readonly eventJournal?: EventJournalPort;
  private readonly taskStore?: TaskRepositoryPort;
  private readonly now: () => string;

  constructor(options: ProjectSyncOptions) {
    this.projects = options.projects;
    this.canonicalizer = options.canonicalizer;
    this.eventJournal = options.eventJournal;
    this.taskStore = options.taskStore;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /**
   * Run a sync pass across the provided scanners:
   * 1. Discover projects from each provider.
   * 2. Canonicalize each folder path.
   * 3. Match against existing Florina projects (idempotent).
   * 4. For unseen folders, create a new Florina project and journal it (DEC-012)
   *    if task/session execution context is provided.
   */
  async sync(
    scanners: readonly ProviderProjectScannerPort[],
    context?: ProjectSyncContext,
  ): Promise<ProjectSyncResult> {
    const allDiscovered: DiscoveredProviderProject[] = [];
    for (const scanner of scanners) {
      try {
        const found = await scanner.scanProjects();
        allDiscovered.push(...found);
      } catch {
        // Individual scanner failure degrades gracefully without aborting sync.
      }
    }

    const existingProjects = this.projects.listAll();
    // Build map of canonicalPath -> Project
    const projectByCanonicalPath = new Map<string, Project>();
    for (const proj of existingProjects) {
      if (proj.repo?.path) {
        const canonical = this.canonicalizer.canonicalize(proj.repo.path);
        projectByCanonicalPath.set(canonical, proj);
      }
    }

    const matched: MatchedProviderProject[] = [];
    const created: Project[] = [];
    let nextIdSuffix = 1;

    for (const discovered of allDiscovered) {
      if (!discovered.folderPath || discovered.folderPath.trim() === '') {
        continue;
      }

      const canonical = this.canonicalizer.canonicalize(discovered.folderPath);
      let project = projectByCanonicalPath.get(canonical);

      if (project === undefined) {
        // Create a new Florina project for this folder
        const timestamp = this.now();
        const baseName = folderBasename(discovered.folderPath);
        const slug = sanitizeSlug(baseName);
        let candidateId = `proj-${slug}`;
        while (this.projects.getById(candidateId) !== null) {
          candidateId = `proj-${slug}-${nextIdSuffix++}`;
        }

        const newProject: Project = {
          id: candidateId,
          name: discovered.name || baseName,
          repo: {
            path: discovered.folderPath,
          },
          policies: {
            allowAutoApproval: false,
            livenessTimeoutMs: 5 * 60 * 1000,
            alwaysApprove: [],
          },
          taskIds: [],
          capsuleId: `capsule-${candidateId}`,
          createdAt: timestamp,
          updatedAt: timestamp,
        };

        this.projects.insert(newProject);
        projectByCanonicalPath.set(canonical, newProject);
        created.push(newProject);
        project = newProject;

        // Journal project creation if running within valid task/session context (DEC-012)
        if (this.eventJournal && context?.taskId && context?.sessionId) {
          this.eventJournal.insert({
            id: `evt-${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
            taskId: context.taskId,
            sessionId: context.sessionId,
            timestamp,
            kind: 'AgentProgress',
            payload: {
              message: `Project created from sync: ${newProject.name}`,
              action: 'project_created_from_sync',
              projectId: newProject.id,
              name: newProject.name,
              folderPath: discovered.folderPath,
              canonicalPath: canonical,
              provider: discovered.provider,
            },
          });
        }
      }

      matched.push({
        provider: discovered.provider,
        folderPath: discovered.folderPath,
        canonicalPath: canonical,
        projectId: project.id,
        ...(discovered.name ? { name: discovered.name } : {}),
        ...(discovered.externalId ? { externalId: discovered.externalId } : {}),
      });
    }

    return {
      matched,
      created,
      totalDiscovered: allDiscovered.length,
    };
  }

  /**
   * Find the Florina project that corresponds to `folderPath` by canonical path.
   */
  resolveProjectForFolder(folderPath: string): Project | null {
    if (!folderPath) return null;
    const targetCanonical = this.canonicalizer.canonicalize(folderPath);
    for (const project of this.projects.listAll()) {
      if (project.repo?.path) {
        if (this.canonicalizer.canonicalize(project.repo.path) === targetCanonical) {
          return project;
        }
      }
    }
    return null;
  }

  /**
   * Attribute an agent session, event, or task to a shared Florina project.
   * Priority:
   * 1. If taskId is supplied and taskStore is available, look up task.projectId.
   * 2. If workingDir is supplied, resolve by canonical folder path.
   */
  attributeToProject(item: { workingDir?: string; taskId?: string }): EntityId | null {
    if (item.taskId && this.taskStore) {
      const task = this.taskStore.getById(item.taskId);
      if (task?.projectId) {
        return task.projectId;
      }
    }
    if (item.workingDir) {
      const proj = this.resolveProjectForFolder(item.workingDir);
      if (proj) {
        return proj.id;
      }
    }
    return null;
  }
}
