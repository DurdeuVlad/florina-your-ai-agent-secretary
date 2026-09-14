/**
 * Typed command API for the Florina daemon (issue #19, DEC-002, DEC-026).
 *
 * Voice and CLI share the same typed command API â€” voice is never a parallel
 * orchestration system (PRODUCT_DESIGN.md "Voice Experience"). Every surface
 * (CLI, desktop, voice, remote) calls the same {@link CommandApi.execute}
 * method with a typed {@link Command} and receives a typed {@link Response}.
 *
 * Design rules enforced by this module:
 * - The `Command` union is a discriminated union on the `kind` field so the
 *   compiler exhaustiveness-checks every handler.
 * - Each command variant has a matching {@link Response} variant. Responses
 *   carry an `ok` flag and, on failure, a human-readable `error` string.
 * - {@link CommandApi.execute} dispatches to a private handler per `kind`.
 *   Unknown commands (only possible at runtime) return an error response.
 * - Each handler validates input before performing the action. Invalid input
 *   returns `ok: false` rather than throwing.
 * - Authorization is enforced identically regardless of which surface issued
 *   the command (DEC-002, DEC-011).
 */
import type { AdapterFidelityTier } from '../../../domain/enums.js';
import { TaskState } from '../../../domain/enums.js';
import type { TaskState as TaskStateType } from '../../../domain/enums.js';
import type { Approval, Event, Session, Task } from '../../../domain/types.js';
import type {
  AgentStartedEvent,
  AgentStoppedEvent,
  SupervisorEvent,
} from '../../../domain/events.js';
import type {
  AttentionItem,
  AttentionItemKind,
  AttentionItemPriority,
} from '../attention/attention-item.js';
import {
  createAttentionItem,
  ATTENTION_ITEM_KINDS,
  PRIORITY_ORDER,
} from '../attention/attention-item.js';
import type { AttentionInbox, AttentionInboxFilter } from '../attention/attention-inbox.js';
import type { CompletionDigest } from '../attention/completion-digest.js';
import type { EventPublisherPort } from '../../ports/outbound/event-stream.js';
import type {
  AgentRuntimePort,
  McpServerSpec,
  SessionConfig as AdapterSessionConfig,
} from '../../ports/outbound/agent-runtime.js';
import type { AgentRuntimeRegistryPort } from '../../ports/outbound/runtime-registry.js';
import type { DelegationService } from '../federation/delegation.js';
import type {
  ApprovalRepositoryPort,
  CompletionDigestRepositoryPort,
  EventJournalPort,
  SessionRepositoryPort,
  TaskRepositoryPort,
} from '../../ports/outbound/repositories.js';
import { DirtyWorktreeError, type WorktreePort } from '../../ports/outbound/worktree.js';
import {
  preferencePromptText,
  type PreferenceProfile,
  type PreferenceProfilePort,
} from '../../ports/outbound/preference-profile.js';
import type { TaskStateMachine, TransitionContext } from './task-lifecycle.js';
import type { MetricsCollector, MetricsSnapshot } from '../metrics.js';
import type { ContextHealthSnapshot } from '../context/context-health-monitor.js';
import type {
  Brief,
  BriefDispatchResult,
  DelegationPlan,
  IdeaLedger,
} from '../../../domain/ideas.js';
import type { IdeaService } from '../ideas/idea-service.js';
import type {
  AttentionMetricsReport,
  MetricsQueryOptions,
  MetricsQueryService,
} from '../attention/attention-metrics.js';
import type { SessionManager } from './session-manager.js';

/* ================================================================== *
 * Shared types
 * ================================================================== */

/**
 * Configuration for starting a task session (part of the `start-task`
 * command). Carries the information needed to spawn an agent session in the
 * task's worktree.
 */
export interface SessionConfig {
  /** Working directory (worktree path) the agent runs in. */
  readonly workingDir: string;
  /** Model identifier the agent should use, if known. */
  readonly model?: string;
  /** Autonomy / approval policy in effect, if known. */
  readonly autonomyLevel?: string;
  /** Adapter fidelity tier of the agent (defaults to `B`). */
  readonly adapterFidelityTier?: AdapterFidelityTier;
  /**
   * Prompt override for the adapter session. When omitted, the task's
   * `objective` is sent. Failover uses this to prime a new provider with a
   * Task-Capsule briefing without mutating the task's recorded objective
   * (issue #64).
   */
  readonly prompt?: string;
  /**
   * MCP servers the session registers at launch (DEC-018, issue #63) —
   * manager-role tasks carry the Florina's own tool server so the
   * manager agent can call `florina_spawn_task` et al.
   */
  readonly mcpServers?: readonly McpServerSpec[];
}

/**
 * Filter criteria for the `query-inbox` command. Re-uses the inbox's own
 * filter type so the command API and inbox stay in sync.
 */
export type InboxFilter = AttentionInboxFilter;

/**
 * Serializable snapshot of an {@link AttentionItem} returned by inbox
 * queries. All fields are readonly and use primitive/string types so the
 * snapshot is trivially JSON-serializable for any client surface.
 */
export interface AttentionItemSnapshot {
  readonly id: string;
  readonly taskId: string;
  readonly kind: string;
  readonly priority: string;
  readonly status: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * Serializable snapshot of a {@link Task} returned by task queries.
 * Includes an `eventCount` derived from the event journal so clients can
 * show activity without loading the full event stream.
 */
export interface TaskSnapshot {
  readonly id: string;
  readonly projectId: string;
  readonly objective: string;
  readonly state: string;
  readonly agentIds: readonly string[];
  readonly sessionIds: readonly string[];
  readonly worktreePath?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Number of events recorded in the journal for this task. */
  readonly eventCount: number;
}

/* ================================================================== *
 * Command union (discriminated by `kind`)
 * ================================================================== */

/** Start (delegate) a task to an agent, creating a new session. */
export interface StartTaskCommand {
  readonly kind: 'start-task';
  readonly taskId: string;
  readonly agentId: string;
  readonly sessionConfig: SessionConfig;
}

/** Stop (cancel) a running task. */
export interface StopTaskCommand {
  readonly kind: 'stop-task';
  readonly taskId: string;
  readonly reason?: string;
}

/** Grant or deny a pending approval. */
export interface ApproveCommand {
  readonly kind: 'approve';
  readonly taskId: string;
  readonly approvalId: string;
  readonly decision: 'grant' | 'deny';
  readonly note?: string;
}

/** Query the attention inbox, optionally filtered. */
export interface QueryInboxCommand {
  readonly kind: 'query-inbox';
  readonly filter?: InboxFilter;
}

/**
 * Raise a new attention item — how managers and daemon subsystems ask the
 * human a question (DEC-006/014, issue #63). The item lands in the inbox as
 * `Pending`; the deterministic attention engine owns escalation from there.
 */
export interface RaiseAttentionCommand {
  readonly kind: 'raise-attention';
  readonly taskId: string;
  /** What the human needs to decide or answer. */
  readonly summary: string;
  /** Optional longer context for the item payload. */
  readonly details?: string;
  /** Item kind (defaults to `Custom`). */
  readonly itemKind?: AttentionItemKind;
  /** Initial priority (defaults to `Medium`). */
  readonly priority?: AttentionItemPriority;
  /** Who raised it — recorded in the payload for audit (e.g. `manager`). */
  readonly source?: string;
}

/** Acknowledge an attention item (mark as seen). */
export interface AcknowledgeItemCommand {
  readonly kind: 'ack-item';
  readonly itemId: string;
}

/** Resolve an attention item (mark as handled). */
export interface ResolveItemCommand {
  readonly kind: 'resolve-item';
  readonly itemId: string;
}

/** Escalate an attention item (boost to Critical priority). */
export interface EscalateItemCommand {
  readonly kind: 'escalate-item';
  readonly itemId: string;
}

/** Query the current metrics snapshot. */
export interface QueryMetricsCommand {
  readonly kind: 'query-metrics';
  /** Epoch-milliseconds lower bound (reserved for future time-filtering). */
  readonly since?: number;
  /** Epoch-milliseconds upper bound (inclusive). */
  readonly until?: number;
  /** Restrict the attention-metrics report to a project. */
  readonly projectId?: string;
  /** Restrict the attention-metrics report to a single task. */
  readonly taskId?: string;
}

/** Query a single task by id. */
export interface QueryTaskCommand {
  readonly kind: 'query-task';
  readonly taskId: string;
}

/**
 * Query the journaled {@link Event}s for a task (session inspector,
 * issue #126). Read-only — the event journal is the source of truth
 * (DEC-012), including `ContextCondensed` rows that carry
 * `forgottenEventIds` so condensation never hides history.
 */
export interface QueryEventsCommand {
  readonly kind: 'query-events';
  readonly taskId: string;
}

/** List tasks, optionally filtered by status. */
export interface ListTasksCommand {
  readonly kind: 'list-tasks';
  readonly status?: TaskStateType;
}

/** Prune a task's git worktree (only if clean). */
export interface PruneWorktreeCommand {
  readonly kind: 'prune-worktree';
  readonly taskId: string;
}

/** Signal the daemon to shut down. */
export interface ShutdownCommand {
  readonly kind: 'shutdown';
}

/**
 * Query per-agent context health (DEC-035, issue #77).
 *
 * When `agentId` is present the response contains at most that agent's
 * snapshot; otherwise every tracked agent is returned. Powers
 * `florina status` and the desktop fleet view.
 */
export interface QueryContextHealthCommand {
  readonly kind: 'context-health';
  readonly agentId?: string;
}

/* ------------------------------------------------------------------ *
 * Idea ledger + Brief commands (DEC-033, issue #69)
 * ------------------------------------------------------------------ */

/** Open a new idea ledger in the global ideas directory. */
export interface CreateIdeaCommand {
  readonly kind: 'idea-create';
  readonly title: string;
  readonly body?: string;
}

/** List all idea ledgers the daemon can see. */
export interface ListIdeasCommand {
  readonly kind: 'idea-list';
}

/**
 * Append a titled section to a ledger — research notes, open questions,
 * decisions in progress.
 */
export interface AppendIdeaCommand {
  readonly kind: 'idea-append';
  readonly ideaId: string;
  readonly heading: string;
  readonly body: string;
}

/**
 * Promote a ledger into a project — the file moves into `targetDir`
 * (DEC-033: ideas precede project selection; promotion moves them in).
 */
export interface PromoteIdeaCommand {
  readonly kind: 'idea-promote';
  readonly ideaId: string;
  readonly projectId: string;
  readonly targetDir: string;
}

/**
 * Compile a ledger into a reviewable Brief. The caller supplies the
 * delegation plan (project + task breakdown with provider/model intent).
 */
export interface CompileBriefCommand {
  readonly kind: 'brief-compile';
  readonly ideaId: string;
  readonly plan: DelegationPlan;
}

/**
 * Confirm a Brief — the hard delegation gate. The confirmation is
 * journaled (DEC-012) and the plan dispatches through the normal spawn
 * path (DEC-018).
 */
export interface ConfirmBriefCommand {
  readonly kind: 'brief-confirm';
  readonly briefId: string;
  /** Who confirmed — recorded on the journaled gate decision. */
  readonly confirmedBy?: string;
}

/**
 * Mutate the durable provider/model preference profile (DEC-029, issue
 * #73). The voice `remember_preference` tool lands here — a prompt
 * preference is never prompt-engineered around, it becomes a persisted
 * routing fact the CapacityRouter enforces.
 */
export interface UpdatePreferenceCommand {
  readonly kind: 'update-preference';
  readonly action: 'add-rule' | 'deny' | 'remove-rule' | 'remove-deny';
  /** Provider id (e.g. claude-code, devin). Required for all actions. */
  readonly provider: string;
  /** Optional model pin the rule applies to. */
  readonly model?: string;
  /** Work-type tags a routing rule applies to (add-rule only). */
  readonly workTypes?: readonly string[];
  /**
   * Project scope for the rule/deny. Omitted = the global default
   * (DEC-003 need-to-know — project rules are shown only to that
   * project's manager). On remove, an explicit `projectId` targets only
   * that scoped entry; omitting it targets the global entry.
   */
  readonly projectId?: string;
  /**
   * The user's own words for this rule (soft layer — managers reason
   * over it; the daemon still enforces the structured fields).
   */
  readonly note?: string;
}

/**
 * Read the durable preference profile (issue #65). `projectId` narrows
 * the rendered prompt text to what that project's manager may see.
 */
export interface QueryPreferencesCommand {
  readonly kind: 'query-preferences';
  readonly projectId?: string;
}

/** Query the latest completion digest for a task (issue #37). */
export interface GetDigestCommand {
  readonly kind: 'get-digest';
  readonly taskId: string;
}

/**
 * Create a pull request for a task's branch (issue #27).
 *
 * Invoked by the side-by-side digest & diff viewer's "Create PR" action. The
 * daemon resolves the task's worktree/branch and initiates PR creation. The
 * `title` and `body` are optional; when omitted the head commit message is
 * used as the title.
 */
export interface CreatePrCommand {
  readonly kind: 'create-pr';
  readonly taskId: string;
  /** Optional PR title (defaults to the head commit subject). */
  readonly title?: string;
  /** Optional PR body/description. */
  readonly body?: string;
}

/**
 * Accept a remote delegation from a parent Florina (DEC-036, issue
 * #78). The payload is the Task-Capsule objective plus routing intent;
 * the child creates + starts the task through the same machinery as a
 * local spawn — the repo named by `projectId` must exist on this
 * machine.
 */
export interface DelegateTaskCommand {
  readonly kind: 'delegate-task';
  /** Child-side project the task attaches to. */
  readonly projectId: string;
  /** What the worker should accomplish. */
  readonly objective: string;
  readonly workType?: string;
  readonly preferProvider?: string;
  readonly preferModel?: string;
  readonly excludeProviders?: readonly string[];
}

/**
 * The canonical discriminated union of all commands (DEC-026).
 *
 * The `kind` field is the discriminant; {@link CommandApi.execute} switches
 * on it to dispatch to the correct handler.
 */
export type Command =
  | StartTaskCommand
  | StopTaskCommand
  | ApproveCommand
  | QueryInboxCommand
  | RaiseAttentionCommand
  | AcknowledgeItemCommand
  | ResolveItemCommand
  | EscalateItemCommand
  | QueryMetricsCommand
  | QueryTaskCommand
  | QueryEventsCommand
  | ListTasksCommand
  | PruneWorktreeCommand
  | ShutdownCommand
  | QueryContextHealthCommand
  | CreateIdeaCommand
  | ListIdeasCommand
  | AppendIdeaCommand
  | PromoteIdeaCommand
  | CompileBriefCommand
  | ConfirmBriefCommand
  | UpdatePreferenceCommand
  | QueryPreferencesCommand
  | GetDigestCommand
  | CreatePrCommand
  | DelegateTaskCommand;

/** Ordered list of all valid command `kind` discriminants. */
export const COMMAND_KINDS: readonly string[] = [
  'start-task',
  'stop-task',
  'approve',
  'query-inbox',
  'raise-attention',
  'ack-item',
  'resolve-item',
  'escalate-item',
  'query-metrics',
  'query-task',
  'query-events',
  'list-tasks',
  'prune-worktree',
  'shutdown',
  'context-health',
  'idea-create',
  'idea-list',
  'idea-append',
  'idea-promote',
  'brief-compile',
  'brief-confirm',
  'update-preference',
  'query-preferences',
  'get-digest',
  'create-pr',
  'delegate-task',
] as const;

/* ================================================================== *
 * Response union
 * ================================================================== */

export interface StartTaskResponse {
  readonly ok: boolean;
  readonly taskId: string;
  readonly sessionId: string;
  readonly error?: string;
}

export interface StopTaskResponse {
  readonly ok: boolean;
  readonly taskId: string;
  readonly error?: string;
}

export interface ApproveResponse {
  readonly ok: boolean;
  readonly approvalId: string;
  readonly error?: string;
}

export interface InboxResponse {
  readonly ok: boolean;
  readonly items: AttentionItemSnapshot[];
}

export interface ItemMutationResponse {
  readonly ok: boolean;
  readonly itemId: string;
  readonly error?: string;
}

/** Response to `raise-attention` — carries the created item id. */
export type RaiseAttentionResponse = ItemMutationResponse;

export interface MetricsResponse {
  readonly ok: boolean;
  readonly snapshot: MetricsSnapshot | null;
  /**
   * Attention Compression Ratio and supplemental metrics report (DEC-015,
   * issue #18). Present only when a `metricsQueryService` is wired into the
   * {@link CommandApiDeps}.
   */
  readonly attentionMetrics?: AttentionMetricsReport;
}

export interface TaskResponse {
  readonly ok: boolean;
  readonly task: TaskSnapshot | null;
}

export interface TaskListResponse {
  readonly ok: boolean;
  readonly tasks: TaskSnapshot[];
}

export interface PruneResponse {
  readonly ok: boolean;
  readonly taskId: string;
  readonly error?: string;
}

export interface ShutdownResponse {
  readonly ok: boolean;
}

/** Response to a `get-digest` command (issue #37). */
export interface DigestResponse {
  readonly ok: boolean;
  readonly digest: CompletionDigest | null;
  readonly error?: string;
}

/**
 * Response to a `create-pr` command (issue #27).
 *
 * On success, `branch` is the branch the PR targets and `headCommit` is the
 * head SHA. `prUrl` is populated when the hosting provider returns a URL.
 */
export interface CreatePrResponse {
  readonly ok: boolean;
  readonly taskId: string;
  readonly branch?: string;
  readonly headCommit?: string;
  readonly prUrl?: string;
  readonly error?: string;
}

/** Response to `context-health` — per-agent health snapshots (issue #77). */
export interface ContextHealthResponse {
  readonly ok: boolean;
  readonly snapshots: readonly ContextHealthSnapshot[];
}

/* ------------------------------------------------------------------ *
 * Idea ledger + Brief responses (DEC-033, issue #69)
 * ------------------------------------------------------------------ */

/** Response to idea mutations (`idea-create`, `idea-append`, `idea-promote`). */
export interface IdeaResponse {
  readonly ok: boolean;
  readonly idea: IdeaLedger | null;
  readonly error?: string;
}

/** Response to `idea-list`. */
export interface IdeaListResponse {
  readonly ok: boolean;
  readonly ideas: readonly IdeaLedger[];
}

/** Response to `brief-compile` — the persisted draft. */
export interface BriefResponse {
  readonly ok: boolean;
  readonly brief: Brief | null;
  readonly error?: string;
}

/** Response to `brief-confirm` — the gate result + per-task dispatch. */
export interface BriefConfirmResponse {
  readonly ok: boolean;
  readonly brief: Brief | null;
  readonly results: readonly BriefDispatchResult[];
  readonly error?: string;
}

/** Response to `update-preference`/`query-preferences` — the profile. */
export interface PreferenceResponse {
  readonly ok: boolean;
  /** Rendered rules+denies, for the caller to echo. */
  readonly summary?: string;
  /**
   * Need-to-know prompt text for a project manager (query-preferences
   * with `projectId`) — global rules plus that project's own.
   */
  readonly promptText?: string;
  /**
   * Structured profile visible to the caller (query-preferences only):
   * the full profile when `projectId` is omitted, otherwise global entries
   * plus that project's own entries.
   */
  readonly profile?: PreferenceProfile;
  readonly error?: string;
}

/**
 * Response to `delegate-task` (issue #78): the child-side result of
 * accepting a remote delegation — mirrors `SpawnTaskResult` so the
 * parent sees spawned/parked/error verbatim.
 */
export interface DelegateTaskResponse {
  readonly ok: boolean;
  readonly status?: 'spawned' | 'parked' | 'error';
  readonly taskId?: string;
  readonly sessionId?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly reason?: string;
  readonly resumeAt?: string | null;
  readonly error?: string;
}

/** Generic error response for unknown / malformed commands. */
export interface UnknownCommandResponse {
  readonly ok: false;
  readonly error: string;
}

/**
 * Union of every response variant. {@link CommandApi.execute} returns a
 * member of this union; the caller knows which variant to expect based on
 * the command `kind` they sent.
 */
/** query-events response: journaled events for a task. */
export interface EventsResponse {
  readonly ok: boolean;
  readonly taskId: string;
  readonly events: readonly Event[];
  readonly error?: string;
}

export type Response =
  | StartTaskResponse
  | EventsResponse
  | StopTaskResponse
  | ApproveResponse
  | InboxResponse
  | ItemMutationResponse
  | RaiseAttentionResponse
  | MetricsResponse
  | TaskResponse
  | TaskListResponse
  | PruneResponse
  | ShutdownResponse
  | DigestResponse
  | CreatePrResponse
  | ContextHealthResponse
  | IdeaResponse
  | IdeaListResponse
  | BriefResponse
  | BriefConfirmResponse
  | PreferenceResponse
  | DelegateTaskResponse
  | UnknownCommandResponse;

/* ================================================================== *
 * Dependency interfaces (structural â€” easy to mock in tests)
 * ================================================================== */

/**
 * Read-side projection of the context-health monitor (DEC-035, issue
 * #77). The command API only reads snapshots — tracking and emission
 * stay inside the monitor.
 */
export interface ContextHealthReadPort {
  snapshot(agentId: string): ContextHealthSnapshot | undefined;
  listSnapshots(): ContextHealthSnapshot[];
}

/**
 * Minimal task data-access interface needed by {@link CommandApi}.
 *
 * A narrowed projection of the core {@link TaskRepositoryPort}: the real
 * `TaskRepository` satisfies it, and tests provide an in-memory mock.
 */
export type TaskStore = Pick<TaskRepositoryPort, 'getById' | 'listAll' | 'update'>;

/**
 * Minimal approval data-access interface needed by {@link CommandApi}.
 * A narrowed projection of the core {@link ApprovalRepositoryPort}; the
 * real `ApprovalRepository` satisfies both methods.
 */
export type ApprovalStore = Pick<ApprovalRepositoryPort, 'getById' | 'update'>;

/**
 * Minimal session data-access interface needed by {@link CommandApi}.
 * A narrowed projection of the core {@link SessionRepositoryPort}; the
 * real `SessionRepository` satisfies both methods. `delete` is used to
 * roll back an inserted session row when a subsequent step in `start-task`
 * fails before any journal events reference the session.
 */
export type SessionStore = Pick<SessionRepositoryPort, 'insert' | 'delete'>;

/**
 * Dependencies injected into {@link CommandApi}.
 *
 * The six core dependencies match the issue specification. `taskStore`,
 * `approvalStore`, and `sessionStore` are added because `query-task`,
 * `list-tasks`, `prune-worktree`, `approve`, and `start-task` require direct
 * data access not exposed by the other deps. `onShutdown` is an optional
 * callback invoked when the `shutdown` command is received.
 */
export interface CommandApiDeps {
  readonly eventBus: EventPublisherPort;
  readonly taskStateMachine: TaskStateMachine;
  readonly attentionInbox: AttentionInbox;
  readonly metricsCollector: MetricsCollector;
  readonly worktreeManager: WorktreePort;
  readonly eventRepository: EventJournalPort;
  readonly taskStore: TaskStore;
  readonly approvalStore: ApprovalStore;
  readonly sessionStore: SessionStore;
  /** Optional callback invoked when the `shutdown` command is received. */
  readonly onShutdown?: () => void;
  /**
   * Optional adapter registry. When present (along with `sessionManager`),
   * `start-task` looks up an adapter by `agentId` and starts an agent
   * session that pipes normalized events onto the EventBus (issue #35).
   */
  readonly adapterRegistry?: AgentRuntimeRegistryPort;
  /**
   * Optional session manager. When present, `start-task` uses it to manage
   * the adapter lifecycle and `stop-task` uses it to cancel/disconnect the
   * active session (issue #35).
   */
  readonly sessionManager?: SessionManager;
  /**
   * Optional completion-digest repository. When present, the `get-digest`
   * command queries it for the latest digest for a task (issue #37).
   */
  readonly completionDigestRepository?: CompletionDigestRepositoryPort<CompletionDigest>;
  /**
   * Optional attention-metrics query service (DEC-015, issue #18). When
   * present, `query-metrics` computes the ACR + supplemental metrics report
   * for the requested time window / project / task and returns it as
   * `attentionMetrics` on the {@link MetricsResponse}.
   */
  readonly metricsQueryService?: MetricsQueryService;
  /**
   * Read-side of the context-health monitor (DEC-035, issue #77). When
   * wired, `context-health` commands return per-agent window-fill
   * snapshots; when absent the command returns an empty list.
   */
  readonly contextHealth?: ContextHealthReadPort;
  /**
   * Idea ledger + Brief service (DEC-033, issue #69). When wired, the
   * `idea-*`/`brief-*` commands are served; when absent they return a
   * clear `ok: false` rather than pretending to succeed.
   */
  readonly ideas?: IdeaService;
  /**
   * Durable preference profile (DEC-029, issue #73). When wired,
   * `update-preference` mutates + persists routing rules and denies;
   * when absent the command fails cleanly.
   */
  readonly preferences?: PreferenceProfilePort;
  /**
   * Federated delegation service (DEC-036, issue #78). When wired,
   * `delegate-task` accepts remote delegations from a parent Florina;
   * when absent the command fails cleanly — this daemon is not a child.
   */
  readonly delegation?: DelegationService;
}

/* ================================================================== *
 * CommandApi
 * ================================================================== */

/**
 * Minimal structural surface of the typed command API — the system's
 * driving port (DEC-002, DEC-037). Every inbound surface (CLI, voice,
 * desktop, MCP) ultimately funnels typed {@link Command}s through an
 * object shaped like this: the daemon's {@link CommandApi} itself, or a
 * transport proxy that forwards commands to it.
 */
export interface CommandExecutor {
  execute(command: Command): Promise<Response>;
}

/**
 * Typed command API shared by every surface (CLI, voice, desktop, remote).
 *
 * Construct with a {@link CommandApiDeps} object, then call
 * {@link CommandApi.execute} with a {@link Command}. Each handler validates
 * input, performs the action against the injected dependencies, and returns
 * a typed {@link Response}.
 */
export class CommandApi {
  private readonly eventBus: EventPublisherPort;
  private readonly taskStateMachine: TaskStateMachine;
  private readonly attentionInbox: AttentionInbox;
  private readonly metricsCollector: MetricsCollector;
  private readonly worktreeManager: WorktreePort;
  private readonly eventRepository: EventJournalPort;
  private readonly taskStore: TaskStore;
  private readonly approvalStore: ApprovalStore;
  private readonly sessionStore: SessionStore;
  private readonly onShutdown?: () => void;
  private readonly adapterRegistry?: AgentRuntimeRegistryPort;
  private readonly sessionManager?: SessionManager;
  private readonly completionDigestRepository?: CompletionDigestRepositoryPort<CompletionDigest>;
  private readonly metricsQueryService?: MetricsQueryService;
  private readonly contextHealth?: ContextHealthReadPort;
  private readonly ideas?: IdeaService;
  private readonly preferences?: PreferenceProfilePort;
  private readonly delegation?: DelegationService;

  /** Whether a `shutdown` command has been received. */
  private shutdownRequested = false;

  constructor(deps: CommandApiDeps) {
    this.eventBus = deps.eventBus;
    this.taskStateMachine = deps.taskStateMachine;
    this.attentionInbox = deps.attentionInbox;
    this.metricsCollector = deps.metricsCollector;
    this.worktreeManager = deps.worktreeManager;
    this.eventRepository = deps.eventRepository;
    this.taskStore = deps.taskStore;
    this.approvalStore = deps.approvalStore;
    this.sessionStore = deps.sessionStore;
    this.onShutdown = deps.onShutdown;
    this.adapterRegistry = deps.adapterRegistry;
    this.sessionManager = deps.sessionManager;
    this.completionDigestRepository = deps.completionDigestRepository;
    this.metricsQueryService = deps.metricsQueryService;
    this.contextHealth = deps.contextHealth;
    this.ideas = deps.ideas;
    this.preferences = deps.preferences;
    this.delegation = deps.delegation;
  }

  /** Whether a `shutdown` command has been received. */
  get isShutdownRequested(): boolean {
    return this.shutdownRequested;
  }

  /**
   * Dispatch a {@link Command} to the appropriate handler and return a
   * typed {@link Response}.
   *
   * Unknown command kinds (only possible at runtime) return an
   * {@link UnknownCommandResponse}.
   */
  async execute(command: Command): Promise<Response> {
    switch (command.kind) {
      case 'start-task':
        return this.handleStartTask(command);
      case 'stop-task':
        return this.handleStopTask(command);
      case 'approve':
        return this.handleApprove(command);
      case 'query-inbox':
        return this.handleQueryInbox(command);
      case 'raise-attention':
        return this.handleRaiseAttention(command);
      case 'ack-item':
        return this.handleAcknowledgeItem(command);
      case 'resolve-item':
        return this.handleResolveItem(command);
      case 'escalate-item':
        return this.handleEscalateItem(command);
      case 'query-metrics':
        return this.handleQueryMetrics(command);
      case 'query-task':
        return this.handleQueryTask(command);
      case 'query-events':
        return this.handleQueryEvents(command);
      case 'list-tasks':
        return this.handleListTasks(command);
      case 'prune-worktree':
        return this.handlePruneWorktree(command);
      case 'shutdown':
        return this.handleShutdown(command);
      case 'context-health':
        return this.handleContextHealth(command);
      case 'idea-create':
        return this.handleCreateIdea(command);
      case 'idea-list':
        return this.handleListIdeas();
      case 'idea-append':
        return this.handleAppendIdea(command);
      case 'idea-promote':
        return this.handlePromoteIdea(command);
      case 'brief-compile':
        return this.handleCompileBrief(command);
      case 'brief-confirm':
        return this.handleConfirmBrief(command);
      case 'update-preference':
        return this.handleUpdatePreference(command);
      case 'query-preferences':
        return this.handleQueryPreferences(command);
      case 'get-digest':
        return this.handleGetDigest(command);
      case 'create-pr':
        return this.handleCreatePr(command);
      case 'delegate-task':
        return this.handleDelegateTask(command);
      default:
        return {
          ok: false,
          error: `Unknown command kind: ${(command as { kind?: string }).kind ?? '<missing>'}`,
        };
    }
  }

  /* ---------------------------------------------------------------- *
   * Handlers
   * ---------------------------------------------------------------- */

  /** start-task: delegate a task to an agent and create a session. */
  private async handleStartTask(cmd: StartTaskCommand): Promise<StartTaskResponse> {
    if (!cmd.taskId) {
      return { ok: false, taskId: '', sessionId: '', error: 'taskId is required' };
    }
    if (!cmd.agentId) {
      return { ok: false, taskId: cmd.taskId, sessionId: '', error: 'agentId is required' };
    }
    if (!cmd.sessionConfig?.workingDir) {
      return {
        ok: false,
        taskId: cmd.taskId,
        sessionId: '',
        error: 'sessionConfig.workingDir is required',
      };
    }

    const task = this.taskStore.getById(cmd.taskId);
    if (task === null) {
      return {
        ok: false,
        taskId: cmd.taskId,
        sessionId: '',
        error: `Task not found: ${cmd.taskId}`,
      };
    }

    // Determine the transition based on the current state.
    let currentState: TaskStateType;
    try {
      currentState = this.taskStateMachine.getCurrentState(cmd.taskId);
    } catch {
      return {
        ok: false,
        taskId: cmd.taskId,
        sessionId: '',
        error: `Task not found: ${cmd.taskId}`,
      };
    }

    // Validate the state transition is possible before any side effects.
    // This ensures we fail fast without mutating DB state or starting an
    // adapter session that would then need to be rolled back.
    // `blocked` and `attention-needed` are resumable states: a parked
    // (quota-exhausted) or attention-flagged task starts again by
    // transitioning to `running` (issue #64 failover/park-resume).
    const startable =
      currentState === TaskState.Created ||
      currentState === TaskState.Delegated ||
      currentState === TaskState.Blocked ||
      currentState === TaskState.AttentionNeeded;
    if (!startable) {
      return {
        ok: false,
        taskId: cmd.taskId,
        sessionId: '',
        error: `Task is in state "${currentState}" and cannot be started`,
      };
    }

    const sessionId = generateId('session');
    const ctx: TransitionContext = {
      sessionId,
      agentId: cmd.agentId,
      payload: {
        agentId: cmd.agentId,
        workingDir: cmd.sessionConfig.workingDir,
        model: cmd.sessionConfig.model ?? null,
      },
    };

    // --- Start the adapter session FIRST (if configured) ---
    // If the adapter fails to start, no DB state has been mutated, so the
    // task remains in its original state and the caller can retry with a
    // different agent or after fixing the adapter (issue #35 audit fix).
    if (this.adapterRegistry && this.sessionManager) {
      let adapter: AgentRuntimePort;
      try {
        adapter = this.adapterRegistry.create(cmd.agentId);
      } catch (err) {
        return {
          ok: false,
          taskId: cmd.taskId,
          sessionId: '',
          error: `Unknown or unavailable adapter for agent "${cmd.agentId}": ${errorMessage(err)}`,
        };
      }
      const adapterSessionConfig: AdapterSessionConfig = {
        taskId: cmd.taskId,
        sessionId,
        agentId: cmd.agentId,
        workingDir: cmd.sessionConfig.workingDir,
        objective: cmd.sessionConfig.prompt ?? task.objective,
        model: cmd.sessionConfig.model,
        autonomyLevel: cmd.sessionConfig.autonomyLevel,
        mcpServers: cmd.sessionConfig.mcpServers,
      };
      const sessionResult = await this.sessionManager.startSession(
        cmd.taskId,
        cmd.agentId,
        adapter,
        adapterSessionConfig,
      );
      if (!sessionResult.ok) {
        return {
          ok: false,
          taskId: cmd.taskId,
          sessionId: '',
          error: sessionResult.error ?? 'Failed to start adapter session',
        };
      }
    }

    // --- Persist the session row ---
    // Insert before transitioning so the events table FK
    // (session_id â†’ sessions.id) is satisfied when the state machine appends
    // the transition event to the journal (DEC-012).
    const session: Session = {
      id: sessionId,
      taskId: cmd.taskId,
      agentId: cmd.agentId,
      status: 'running',
      startedAt: new Date().toISOString(),
      eventIds: [],
      deliverableIds: [],
      capsuleId: generateId('capsule'),
    };
    try {
      this.sessionStore.insert(session);
    } catch (err) {
      await this.rollbackAdapterSession(cmd.taskId);
      return {
        ok: false,
        taskId: cmd.taskId,
        sessionId: '',
        error: `Failed to create session: ${errorMessage(err)}`,
      };
    }

    // --- Update the task to record the new session and agent ---
    // so that subsequent commands (e.g. stop-task) can resolve the correct
    // sessionId/agentId from the task row.
    try {
      this.taskStore.update({
        ...task,
        sessionIds: [...task.sessionIds, sessionId],
        agentIds: task.agentIds.includes(cmd.agentId)
          ? task.agentIds
          : [...task.agentIds, cmd.agentId],
      });
    } catch (err) {
      this.rollbackSessionRow(sessionId);
      await this.rollbackAdapterSession(cmd.taskId);
      return {
        ok: false,
        taskId: cmd.taskId,
        sessionId: '',
        error: `Failed to update task: ${errorMessage(err)}`,
      };
    }

    // --- Transition the task state ---
    // The state machine appends a journal event (with session_id FK) and
    // updates the task row. If it throws, no journal event was written, so
    // the session row can be safely deleted.
    try {
      if (currentState === TaskState.Created) {
        this.taskStateMachine.transition(cmd.taskId, TaskState.Created, TaskState.Delegated, ctx);
      } else {
        this.taskStateMachine.transition(cmd.taskId, currentState, TaskState.Running, ctx);
      }
    } catch (err) {
      // Revert the task update to remove the phantom sessionId/agentId.
      this.taskStore.update(task);
      this.rollbackSessionRow(sessionId);
      await this.rollbackAdapterSession(cmd.taskId);
      return {
        ok: false,
        taskId: cmd.taskId,
        sessionId: '',
        error: `Failed to start task: ${errorMessage(err)}`,
      };
    }

    // --- Publish an AgentStarted event on the live event bus ---
    const event: AgentStartedEvent = {
      type: 'AgentStarted',
      timestamp: new Date().toISOString(),
      taskId: cmd.taskId,
      sessionId,
      agentId: cmd.agentId,
      adapterFidelityTier: cmd.sessionConfig.adapterFidelityTier ?? 'B',
      objective: task.objective,
      workingDir: cmd.sessionConfig.workingDir,
      model: cmd.sessionConfig.model,
      autonomyLevel: cmd.sessionConfig.autonomyLevel,
    };
    this.eventBus.publish(event);

    return { ok: true, taskId: cmd.taskId, sessionId };
  }

  /**
   * Roll back an adapter session by stopping it via the session manager.
   * Used when a subsequent step in `start-task` fails after the adapter
   * session was already started. Best-effort: errors are swallowed so the
   * caller's error is not masked.
   */
  private async rollbackAdapterSession(taskId: string): Promise<void> {
    if (this.sessionManager) {
      try {
        await this.sessionManager.stopSession(taskId);
      } catch {
        /* best-effort â€” don't mask the original error */
      }
    }
  }

  /**
   * Remove a session row that was inserted but never referenced by any
   * journal event (e.g. the state machine transition failed before
   * appending an event). Best-effort: errors are swallowed.
   */
  private rollbackSessionRow(sessionId: string): void {
    try {
      this.sessionStore.delete(sessionId);
    } catch {
      /* best-effort â€” the row may be orphaned but won't cause issues */
    }
  }

  /** stop-task: cancel a running task. */
  private async handleStopTask(cmd: StopTaskCommand): Promise<StopTaskResponse> {
    if (!cmd.taskId) {
      return { ok: false, taskId: '', error: 'taskId is required' };
    }

    const task = this.taskStore.getById(cmd.taskId);
    if (task === null) {
      return { ok: false, taskId: cmd.taskId, error: `Task not found: ${cmd.taskId}` };
    }

    let currentState: TaskStateType;
    try {
      currentState = this.taskStateMachine.getCurrentState(cmd.taskId);
    } catch {
      return { ok: false, taskId: cmd.taskId, error: `Task not found: ${cmd.taskId}` };
    }

    if (isTerminalState(currentState)) {
      return {
        ok: false,
        taskId: cmd.taskId,
        error: `Task is already in terminal state "${currentState}"`,
      };
    }

    const sessionId = task.sessionIds[task.sessionIds.length - 1] ?? 'unknown';
    const agentId = task.agentIds[task.agentIds.length - 1] ?? 'unknown';
    const ctx: TransitionContext = {
      sessionId,
      agentId,
      payload: { reason: cmd.reason ?? 'user' },
    };

    try {
      this.taskStateMachine.transition(cmd.taskId, currentState, TaskState.Cancelled, ctx);
    } catch (err) {
      return {
        ok: false,
        taskId: cmd.taskId,
        error: `Failed to stop task: ${errorMessage(err)}`,
      };
    }

    // Publish an AgentStopped event on the live event bus.
    const event: AgentStoppedEvent = {
      type: 'AgentStopped',
      timestamp: new Date().toISOString(),
      taskId: cmd.taskId,
      sessionId,
      agentId,
      adapterFidelityTier: 'B',
      reason: 'user',
      details: cmd.reason,
    };
    this.eventBus.publish(event);

    // Tear down the adapter session (issue #35). Best-effort: the task
    // state transition already succeeded, so a missing or failing session
    // stop does not change the response. The session manager cancels the
    // adapter run and disconnects it.
    if (this.sessionManager) {
      await this.sessionManager.stopSession(cmd.taskId);
    }

    return { ok: true, taskId: cmd.taskId };
  }

  /** approve: grant or deny a pending approval. */
  private async handleApprove(cmd: ApproveCommand): Promise<ApproveResponse> {
    if (!cmd.taskId) {
      return { ok: false, approvalId: '', error: 'taskId is required' };
    }
    if (!cmd.approvalId) {
      return { ok: false, approvalId: '', error: 'approvalId is required' };
    }
    if (cmd.decision !== 'grant' && cmd.decision !== 'deny') {
      return {
        ok: false,
        approvalId: cmd.approvalId,
        error: `Invalid decision: "${cmd.decision}" (must be "grant" or "deny")`,
      };
    }

    const approval = this.approvalStore.getById(cmd.approvalId);
    if (approval === null) {
      return {
        ok: false,
        approvalId: cmd.approvalId,
        error: `Approval not found: ${cmd.approvalId}`,
      };
    }

    if (approval.taskId !== cmd.taskId) {
      return {
        ok: false,
        approvalId: cmd.approvalId,
        error: `Approval ${cmd.approvalId} does not belong to task ${cmd.taskId}`,
      };
    }

    const updated: Approval = {
      ...approval,
      granted: cmd.decision === 'grant',
      grantedAt: new Date().toISOString(),
    };

    try {
      this.approvalStore.update(updated);
    } catch (err) {
      return {
        ok: false,
        approvalId: cmd.approvalId,
        error: `Failed to update approval: ${errorMessage(err)}`,
      };
    }

    if (cmd.decision === 'grant') {
      this.metricsCollector.recordApprovalGranted(cmd.taskId);
    } else {
      this.metricsCollector.recordApprovalDenied(cmd.taskId);
    }

    return { ok: true, approvalId: cmd.approvalId };
  }

  /** query-inbox: list attention items, optionally filtered. */
  private async handleQueryInbox(cmd: QueryInboxCommand): Promise<InboxResponse> {
    const items = this.attentionInbox.list(cmd.filter);
    return { ok: true, items: items.map(toAttentionItemSnapshot) };
  }

  /** ack-item: acknowledge an attention item. */
  private async handleAcknowledgeItem(cmd: AcknowledgeItemCommand): Promise<ItemMutationResponse> {
    if (!cmd.itemId) {
      return { ok: false, itemId: '', error: 'itemId is required' };
    }
    const found = this.attentionInbox.acknowledge(cmd.itemId);
    if (!found) {
      return { ok: false, itemId: cmd.itemId, error: `Attention item not found: ${cmd.itemId}` };
    }
    return { ok: true, itemId: cmd.itemId };
  }

  /**
   * raise-attention: surface a question or decision to the human.
   *
   * Used by manager agents (`florina_request_human_input`) and daemon
   * subsystems to create inbox items through the typed command path rather
   * than a side channel (DEC-002/014, issue #63).
   */
  private async handleRaiseAttention(cmd: RaiseAttentionCommand): Promise<RaiseAttentionResponse> {
    if (!cmd.taskId) {
      return { ok: false, itemId: '', error: 'taskId is required' };
    }
    if (!cmd.summary || cmd.summary.trim().length === 0) {
      return { ok: false, itemId: '', error: 'summary is required' };
    }
    const itemKind = cmd.itemKind ?? 'Custom';
    if (!ATTENTION_ITEM_KINDS.includes(itemKind)) {
      return { ok: false, itemId: '', error: `unknown attention item kind: ${itemKind}` };
    }
    const priority = cmd.priority ?? 'Medium';
    if (!PRIORITY_ORDER.includes(priority)) {
      return { ok: false, itemId: '', error: `unknown attention priority: ${priority}` };
    }
    const item = createAttentionItem({
      taskId: cmd.taskId,
      kind: itemKind,
      priority,
      payload: {
        summary: cmd.summary,
        details: cmd.details ?? null,
        ...(cmd.source !== undefined ? { source: cmd.source } : {}),
      },
    });
    this.attentionInbox.add(item);
    return { ok: true, itemId: item.id };
  }

  /** resolve-item: resolve an attention item. */
  private async handleResolveItem(cmd: ResolveItemCommand): Promise<ItemMutationResponse> {
    if (!cmd.itemId) {
      return { ok: false, itemId: '', error: 'itemId is required' };
    }
    const found = this.attentionInbox.resolve(cmd.itemId);
    if (!found) {
      return { ok: false, itemId: cmd.itemId, error: `Attention item not found: ${cmd.itemId}` };
    }
    return { ok: true, itemId: cmd.itemId };
  }

  /** escalate-item: escalate an attention item to Critical priority. */
  private async handleEscalateItem(cmd: EscalateItemCommand): Promise<ItemMutationResponse> {
    if (!cmd.itemId) {
      return { ok: false, itemId: '', error: 'itemId is required' };
    }
    const found = this.attentionInbox.escalate(cmd.itemId);
    if (!found) {
      return { ok: false, itemId: cmd.itemId, error: `Attention item not found: ${cmd.itemId}` };
    }
    return { ok: true, itemId: cmd.itemId };
  }

  /** query-metrics: return the current metrics snapshot. */
  private async handleQueryMetrics(cmd: QueryMetricsCommand): Promise<MetricsResponse> {
    const snapshot = this.metricsCollector.snapshot();

    // When a metrics query service is wired, also compute the ACR +
    // supplemental metrics report (DEC-015) for the requested window /
    // project / task. All computation is deterministic and LLM-free.
    if (this.metricsQueryService !== undefined) {
      const opts: MetricsQueryOptions = {
        ...(cmd.since !== undefined ? { since: new Date(cmd.since).toISOString() } : {}),
        ...(cmd.until !== undefined ? { until: new Date(cmd.until).toISOString() } : {}),
        ...(cmd.projectId !== undefined ? { projectId: cmd.projectId } : {}),
        ...(cmd.taskId !== undefined ? { taskId: cmd.taskId } : {}),
      };
      const attentionMetrics = this.metricsQueryService.query(opts);
      return { ok: true, snapshot, attentionMetrics };
    }

    return { ok: true, snapshot };
  }

  /** query-task: return a single task snapshot by id. */
  private async handleQueryTask(cmd: QueryTaskCommand): Promise<TaskResponse> {
    if (!cmd.taskId) {
      return { ok: false, task: null };
    }
    const task = this.taskStore.getById(cmd.taskId);
    if (task === null) {
      return { ok: false, task: null };
    }
    const eventCount = this.eventRepository.listByTask(cmd.taskId).length;
    return { ok: true, task: toTaskSnapshot(task, eventCount) };
  }

  /** query-events: return the journaled events for a task (read-only). */
  private async handleQueryEvents(cmd: QueryEventsCommand): Promise<EventsResponse> {
    if (!cmd.taskId) {
      return { ok: false, taskId: '', events: [], error: 'taskId is required' };
    }
    if (this.taskStore.getById(cmd.taskId) === null) {
      return { ok: false, taskId: cmd.taskId, events: [], error: `Task not found: ${cmd.taskId}` };
    }
    return { ok: true, taskId: cmd.taskId, events: this.eventRepository.listByTask(cmd.taskId) };
  }

  /** list-tasks: list all tasks, optionally filtered by status. */
  private async handleListTasks(cmd: ListTasksCommand): Promise<TaskListResponse> {
    let tasks = this.taskStore.listAll();
    if (cmd.status !== undefined) {
      tasks = tasks.filter((t) => t.state === cmd.status);
    }
    return {
      ok: true,
      tasks: tasks.map((t) => toTaskSnapshot(t, this.eventRepository.listByTask(t.id).length)),
    };
  }

  /** prune-worktree: prune a task's git worktree (only if clean). */
  private async handlePruneWorktree(cmd: PruneWorktreeCommand): Promise<PruneResponse> {
    if (!cmd.taskId) {
      return { ok: false, taskId: '', error: 'taskId is required' };
    }
    const task = this.taskStore.getById(cmd.taskId);
    if (task === null) {
      return { ok: false, taskId: cmd.taskId, error: `Task not found: ${cmd.taskId}` };
    }
    if (!task.worktreePath) {
      return {
        ok: false,
        taskId: cmd.taskId,
        error: `Task ${cmd.taskId} has no worktree path`,
      };
    }
    try {
      this.worktreeManager.pruneWorktree(task.worktreePath);
    } catch (err) {
      if (err instanceof DirtyWorktreeError) {
        return {
          ok: false,
          taskId: cmd.taskId,
          error: `Worktree is dirty and cannot be pruned: ${err.worktreePath}`,
        };
      }
      return {
        ok: false,
        taskId: cmd.taskId,
        error: `Failed to prune worktree: ${errorMessage(err)}`,
      };
    }
    return { ok: true, taskId: cmd.taskId };
  }

  /** shutdown: signal the daemon to shut down. */
  private async handleShutdown(_cmd: ShutdownCommand): Promise<ShutdownResponse> {
    this.shutdownRequested = true;
    this.onShutdown?.();
    return { ok: true };
  }

  /**
   * context-health: per-agent window-fill snapshots (DEC-035, issue #77).
   *
   * When no monitor is wired the response is an empty list — the command
   * itself is still well-formed so `florina status` degrades cleanly.
   */
  private async handleContextHealth(
    cmd: QueryContextHealthCommand,
  ): Promise<ContextHealthResponse> {
    if (this.contextHealth === undefined) {
      return { ok: true, snapshots: [] };
    }
    if (cmd.agentId !== undefined) {
      const snapshot = this.contextHealth.snapshot(cmd.agentId);
      return { ok: true, snapshots: snapshot === undefined ? [] : [snapshot] };
    }
    return { ok: true, snapshots: this.contextHealth.listSnapshots() };
  }

  /* ---------------------------------------------------------------- *
   * Idea ledger + Brief handlers (DEC-033, issue #69)
   * ---------------------------------------------------------------- */

  private ideasUnavailable(): { ok: false; error: string } {
    return { ok: false, error: 'idea ledger service is not wired into this daemon' };
  }

  private async handleCreateIdea(cmd: CreateIdeaCommand): Promise<IdeaResponse> {
    if (this.ideas === undefined) return { ...this.ideasUnavailable(), idea: null };
    try {
      return {
        ok: true,
        idea: this.ideas.createIdea(cmd.title, cmd.body),
      };
    } catch (err) {
      return { ok: false, idea: null, error: errorMessage(err) };
    }
  }

  private async handleListIdeas(): Promise<IdeaListResponse> {
    if (this.ideas === undefined) return { ok: false, ideas: [] };
    return { ok: true, ideas: this.ideas.listIdeas() };
  }

  private async handleAppendIdea(cmd: AppendIdeaCommand): Promise<IdeaResponse> {
    if (this.ideas === undefined) return { ...this.ideasUnavailable(), idea: null };
    try {
      return {
        ok: true,
        idea: this.ideas.appendToIdea(cmd.ideaId, cmd.heading, cmd.body),
      };
    } catch (err) {
      return { ok: false, idea: null, error: errorMessage(err) };
    }
  }

  private async handlePromoteIdea(cmd: PromoteIdeaCommand): Promise<IdeaResponse> {
    if (this.ideas === undefined) return { ...this.ideasUnavailable(), idea: null };
    try {
      return {
        ok: true,
        idea: this.ideas.promoteIdea(cmd.ideaId, cmd.projectId, cmd.targetDir),
      };
    } catch (err) {
      return { ok: false, idea: null, error: errorMessage(err) };
    }
  }

  private async handleCompileBrief(cmd: CompileBriefCommand): Promise<BriefResponse> {
    if (this.ideas === undefined) return { ...this.ideasUnavailable(), brief: null };
    try {
      return { ok: true, brief: this.ideas.compileBrief(cmd.ideaId, cmd.plan) };
    } catch (err) {
      return { ok: false, brief: null, error: errorMessage(err) };
    }
  }

  private async handleConfirmBrief(cmd: ConfirmBriefCommand): Promise<BriefConfirmResponse> {
    if (this.ideas === undefined) {
      return { ...this.ideasUnavailable(), brief: null, results: [] };
    }
    try {
      const { brief, results } = await this.ideas.confirmBrief(
        cmd.briefId,
        cmd.confirmedBy ?? 'cli',
      );
      return { ok: true, brief, results };
    } catch (err) {
      return { ok: false, brief: null, results: [], error: errorMessage(err) };
    }
  }

  /**
   * update-preference: mutate the durable routing profile (DEC-029,
   * issue #73). Mutations persist immediately — a spoken preference is
   * a routing fact, not a prompt hint.
   */
  private async handleUpdatePreference(cmd: UpdatePreferenceCommand): Promise<PreferenceResponse> {
    if (this.preferences === undefined) {
      return { ok: false, error: 'preference profile is not wired into this daemon' };
    }
    if (cmd.provider.trim().length === 0) {
      return { ok: false, error: 'provider is required' };
    }
    const store = this.preferences;
    try {
      switch (cmd.action) {
        case 'add-rule':
          store.addRule({
            provider: cmd.provider,
            ...(cmd.model !== undefined ? { model: cmd.model } : {}),
            ...(cmd.workTypes !== undefined ? { workTypes: [...cmd.workTypes] } : {}),
            ...(cmd.projectId !== undefined ? { projectId: cmd.projectId } : {}),
            ...(cmd.note !== undefined ? { note: cmd.note } : {}),
          });
          break;
        case 'deny':
          store.addDeny({
            provider: cmd.provider,
            ...(cmd.model !== undefined ? { model: cmd.model } : {}),
            ...(cmd.projectId !== undefined ? { projectId: cmd.projectId } : {}),
            ...(cmd.note !== undefined ? { note: cmd.note } : {}),
          });
          break;
        case 'remove-rule':
          if (!store.removeRule(cmd.provider, cmd.model, cmd.projectId)) {
            return { ok: false, error: `no rule for provider ${cmd.provider}` };
          }
          break;
        case 'remove-deny':
          if (!store.removeDeny(cmd.provider, cmd.model, cmd.projectId)) {
            return { ok: false, error: `no deny for provider ${cmd.provider}` };
          }
          break;
      }
      await store.save();
      const profile = store.toProfile();
      const summary = renderPreferenceSummary(profile);
      return { ok: true, summary };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  }

  /**
   * query-preferences: read the durable profile (issue #65). With
   * `projectId`, also returns the need-to-know prompt text a manager for
   * that project would see — global rules plus that project's own.
   */
  private async handleQueryPreferences(cmd: QueryPreferencesCommand): Promise<PreferenceResponse> {
    if (this.preferences === undefined) {
      return { ok: false, error: 'preference profile is not wired into this daemon' };
    }
    const profile = this.preferences.toProfile();
    const promptText = preferencePromptText(profile, cmd.projectId);
    return {
      ok: true,
      summary: renderPreferenceSummary(profile, cmd.projectId),
      profile: preferenceProfileForProject(profile, cmd.projectId),
      ...(promptText !== null ? { promptText } : {}),
    };
  }

  /** get-digest: return the latest completion digest for a task (issue #37). */
  private async handleGetDigest(cmd: GetDigestCommand): Promise<DigestResponse> {
    if (!cmd.taskId) {
      return { ok: false, digest: null, error: 'taskId is required' };
    }
    if (!this.completionDigestRepository) {
      return {
        ok: false,
        digest: null,
        error: 'Completion digest repository is not configured',
      };
    }
    try {
      const digest = this.completionDigestRepository.findByTaskId(cmd.taskId);
      return { ok: true, digest };
    } catch (err) {
      return {
        ok: false,
        digest: null,
        error: `Failed to query digest: ${errorMessage(err)}`,
      };
    }
  }

  /**
   * create-pr: initiate pull-request creation for a task's branch (issue #27).
   *
   * Validates the task exists and has a worktree, resolves the branch and head
   * commit, and returns them so the caller (renderer/CLI) can complete PR
   * creation with the hosting provider. The actual push/PR-creation step is
   * delegated to an authorized downstream integration; this handler does not
   * perform network actions or widen permissions (DEC-011).
   */
  private async handleCreatePr(cmd: CreatePrCommand): Promise<CreatePrResponse> {
    if (!cmd.taskId) {
      return { ok: false, taskId: '', error: 'taskId is required' };
    }
    const task = this.taskStore.getById(cmd.taskId);
    if (task === null) {
      return { ok: false, taskId: cmd.taskId, error: `Task not found: ${cmd.taskId}` };
    }
    if (!task.worktreePath) {
      return {
        ok: false,
        taskId: cmd.taskId,
        error: `Task has no worktree: ${cmd.taskId}`,
      };
    }
    try {
      const status = this.worktreeManager.worktreeStatus(task.worktreePath);
      return {
        ok: true,
        taskId: cmd.taskId,
        branch: status.branch,
        headCommit: status.baseCommit,
      };
    } catch (err) {
      return {
        ok: false,
        taskId: cmd.taskId,
        error: `Failed to resolve worktree status: ${errorMessage(err)}`,
      };
    }
  }

  /**
   * delegate-task (DEC-036, issue #78): accept a remote delegation from a
   * parent Florina. The DelegationService resolves the project and
   * spawns through the same route → create → worktree → start machinery
   * as every local spawn — a remote pool is just more capacity.
   */
  private async handleDelegateTask(cmd: DelegateTaskCommand): Promise<DelegateTaskResponse> {
    if (this.delegation === undefined) {
      return { ok: false, status: 'error', error: 'delegation is not wired on this daemon' };
    }
    if (!cmd.projectId) {
      return { ok: false, status: 'error', error: 'projectId is required' };
    }
    const result = await this.delegation.delegate({
      projectId: cmd.projectId,
      objective: cmd.objective,
      ...(cmd.workType !== undefined ? { workType: cmd.workType } : {}),
      ...(cmd.preferProvider !== undefined ? { preferProvider: cmd.preferProvider } : {}),
      ...(cmd.preferModel !== undefined ? { preferModel: cmd.preferModel } : {}),
      ...(cmd.excludeProviders !== undefined ? { excludeProviders: cmd.excludeProviders } : {}),
    });
    if (result.status === 'spawned') {
      return {
        ok: true,
        status: 'spawned',
        taskId: result.taskId,
        sessionId: result.sessionId,
        provider: result.provider,
        ...(result.model !== undefined ? { model: result.model } : {}),
        reason: result.reason,
      };
    }
    if (result.status === 'parked') {
      return {
        ok: true,
        status: 'parked',
        resumeAt: result.resumeAt,
        reason: result.reason,
      };
    }
    return { ok: false, status: 'error', error: result.error };
  }
}

/* ================================================================== *
 * Internal helpers
 * ================================================================== */

/** Terminal task states â€” no further transitions permitted. */
const TERMINAL_STATES: ReadonlySet<TaskStateType> = new Set<TaskStateType>([
  TaskState.Accepted,
  TaskState.Failed,
  TaskState.Cancelled,
]);

/** Whether a task state is terminal. */
function isTerminalState(state: TaskStateType): boolean {
  return TERMINAL_STATES.has(state);
}

/** Generate a reasonably unique id without a crypto dependency. */
function generateId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

/**
 * Return the profile visible to `projectId` (global entries plus that
 * project's own); omitted `projectId` returns the full user-level profile.
 */
function preferenceProfileForProject(
  profile: PreferenceProfile,
  projectId?: string,
): PreferenceProfile {
  if (projectId === undefined) return profile;
  const visible = (r: { readonly projectId?: string }): boolean =>
    r.projectId === undefined || r.projectId === projectId;
  return {
    rules: profile.rules.filter(visible),
    denied: profile.denied.filter(visible),
  };
}

/**
 * Render the preference profile for CLI/voice echo (issue #65). With
 * `projectId`, only rules visible to that project are listed (global +
 * project-scoped — DEC-003 need-to-know).
 */
function renderPreferenceSummary(profile: PreferenceProfile, projectId?: string): string {
  const visibleProfile = preferenceProfileForProject(profile, projectId);
  const lines = [
    ...visibleProfile.rules.map(
      (r) =>
        `rule: ${r.provider}${r.model !== undefined ? `/${r.model}` : ''}` +
        `${r.projectId !== undefined ? ` [project ${r.projectId}]` : ''}` +
        `${r.note !== undefined ? ` — ${r.note}` : ''}`,
    ),
    ...visibleProfile.denied.map(
      (d) =>
        `deny: ${d.provider}${d.model !== undefined ? `/${d.model}` : ''}` +
        `${d.projectId !== undefined ? ` [project ${d.projectId}]` : ''}` +
        `${d.note !== undefined ? ` — ${d.note}` : ''}`,
    ),
  ];
  return lines.length === 0 ? 'no preferences recorded' : lines.join('\n');
}

/** Extract a human-readable message from an unknown error. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Map an {@link AttentionItem} to a serializable snapshot. */
function toAttentionItemSnapshot(item: AttentionItem): AttentionItemSnapshot {
  return {
    id: item.id,
    taskId: item.taskId,
    kind: item.kind,
    priority: item.priority,
    status: item.status,
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
    payload: item.payload,
  };
}

/** Map a {@link Task} to a serializable snapshot with an event count. */
function toTaskSnapshot(task: Task, eventCount: number): TaskSnapshot {
  return {
    id: task.id,
    projectId: task.projectId,
    objective: task.objective,
    state: task.state,
    agentIds: [...task.agentIds],
    sessionIds: [...task.sessionIds],
    worktreePath: task.worktreePath,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    eventCount,
  };
}

/**
 * Type-level mapping from a {@link Command} variant to its expected
 * {@link Response} variant. Useful for callers that want compile-time
 * narrowing of the response based on the command they sent.
 *
 * @example
 * const res = await api.execute({ kind: 'shutdown' } as ShutdownCommand);
 * // res is narrowed to ShutdownResponse
 */
export type CommandResponse<C extends Command> = C extends StartTaskCommand
  ? StartTaskResponse
  : C extends StopTaskCommand
    ? StopTaskResponse
    : C extends ApproveCommand
      ? ApproveResponse
      : C extends QueryInboxCommand
        ? InboxResponse
        : C extends RaiseAttentionCommand
          ? RaiseAttentionResponse
          : C extends AcknowledgeItemCommand
            ? ItemMutationResponse
            : C extends ResolveItemCommand
              ? ItemMutationResponse
              : C extends EscalateItemCommand
                ? ItemMutationResponse
                : C extends QueryMetricsCommand
                  ? MetricsResponse
                  : C extends QueryTaskCommand
                    ? TaskResponse
                    : C extends ListTasksCommand
                      ? TaskListResponse
                      : C extends PruneWorktreeCommand
                        ? PruneResponse
                        : C extends ShutdownCommand
                          ? ShutdownResponse
                          : C extends QueryContextHealthCommand
                            ? ContextHealthResponse
                            : C extends CreateIdeaCommand | AppendIdeaCommand | PromoteIdeaCommand
                              ? IdeaResponse
                              : C extends ListIdeasCommand
                                ? IdeaListResponse
                                : C extends CompileBriefCommand
                                  ? BriefResponse
                                  : C extends ConfirmBriefCommand
                                    ? BriefConfirmResponse
                                    : C extends UpdatePreferenceCommand | QueryPreferencesCommand
                                      ? PreferenceResponse
                                      : C extends GetDigestCommand
                                        ? DigestResponse
                                        : C extends CreatePrCommand
                                          ? CreatePrResponse
                                          : Response;

/**
 * Narrowing wrapper around {@link CommandApi.execute} that returns the
 * response typed as {@link CommandResponse} for the given command.
 *
 * This is a convenience function for callers that want the response narrowed
 * to the specific variant matching their command.
 */
export async function executeCommand<C extends Command>(
  api: CommandApi,
  command: C,
): Promise<CommandResponse<C>> {
  return (await api.execute(command)) as CommandResponse<C>;
}

// Re-export SupervisorEvent for the publish call type-checking.
// (The import is used in the EventBus.publish call signature.)
export type { SupervisorEvent };
