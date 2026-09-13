/**
 * Typed control-plane API for the Secretary daemon (DEC-008).
 *
 * Every surface (CLI, desktop, voice, remote) talks to the daemon over a
 * single localhost WebSocket. Messages are JSON envelopes of the shape:
 *
 * ```json
 * { "id": "<correlation-id>", "method": "<api-method>", "params": { ... } }
 * ```
 *
 * Responses are:
 *
 * ```json
 * { "id": "<correlation-id>", "result": { ... } }
 * // or
 * { "id": "<correlation-id>", "error": { "code": "...", "message": "..." } }
 * ```
 *
 * This module defines the typed request/response schemas for every API
 * method, a {@link ControlPlaneApi} class that wires methods to the
 * persistence repository ports, and a {@link dispatch} helper that routes
 * an incoming envelope to the correct method.
 *
 * The full implementation of several methods depends on later issues
 * (adapters, attention engine). For now the API surface and routing work
 * end-to-end and methods return empty/default data where the backing
 * subsystem is not yet built.
 */
import type {
  ApprovalRepositoryPort,
  AttentionRecordRepositoryPort,
  ContextCapsuleRepositoryPort,
  DecisionRepositoryPort,
  DeliverableRepositoryPort,
  EventJournalPort,
  ProjectRepositoryPort,
  SessionRepositoryPort,
  TaskRepositoryPort,
} from '../../ports/outbound/repositories.js';
import type { EventPublisherPort } from '../../ports/outbound/event-stream.js';
import type { AttentionItem, Approval, Deliverable, Project, Task } from '../../../domain/types.js';
import { TaskState } from '../../../domain/enums.js';
import { buildTask } from '../../../domain/factories.js';

/* ------------------------------------------------------------------ *
 * Wire envelope types
 * ------------------------------------------------------------------ */

/** The set of control-plane API method names. */
export type ApiMethod =
  | 'start_task'
  | 'get_inbox'
  | 'get_status'
  | 'show_task'
  | 'approve_permission'
  | 'deny_permission'
  | 'stop_task'
  | 'get_digest'
  | 'switch_project';

/** Incoming request envelope. */
export interface ApiRequest<P = unknown> {
  readonly id: string;
  readonly method: ApiMethod;
  readonly params?: P;
}

/** Successful response envelope. */
export interface ApiSuccessResponse<R> {
  readonly id: string;
  readonly result: R;
}

/** Error response envelope. */
export interface ApiErrorResponse {
  readonly id: string;
  readonly error: ApiError;
}

/** Error detail. */
export interface ApiError {
  readonly code: string;
  readonly message: string;
}

export type ApiResponse<R> = ApiSuccessResponse<R> | ApiErrorResponse;

/* ------------------------------------------------------------------ *
 * Method request / response schemas
 * ------------------------------------------------------------------ */

/** start_task: delegate a new objective to an agent. */
export interface StartTaskParams {
  readonly projectId: string;
  readonly objective: string;
  readonly agentId?: string;
  readonly worktreePath?: string;
}
export interface StartTaskResult {
  readonly task: Task;
}
export type StartTaskRequest = ApiRequest<StartTaskParams>;
export type StartTaskResponse = ApiResponse<StartTaskResult>;

/** get_inbox: list open attention items needing human action. */
export interface GetInboxParams {
  readonly projectId?: string;
  readonly includeResolved?: boolean;
}
export interface GetInboxResult {
  readonly items: AttentionItem[];
}
export type GetInboxRequest = ApiRequest<GetInboxParams>;
export type GetInboxResponse = ApiResponse<GetInboxResult>;

/** get_status: high-level daemon + project status snapshot. */
export interface GetStatusParams {
  readonly projectId?: string;
}
export interface GetStatusResult {
  readonly activeProjects: Project[];
  readonly activeTaskCount: number;
  readonly openAttentionCount: number;
  readonly currentProjectId: string | null;
}
export type GetStatusRequest = ApiRequest<GetStatusParams>;
export type GetStatusResponse = ApiResponse<GetStatusResult>;

/** show_task: full detail for a single task. */
export interface ShowTaskParams {
  readonly taskId: string;
}
export interface ShowTaskResult {
  readonly task: Task;
  readonly deliverables: Deliverable[];
  readonly openApprovals: Approval[];
  readonly openAttentionItems: AttentionItem[];
}
export type ShowTaskRequest = ApiRequest<ShowTaskParams>;
export type ShowTaskResponse = ApiResponse<ShowTaskResult>;

/** approve_permission: grant a pending approval. */
export interface ApprovePermissionParams {
  readonly approvalId: string;
  readonly scope?: Approval['scope'];
}
export interface ApprovePermissionResult {
  readonly approval: Approval;
  readonly granted: boolean;
}
export type ApprovePermissionRequest = ApiRequest<ApprovePermissionParams>;
export type ApprovePermissionResponse = ApiResponse<ApprovePermissionResult>;

/** deny_permission: deny a pending approval. */
export interface DenyPermissionParams {
  readonly approvalId: string;
  readonly reason?: string;
}
export interface DenyPermissionResult {
  readonly approval: Approval;
  readonly granted: boolean;
}
export type DenyPermissionRequest = ApiRequest<DenyPermissionParams>;
export type DenyPermissionResponse = ApiResponse<DenyPermissionResult>;

/** stop_task: stop a running task. */
export interface StopTaskParams {
  readonly taskId: string;
  readonly reason?: string;
}
export interface StopTaskResult {
  readonly task: Task;
  readonly stopped: boolean;
}
export type StopTaskRequest = ApiRequest<StopTaskParams>;
export type StopTaskResponse = ApiResponse<StopTaskResult>;

/** get_digest: rolling digest of recent activity. */
export interface GetDigestParams {
  readonly projectId?: string;
  readonly limit?: number;
}
export interface GetDigestResult {
  readonly recentEvents: {
    readonly id: string;
    readonly taskId: string;
    readonly kind: string;
    readonly timestamp: string;
  }[];
  readonly openAttentionCount: number;
  readonly activeTaskCount: number;
}
export type GetDigestRequest = ApiRequest<GetDigestParams>;
export type GetDigestResponse = ApiResponse<GetDigestResult>;

/** switch_project: change the active project context. */
export interface SwitchProjectParams {
  readonly projectId: string;
}
export interface SwitchProjectResult {
  readonly projectId: string;
  readonly switched: boolean;
}
export type SwitchProjectRequest = ApiRequest<SwitchProjectParams>;
export type SwitchProjectResponse = ApiResponse<SwitchProjectResult>;

/* ------------------------------------------------------------------ *
 * API handler
 * ------------------------------------------------------------------ */

/**
 * Bundles the repository ports the control-plane API needs. Constructed once
 * by the composition root from a single open persistence connection.
 */
export interface ApiRepositories {
  readonly projects: ProjectRepositoryPort;
  readonly tasks: TaskRepositoryPort;
  readonly events: EventJournalPort;
  readonly attention: AttentionRecordRepositoryPort;
  readonly approvals: ApprovalRepositoryPort;
  readonly deliverables: DeliverableRepositoryPort;
  readonly sessions: SessionRepositoryPort;
  readonly decisions: DecisionRepositoryPort;
  readonly capsules: ContextCapsuleRepositoryPort;
}

/**
 * The typed control-plane API. Each method maps a validated request to a
 * typed response, wiring through the persistence ports. Methods that depend
 * on later issues (adapters, attention engine) return sensible default data
 * so the routing and surface work end-to-end today.
 */
export class ControlPlaneApi {
  private readonly repos: ApiRepositories;
  private readonly bus: EventPublisherPort;
  private currentProjectId: string | null = null;

  constructor(repos: ApiRepositories, bus: EventPublisherPort) {
    this.repos = repos;
    this.bus = bus;
  }

  /** The currently active project id (set by switch_project). */
  get activeProjectId(): string | null {
    return this.currentProjectId;
  }

  async startTask(params: StartTaskParams): Promise<StartTaskResult> {
    const task = buildTask({
      projectId: params.projectId,
      objective: params.objective,
      worktreePath: params.worktreePath,
    });
    this.repos.tasks.insert(task);
    // Full delegation to an adapter happens in a later issue; for now we
    // record the task and leave it in the `created` state.
    return { task };
  }

  async getInbox(params: GetInboxParams): Promise<GetInboxResult> {
    const resolved = params.includeResolved ?? false;
    const items = this.repos.attention.listByResolved(resolved);
    const filtered = params.projectId
      ? items.filter((i) => {
          const task = this.repos.tasks.getById(i.taskId);
          return task?.projectId === params.projectId;
        })
      : items;
    return { items: filtered };
  }

  async getStatus(_params: GetStatusParams): Promise<GetStatusResult> {
    const activeProjects = this.repos.projects.listAll();
    const allTasks = activeProjects.flatMap((p) => this.repos.tasks.listByProject(p.id));
    const activeTaskCount = allTasks.filter(
      (t) => t.state === TaskState.Running || t.state === TaskState.Delegated,
    ).length;
    const openAttention = this.repos.attention.listByResolved(false);
    return {
      activeProjects,
      activeTaskCount,
      openAttentionCount: openAttention.length,
      currentProjectId: this.currentProjectId,
    };
  }

  async showTask(params: ShowTaskParams): Promise<ShowTaskResult> {
    const task = this.repos.tasks.getById(params.taskId);
    if (!task) {
      throw new ApiError_('not_found', `Task ${params.taskId} not found`);
    }
    const deliverables = task.deliverableIds
      .map((id) => this.repos.deliverables.getById(id))
      .filter((d): d is Deliverable => d !== null);
    const openApprovals = this.repos.approvals.listByTask(params.taskId).filter((a) => !a.granted);
    const openAttentionItems = this.repos.attention
      .listByTask(params.taskId)
      .filter((i) => !i.resolved);
    return { task, deliverables, openApprovals, openAttentionItems };
  }

  async approvePermission(params: ApprovePermissionParams): Promise<ApprovePermissionResult> {
    const approval = this.repos.approvals.getById(params.approvalId);
    if (!approval) {
      throw new ApiError_('not_found', `Approval ${params.approvalId} not found`);
    }
    const granted: Approval = {
      ...approval,
      scope: params.scope ?? approval.scope,
      granted: true,
      grantedAt: new Date().toISOString(),
    };
    this.repos.approvals.update(granted);
    return { approval: granted, granted: true };
  }

  async denyPermission(params: DenyPermissionParams): Promise<DenyPermissionResult> {
    const approval = this.repos.approvals.getById(params.approvalId);
    if (!approval) {
      throw new ApiError_('not_found', `Approval ${params.approvalId} not found`);
    }
    // Denial is recorded as an approval row with granted=false and a grantedAt
    // timestamp so the decision is journaled (DEC-012). The optional reason is
    // captured in the attention engine in a later issue.
    void params.reason;
    const denied: Approval = {
      ...approval,
      granted: false,
      grantedAt: new Date().toISOString(),
    };
    this.repos.approvals.update(denied);
    return { approval: denied, granted: false };
  }

  async stopTask(params: StopTaskParams): Promise<StopTaskResult> {
    const task = this.repos.tasks.getById(params.taskId);
    if (!task) {
      throw new ApiError_('not_found', `Task ${params.taskId} not found`);
    }
    // The actual adapter stop signal is wired in a later issue; for now we
    // transition the task to `cancelled`.
    void params.reason;
    const stopped: Task = {
      ...task,
      state: TaskState.Cancelled,
      updatedAt: new Date().toISOString(),
    };
    this.repos.tasks.update(stopped);
    return { task: stopped, stopped: true };
  }

  async getDigest(params: GetDigestParams): Promise<GetDigestResult> {
    const limit = Math.max(1, params.limit ?? 20);
    const projects = params.projectId
      ? [this.repos.projects.getById(params.projectId)].filter((p): p is Project => p !== null)
      : this.repos.projects.listAll();
    const tasks = projects.flatMap((p) => this.repos.tasks.listByProject(p.id));
    const events = tasks
      .flatMap((t) => this.repos.events.listByTask(t.id))
      .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
      .slice(0, limit);
    return {
      recentEvents: events.map((e) => ({
        id: e.id,
        taskId: e.taskId,
        kind: e.kind,
        timestamp: e.timestamp,
      })),
      openAttentionCount: this.repos.attention.listByResolved(false).length,
      activeTaskCount: tasks.filter(
        (t) => t.state === TaskState.Running || t.state === TaskState.Delegated,
      ).length,
    };
  }

  async switchProject(params: SwitchProjectParams): Promise<SwitchProjectResult> {
    const project = this.repos.projects.getById(params.projectId);
    if (!project) {
      throw new ApiError_('not_found', `Project ${params.projectId} not found`);
    }
    this.currentProjectId = params.projectId;
    return { projectId: params.projectId, switched: true };
  }

  /** Exposed so the composition root can publish adapter events onto the bus. */
  get eventBus(): EventPublisherPort {
    return this.bus;
  }
}

/**
 * Local Error subclass so dispatch can distinguish API-level errors from
 * unexpected throws. Named with a trailing underscore to avoid clashing with
 * the `ApiError` interface above.
 */
class ApiError_ extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/* ------------------------------------------------------------------ *
 * Dispatch
 * ------------------------------------------------------------------ */

/**
 * Route a parsed {@link ApiRequest} to the matching method on the
 * {@link ControlPlaneApi} and return a typed response envelope.
 */
export async function dispatch(
  api: ControlPlaneApi,
  request: ApiRequest,
): Promise<ApiResponse<unknown>> {
  try {
    let result: unknown;
    switch (request.method) {
      case 'start_task':
        result = await api.startTask((request.params ?? {}) as StartTaskParams);
        break;
      case 'get_inbox':
        result = await api.getInbox((request.params ?? {}) as GetInboxParams);
        break;
      case 'get_status':
        result = await api.getStatus((request.params ?? {}) as GetStatusParams);
        break;
      case 'show_task':
        result = await api.showTask((request.params ?? {}) as ShowTaskParams);
        break;
      case 'approve_permission':
        result = await api.approvePermission((request.params ?? {}) as ApprovePermissionParams);
        break;
      case 'deny_permission':
        result = await api.denyPermission((request.params ?? {}) as DenyPermissionParams);
        break;
      case 'stop_task':
        result = await api.stopTask((request.params ?? {}) as StopTaskParams);
        break;
      case 'get_digest':
        result = await api.getDigest((request.params ?? {}) as GetDigestParams);
        break;
      case 'switch_project':
        result = await api.switchProject((request.params ?? {}) as SwitchProjectParams);
        break;
      default: {
        // Exhaustiveness guard: if a new method is added to ApiMethod without
        // a case here, TypeScript flags it.
        const _exhaustive: never = request.method;
        throw new ApiError_('method_not_found', `Unknown method: ${String(_exhaustive)}`);
      }
    }
    return { id: request.id, result };
  } catch (err) {
    if (err instanceof ApiError_) {
      return { id: request.id, error: { code: err.code, message: err.message } };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { id: request.id, error: { code: 'internal_error', message } };
  }
}

/**
 * Parse and lightly validate an incoming payload into an {@link ApiRequest}.
 * Accepts either a JSON string or an already-parsed value — raw byte
 * decoding belongs to the inbound transport. Returns `null` if the payload
 * is not a valid request envelope.
 */
export function parseApiRequest(data: unknown): ApiRequest | null {
  let parsed: unknown;
  if (typeof data === 'string') {
    try {
      parsed = JSON.parse(data) as unknown;
    } catch {
      return null;
    }
  } else {
    parsed = data;
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    typeof (parsed as { id?: unknown }).id !== 'string' ||
    typeof (parsed as { method?: unknown }).method !== 'string'
  ) {
    return null;
  }
  const req = parsed as ApiRequest;
  return req;
}
