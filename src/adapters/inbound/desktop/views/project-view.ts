/**
 * Project view (issue #74): one project, its manager card (status,
 * objective, context health), and its worker tasks. The user talks to
 * the manager, not the workers — workers are read-only drill-down.
 *
 * Pure view model + {@link RenderTree} template over task/context
 * snapshots.
 */
import type { TaskSnapshot } from '../../../../core/application/use-cases/tasks/command-api.js';
import type { ContextHealthSnapshot } from '../../../../core/application/use-cases/context/context-health-monitor.js';
import type { RenderTree } from './view-types.js';
import { HEALTH_METADATA } from './context-health-view.js';

/** The manager card at the top of a project view. */
export interface ManagerCardView {
  readonly taskId: string;
  readonly objective: string;
  readonly state: string;
  /** Context health of the manager agent, when tracked. */
  readonly health?: {
    readonly status: ContextHealthSnapshot['status'];
    readonly windowFillPct: number;
  };
}

/** One worker row under the manager card. */
export interface WorkerRowView {
  readonly taskId: string;
  readonly objective: string;
  readonly state: string;
  readonly agentIds: readonly string[];
}

/** Full project view data. */
export interface ProjectViewData {
  readonly projectId: string;
  readonly projectName: string;
  readonly manager?: ManagerCardView;
  readonly workers: readonly WorkerRowView[];
  readonly isEmpty: boolean;
}

/**
 * Build the project view. The caller decides which task is the manager
 * (manager-role tasks are spawned via `spawnManagerTask`); the rest are
 * workers, ordered by updatedAt (most recent first).
 */
export function buildProjectView(input: {
  readonly projectId: string;
  readonly projectName: string;
  readonly manager?: TaskSnapshot;
  readonly managerHealth?: ContextHealthSnapshot;
  readonly workers: readonly TaskSnapshot[];
}): ProjectViewData {
  const manager = input.manager;
  const health = input.managerHealth;
  return {
    projectId: input.projectId,
    projectName: input.projectName,
    ...(manager !== undefined
      ? {
          manager: {
            taskId: manager.id,
            objective: manager.objective,
            state: manager.state,
            ...(health !== undefined
              ? {
                  health: {
                    status: health.status,
                    windowFillPct: health.windowFillPct,
                  },
                }
              : {}),
          },
        }
      : {}),
    workers: [...input.workers]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((t) => ({
        taskId: t.id,
        objective: t.objective,
        state: t.state,
        agentIds: t.agentIds,
      })),
    isEmpty: manager === undefined && input.workers.length === 0,
  };
}

function el(
  tag: string,
  props?: Record<string, unknown>,
  children?: readonly (RenderTree | string)[],
): RenderTree {
  return { tag, props, children };
}

/** Render the manager card — the user's interlocutor for this project. */
export function renderManagerCard(view: ManagerCardView): RenderTree {
  const healthMeta = view.health !== undefined ? HEALTH_METADATA[view.health.status] : undefined;
  return el('ManagerCard', { taskId: view.taskId, state: view.state }, [
    el('CardHeader', { layout: 'row', gap: 'sm' }, [
      el('Icon', { name: 'crown', color: 'blue' }, []),
      el('ManagerLabel', {}, ['Manager']),
      el('StateBadge', { state: view.state }, [view.state]),
      ...(healthMeta !== undefined && view.health !== undefined
        ? [
            el('HealthBadge', { color: healthMeta.color, icon: healthMeta.icon }, [
              `context ${(view.health.windowFillPct * 100).toFixed(0)}%`,
            ]),
          ]
        : []),
    ]),
    el('ManagerObjective', {}, [view.objective]),
    el('Action', {
      command: 'manager-message',
      args: { taskId: view.taskId },
      color: 'blue',
    }),
  ]);
}

/** Render one worker row (read-only — talk to the manager instead). */
export function renderWorkerRow(view: WorkerRowView): RenderTree {
  return el('WorkerRow', { taskId: view.taskId, state: view.state }, [
    el('WorkerObjective', {}, [view.objective]),
    el('WorkerAgents', { color: 'slate' }, [
      view.agentIds.length > 0 ? view.agentIds.join(', ') : 'unassigned',
    ]),
    el('StateBadge', { state: view.state }, [view.state]),
  ]);
}

/** Render the full project panel. */
export function renderProjectView(view: ProjectViewData): RenderTree {
  return el('ProjectView', { projectId: view.projectId, empty: view.isEmpty }, [
    el('ProjectHeader', {}, [view.projectName]),
    ...(view.manager !== undefined
      ? [renderManagerCard(view.manager)]
      : [el('EmptyHint', {}, ['no manager for this project yet'])]),
    el(
      'WorkerList',
      {},
      view.workers.length > 0
        ? view.workers.map(renderWorkerRow)
        : [el('EmptyHint', {}, ['no workers'])],
    ),
  ]);
}
