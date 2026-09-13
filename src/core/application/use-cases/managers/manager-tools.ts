/**
 * Manager tool service — the daemon-side operations behind the Florina's
 * MCP tool server (DEC-018, issue #63).
 *
 * A manager agent (itself a provider-run Task) decomposes objectives and
 * dispatches workers — but **only** through this service, never natively.
 * Every spawn is routed by the CapacityRouter (quota + preferences, DEC-029),
 * journaled through the typed command API, policy-checked, and visible in
 * the inbox.
 *
 * The service is transport-free and adapter-free: it depends only on core
 * ports and use cases, so it is unit-testable without a live protocol
 * session. The inbound MCP adapter
 * (`src/adapters/inbound/mcp/florina-mcp-server.ts`) is a thin JSON-RPC
 * wrapper over this service.
 */
import type { Task } from '../../../domain/types.js';
import type { EntityId } from '../../../domain/types.js';
import { TaskState } from '../../../domain/enums.js';
import type { TaskState as TaskStateType } from '../../../domain/enums.js';
import type { AttentionItemSnapshot, CommandExecutor, TaskSnapshot } from '../tasks/command-api.js';
import type { CapacityRouter } from '../routing/capacity-router.js';
import type { AttentionItemPriority } from '../attention/attention-item.js';
import type { McpServerSpec } from '../../ports/outbound/agent-runtime.js';
import {
  preferencePromptText,
  type PreferenceProfilePort,
} from '../../ports/outbound/preference-profile.js';

/**
 * The MCP registration name every provider's launch config uses for the
 * Florina's tool server (DEC-018, issue #63).
 */
export const FLORINA_MCP_SERVER_NAME = 'florina';

/**
 * Build the {@link McpServerSpec} a manager task's launch config carries:
 * the daemon's MCP HTTP endpoint plus the `x-florina-project` scoping
 * header so the server resolves this manager's project (DEC-003).
 */
export function florinaMcpSpec(mcpUrl: string, projectId: string): McpServerSpec {
  return {
    name: FLORINA_MCP_SERVER_NAME,
    url: mcpUrl,
    headers: { 'x-florina-project': projectId },
  };
}

/** Raised when a manager tool call is malformed or cannot be completed. */
export class ManagerToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManagerToolError';
  }
}

/**
 * Task persistence the service needs: create + update. The real
 * {@link TaskRepository} satisfies this; tests use an in-memory mock.
 */
export interface ManagerTaskStore {
  getById(taskId: string): Task | null;
  insert(task: Task): void;
  update(task: Task): void;
}

/**
 * The worktree lifecycle surface the service needs (DEC-024): every spawned
 * task gets its own worktree. Satisfied by the bootstrap-composed worktree
 * manager; the port is structural so the service never imports an adapter.
 */
export interface ManagerWorktreePort {
  createWorktree(repoPath: string, slug: string, taskId: string): string;
}

/** Dependencies injected into {@link ManagerToolService}. */
export interface ManagerToolDeps {
  /** The daemon's typed command API — all state transitions flow through it. */
  readonly commandApi: CommandExecutor;
  /** Quota- and preference-aware provider selection (DEC-029). */
  readonly router: CapacityRouter;
  /** Task persistence for newly spawned worker tasks. */
  readonly taskStore: ManagerTaskStore;
  /** Worktree lifecycle — every spawned task gets its own worktree (DEC-024). */
  readonly worktreeManager: ManagerWorktreePort;
  /** Repository root the spawned worktrees branch from. */
  readonly repoPath: string;
  /** Project this manager owns; spawned tasks attach to it (DEC-004). */
  readonly projectId: string;
  /**
   * The daemon's MCP HTTP URL (e.g. `http://127.0.0.1:PORT/mcp`). Required
   * for {@link ManagerToolService.spawnManagerTask} — a manager's launch
   * config registers this server so the agent can call its tools.
   */
  readonly mcpUrl?: string;
  /**
   * Durable preference profile (issue #65). When wired, manager spawns
   * get the need-to-know routing-preference block in their session
   * prompt — global rules plus this project's own (DEC-003).
   */
  readonly preferences?: PreferenceProfilePort;
  readonly now?: () => Date;
  readonly generateId?: (prefix: string) => EntityId;
}

/** Input to {@link ManagerToolService.spawnTask} (`florina_spawn_task`). */
export interface SpawnTaskInput {
  /** What the worker should accomplish. */
  readonly objective: string;
  /** Optional work-type tag for work-type-specific routing rules. */
  readonly workType?: string;
  /** Manager's preferred provider — honored when eligible (quota, denies). */
  readonly preferProvider?: string;
  /** Model pin to use with the preferred provider. */
  readonly preferModel?: string;
  /** Providers to exclude (e.g. already tried on a retried task). */
  readonly excludeProviders?: readonly string[];
}

/** Result of {@link ManagerToolService.spawnTask}. */
export type SpawnTaskResult =
  | {
      readonly status: 'spawned';
      readonly taskId: string;
      readonly sessionId: string;
      readonly provider: string;
      readonly model?: string;
      /** Routing explanation — surfaced to the manager for auditability. */
      readonly reason: string;
    }
  | {
      readonly status: 'parked';
      /** Earliest known quota reset, or null when unknown. */
      readonly resumeAt: string | null;
      readonly reason: string;
    }
  | { readonly status: 'error'; readonly error: string };

export class ManagerToolService {
  private readonly deps: ManagerToolDeps;

  constructor(deps: ManagerToolDeps) {
    this.deps = deps;
  }

  /**
   * `florina_spawn_task` — route, create, and start a worker task.
   *
   * Order: route first (a parked decision creates no task and no worktree),
   * then persist the Task, then the worktree, then `start-task`. If the
   * start fails the task stays `Created` with its worktree retained for a
   * later retry (DEC-024 prune policy).
   */
  async spawnTask(input: SpawnTaskInput): Promise<SpawnTaskResult> {
    return this.spawnTaskWithConfig(input, { workType: input.workType });
  }

  /**
   * Spawn a **manager** task (issue #63): same route→create→worktree→start
   * path as {@link spawnTask}, but the launch config registers the
   * Florina's MCP server (via {@link florinaMcpSpec}) so the provider
   * agent discovers `florina_spawn_task` et al. The manager itself is
   * provider-run and quota-tracked — it gets no privileged channel.
   */
  async spawnManagerTask(input: SpawnTaskInput): Promise<SpawnTaskResult> {
    if (this.deps.mcpUrl === undefined) {
      return { status: 'error', error: 'MCP server is not listening' };
    }
    return this.spawnTaskWithConfig(input, {
      workType: input.workType ?? 'manage',
      mcpServers: [florinaMcpSpec(this.deps.mcpUrl, this.deps.projectId)],
      prompt: this.managerPrompt(input.objective),
    });
  }

  /**
   * The manager's session prompt: the objective plus the need-to-know
   * routing-preference block (issue #65 soft layer). The stored task
   * objective stays clean — the block rides the `prompt` override
   * channel.
   */
  private managerPrompt(objective: string): string {
    if (this.deps.preferences === undefined) return objective;
    const prefs = preferencePromptText(this.deps.preferences.toProfile(), this.deps.projectId);
    return prefs === null ? objective : `${objective}\n\n${prefs}`;
  }

  /**
   * Shared spawn path for worker and manager tasks; manager spawns add the
   * MCP registration to the session launch config.
   */
  private async spawnTaskWithConfig(
    input: SpawnTaskInput,
    launch: {
      workType?: string;
      mcpServers?: readonly McpServerSpec[];
      prompt?: string;
    },
  ): Promise<SpawnTaskResult> {
    if (!input.objective || input.objective.trim().length === 0) {
      return { status: 'error', error: 'objective is required' };
    }
    const decision = this.deps.router.route({
      workType: launch.workType,
      excludeProviders: input.excludeProviders,
      preferProvider: input.preferProvider,
      preferModel: input.preferModel,
    });
    if (decision.kind === 'parked') {
      return { status: 'parked', resumeAt: decision.resumeAt, reason: decision.reason };
    }

    const now = (this.deps.now?.() ?? new Date()).toISOString();
    const genId = this.deps.generateId ?? defaultGenerateId;
    const taskId = genId('task');
    const task: Task = {
      id: taskId,
      projectId: this.deps.projectId,
      objective: input.objective,
      state: TaskState.Created,
      agentIds: [],
      sessionIds: [],
      deliverableIds: [],
      attentionItemIds: [],
      capsuleId: genId('capsule'),
      createdAt: now,
      updatedAt: now,
    };
    this.deps.taskStore.insert(task);

    let worktreePath: string;
    try {
      worktreePath = this.deps.worktreeManager.createWorktree(
        this.deps.repoPath,
        taskSlug(input.objective, taskId),
        taskId,
      );
    } catch (err) {
      // The task row stays Created — a failed worktree (missing repo,
      // permission denied) leaves a retrievable record, not a crash.
      return {
        status: 'error',
        error: `worktree creation failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    this.deps.taskStore.update({ ...task, worktreePath });

    const res = await this.deps.commandApi.execute({
      kind: 'start-task',
      taskId,
      agentId: decision.provider,
      sessionConfig: {
        workingDir: worktreePath,
        model: decision.model,
        ...(launch.mcpServers !== undefined ? { mcpServers: launch.mcpServers } : {}),
        ...(launch.prompt !== undefined ? { prompt: launch.prompt } : {}),
      },
    });
    if (!res.ok || !('sessionId' in res) || typeof res.sessionId !== 'string') {
      return {
        status: 'error',
        error: `task ${taskId} created but failed to start: ${
          'error' in res ? res.error : 'unexpected response'
        }`,
      };
    }
    return {
      status: 'spawned',
      taskId,
      sessionId: res.sessionId,
      provider: decision.provider,
      model: decision.model,
      reason: decision.reason,
    };
  }

  /** `florina_stop_task` — cancel a running worker task. */
  async stopTask(input: {
    taskId: string;
    reason?: string;
  }): Promise<{ ok: boolean; error?: string }> {
    const res = await this.deps.commandApi.execute({
      kind: 'stop-task',
      taskId: input.taskId,
      reason: input.reason,
    });
    return res.ok ? { ok: true } : { ok: false, error: 'error' in res ? res.error : 'failed' };
  }

  /** `florina_get_task_status` — a single task snapshot. */
  async getTaskStatus(input: { taskId: string }): Promise<TaskSnapshot | null> {
    const res = await this.deps.commandApi.execute({ kind: 'query-task', taskId: input.taskId });
    return res.ok && 'task' in res ? res.task : null;
  }

  /** `florina_list_tasks` — all task snapshots, optionally state-filtered. */
  async listTasks(input?: { status?: TaskStateType }): Promise<readonly TaskSnapshot[]> {
    const res = await this.deps.commandApi.execute({
      kind: 'list-tasks',
      status: input?.status,
    });
    return res.ok && 'tasks' in res ? res.tasks : [];
  }

  /** `florina_get_inbox` — the manager sees open attention items. */
  async getInbox(): Promise<readonly AttentionItemSnapshot[]> {
    const res = await this.deps.commandApi.execute({ kind: 'query-inbox' });
    return res.ok && 'items' in res ? res.items : [];
  }

  /**
   * `florina_request_human_input` — escalate a consequential question to
   * the human through the attention inbox (DEC-014: the manager never
   * decides what the human must answer — it asks).
   */
  async requestHumanInput(input: {
    taskId: string;
    question: string;
    details?: string;
    priority?: AttentionItemPriority;
  }): Promise<{ ok: boolean; itemId?: string; error?: string }> {
    const res = await this.deps.commandApi.execute({
      kind: 'raise-attention',
      taskId: input.taskId,
      summary: input.question,
      details: input.details,
      priority: input.priority,
      source: 'manager',
    });
    return res.ok && 'itemId' in res
      ? { ok: true, itemId: res.itemId }
      : { ok: false, error: 'error' in res ? res.error : 'failed' };
  }
}

function defaultGenerateId(prefix: string): EntityId {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

/** Derive a worktree slug from the objective + id (sanitized by the manager). */
function taskSlug(objective: string, taskId: string): string {
  const words = objective
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 6)
    .join('-');
  return `${words || 'task'}-${taskId.slice(-6)}`;
}
