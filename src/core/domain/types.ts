/**
 * Domain object type definitions — the 10 core domain objects from
 * PRODUCT_DESIGN.md "Core Domain Objects" and their relationships
 * (DEC-004).
 *
 * Relationships encoded via id references (not direct object nesting) so the
 * graph stays serializable and cycles are avoided:
 *   Project -< Task -< Session >- Agent
 *   Session -< Event, Session -< Deliverable
 *   Event -> AttentionItem -> Decision | Approval
 *   Project | Task | Session --1:1--> ContextCapsule
 */
import type {
  AdapterFidelityTier,
  ApprovalAuthorityLevel,
  AttentionCategory,
  AttentionPriority,
  ContextCapsuleScope,
  TaskState,
} from './enums.js';

/* ------------------------------------------------------------------ *
 * Shared primitives
 * ------------------------------------------------------------------ */

/** Opaque branded identifier. */
export type EntityId = string;

/** ISO-8601 timestamp string. */
export type ISODateString = string;

/* ------------------------------------------------------------------ *
 * 1. Project
 * ------------------------------------------------------------------ */

/**
 * Durable work context, usually corresponding to a repository or closely
 * related workspace. Contains multiple Tasks and owns a Project-scoped
 * Context Capsule.
 */
export interface Project {
  readonly id: EntityId;
  readonly name: string;
  /** Repository / workspace metadata. */
  readonly repo: RepoMetadata;
  /** Project-level execution / approval policies. */
  readonly policies: ProjectPolicies;
  /** Ids of the Tasks belonging to this Project. */
  readonly taskIds: readonly EntityId[];
  /** Id of the Project-scoped Context Capsule. */
  readonly capsuleId: EntityId;
  readonly createdAt: ISODateString;
  readonly updatedAt: ISODateString;
}

export interface RepoMetadata {
  /** Local filesystem path or git worktree root. */
  readonly path: string;
  readonly remoteUrl?: string;
  readonly defaultBranch?: string;
}

export interface ProjectPolicies {
  /** Whether auto-approval is permitted for high-fidelity adapters. */
  readonly allowAutoApproval: boolean;
  /** Liveness timeout (ms) before an attention item is raised. */
  readonly livenessTimeoutMs: number;
  /** Capabilities that always require human approval. */
  readonly alwaysApprove: readonly string[];
}

/* ------------------------------------------------------------------ *
 * 2. Task
 * ------------------------------------------------------------------ */

/**
 * A goal delegated to one or more agents. The human-facing unit of work.
 * A task may be handled by one agent, move between agents, use several
 * parallel agents, produce several sessions, restart after failure, and
 * generate multiple Deliverables.
 */
export interface Task {
  readonly id: EntityId;
  readonly projectId: EntityId;
  readonly objective: string;
  readonly state: TaskState;
  /** Ids of Agents this Task is delegated to. */
  readonly agentIds: readonly EntityId[];
  /** Ids of Sessions (Runs) spawned for this Task. */
  readonly sessionIds: readonly EntityId[];
  /** Ids of Deliverables produced by this Task. */
  readonly deliverableIds: readonly EntityId[];
  /** Ids of open AttentionItems for this Task. */
  readonly attentionItemIds: readonly EntityId[];
  /** Id of the Task-scoped Context Capsule. */
  readonly capsuleId: EntityId;
  /** Maps 1:1 to a git worktree in MVP (DEC-020). */
  readonly worktreePath?: string;
  /**
   * Optional reference to an `AgentProfile` (issue #196) — the role this
   * Task is executed under. Undefined for Tasks that predate this field
   * or don't need one; no forced migration.
   */
  readonly agentProfileId?: EntityId;
  readonly createdAt: ISODateString;
  readonly updatedAt: ISODateString;
}

/* ------------------------------------------------------------------ *
 * 3. Agent
 * ------------------------------------------------------------------ */

/**
 * A provider/runtime capable of performing work (Codex, Claude Code, future
 * ACP agents, etc.). Agent-specific details live behind adapters.
 */
export interface Agent {
  readonly id: EntityId;
  readonly name: string;
  /** Provider identifier, e.g. "codex" | "claude-code". */
  readonly provider: string;
  readonly fidelityTier: AdapterFidelityTier;
  /** Runtime invocation info (CLI path, app-server endpoint, etc.). */
  readonly runtime: AgentRuntime;
  readonly createdAt: ISODateString;
}

export interface AgentRuntime {
  readonly kind: 'cli' | 'app-server' | 'acp' | 'pty';
  readonly command?: string;
  readonly endpoint?: string;
}

/* ------------------------------------------------------------------ *
 * 4. Session (Run)
 * ------------------------------------------------------------------ */

/**
 * A concrete execution / conversation instance belonging to exactly one
 * Task. Implementation detail — the human shouldn't need to care unless
 * session-level detail becomes relevant (DEC-004).
 */
export interface Session {
  readonly id: EntityId;
  /** A Session belongs to exactly one Task. */
  readonly taskId: EntityId;
  /** The Agent executing this Session. */
  readonly agentId: EntityId;
  readonly status: SessionStatus;
  readonly startedAt: ISODateString;
  readonly endedAt?: ISODateString;
  /** Ids of Events produced by this Session. */
  readonly eventIds: readonly EntityId[];
  /** Ids of Deliverables produced by this Session. */
  readonly deliverableIds: readonly EntityId[];
  /** Id of the Session-scoped (ephemeral) Context Capsule. */
  readonly capsuleId: EntityId;
}

export type SessionStatus = 'pending' | 'running' | 'idle' | 'completed' | 'failed' | 'stopped';

/* ------------------------------------------------------------------ *
 * 5. Deliverable
 * ------------------------------------------------------------------ */

/**
 * An artifact or meaningful result produced by a Task: code change, commit,
 * diff, PR, analysis, test results, migration, design proposal.
 */
export interface Deliverable {
  readonly id: EntityId;
  readonly taskId: EntityId;
  readonly sessionId?: EntityId;
  readonly type: DeliverableType;
  readonly title: string;
  readonly description: string;
  /** Concrete artifact references (deterministic, from tools). */
  readonly artifacts: DeliverableArtifacts;
  readonly createdAt: ISODateString;
}

export type DeliverableType =
  | 'code-change'
  | 'commit'
  | 'diff'
  | 'pr'
  | 'analysis'
  | 'test-results'
  | 'migration'
  | 'design-proposal';

export interface DeliverableArtifacts {
  readonly commitSha?: string;
  readonly branch?: string;
  readonly diffStat?: string;
  readonly prUrl?: string;
  readonly filesChanged?: readonly string[];
  readonly testSummary?: string;
}

/* ------------------------------------------------------------------ *
 * 6. Event
 * ------------------------------------------------------------------ */

/**
 * Immutable timestamped observation of something that happened during task
 * execution. Stored in the append-only event journal before any
 * summarization (DEC-012).
 *
 * The canonical `SupervisorEvent` union (DEC-019) is the normalized payload
 * shape produced by adapters; `Event` is the journaled envelope carrying it.
 */
export interface Event {
  readonly id: EntityId;
  readonly sessionId: EntityId;
  readonly taskId: EntityId;
  readonly timestamp: ISODateString;
  /** Normalized event kind from the SupervisorEvent union (DEC-019). */
  readonly kind: SupervisorEventKind;
  /** Structured adapter payload (deterministic, never LLM-generated). */
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * The set of canonical event kinds defined by DEC-019. Adapters normalize
 * their native events into this union.
 */
export type SupervisorEventKind =
  | 'AgentStarted'
  | 'AgentProgress'
  | 'ToolStarted'
  | 'ToolFinished'
  | 'FileChanged'
  | 'TestStarted'
  | 'TestFinished'
  | 'ApprovalRequested'
  | 'HumanInputRequested'
  | 'ApprovalGranted'
  | 'ApprovalRevoked'
  | 'AgentBlocked'
  | 'AgentCompleted'
  | 'AgentFailed'
  | 'AgentStopped'
  | 'UsageReported'
  | 'QuotaObserved'
  | 'TaskFailedOver'
  | 'TaskParked'
  | 'TaskResumed'
  | 'ContextCondensed'
  | 'ContextHealthChanged'
  | 'VerificationObserved';

/* ------------------------------------------------------------------ *
 * 7. AttentionItem
 * ------------------------------------------------------------------ */

/**
 * An event or state that merits human attention. Separate from both Task
 * and Run. Has severity, reason, exact decision requested, affected
 * capability, suggested safe options, and deadline / blocking impact.
 */
export interface AttentionItem {
  readonly id: EntityId;
  readonly taskId: EntityId;
  readonly category: AttentionCategory;
  readonly priority: AttentionPriority;
  readonly reason: string;
  /** The exact decision or approval requested from the human. */
  readonly decisionRequested: string;
  /** Capability affected (e.g. "network", "filesystem", "push"). */
  readonly affectedCapability?: string;
  /** Suggested safe options the human may choose between. */
  readonly suggestedSafeOptions: readonly string[];
  /** Deadline before this becomes blocking, or undefined if immediate. */
  readonly deadline?: ISODateString;
  /** Whether resolving this item blocks task progress. */
  readonly blockingImpact: boolean;
  /** Events that triggered this attention item. */
  readonly relatedEventIds: readonly EntityId[];
  readonly resolved: boolean;
  readonly createdAt: ISODateString;
}

/* ------------------------------------------------------------------ *
 * 8. Decision
 * ------------------------------------------------------------------ */

/**
 * A question that requires or records user judgment. Prompted by an
 * AttentionItem.
 */
export interface Decision {
  readonly id: EntityId;
  readonly taskId: EntityId;
  readonly attentionItemId?: EntityId;
  readonly question: string;
  readonly options: readonly string[];
  /** The user's recorded answer, once decided. */
  readonly answer?: string;
  readonly status: DecisionStatus;
  readonly createdAt: ISODateString;
  readonly decidedAt?: ISODateString;
}

export type DecisionStatus = 'open' | 'decided' | 'withdrawn';

/* ------------------------------------------------------------------ *
 * 9. Approval
 * ------------------------------------------------------------------ */

/**
 * An explicit permission to perform a particular class of action. Approvals
 * authorize the underlying capability (structured adapter data), never an
 * LLM summary (DEC-010).
 */
export interface Approval {
  readonly id: EntityId;
  readonly taskId: EntityId;
  readonly attentionItemId?: EntityId;
  /** The capability being approved (e.g. "network", "create_pr"). */
  readonly capability: string;
  /** Destination / target of the capability (e.g. "registry.npmjs.org"). */
  readonly destination?: string;
  /** Scope of the approval: one-time, task-scoped, project-scoped. */
  readonly scope: ApprovalScope;
  /** Minimum authority level required to grant this approval. */
  readonly authorityLevel: ApprovalAuthorityLevel;
  readonly granted: boolean;
  readonly grantedAt?: ISODateString;
  readonly expiresAt?: ISODateString;
}

export type ApprovalScope = 'one-time' | 'task' | 'project';

/* ------------------------------------------------------------------ *
 * 10. ContextCapsule (DEC-020)
 * ------------------------------------------------------------------ */

/**
 * The isolated body of knowledge needed to reason about one
 * project/task/session. Each Project, Task, and Session owns its own
 * capsule at the appropriate boundary to ensure strict isolation (DEC-003,
 * DEC-020).
 *
 * The three scopes are modelled as a discriminated union so the compiler
 * enforces scope-specific content shapes.
 */
export type ContextCapsule = UserCapsule | ProjectCapsule | TaskCapsule | SessionCapsule;

/** Common fields for every capsule scope. */
interface ContextCapsuleBase {
  readonly id: EntityId;
  readonly scope: ContextCapsuleScope;
  /** Id of the owning Project / Task / Session. */
  readonly ownerId: EntityId;
  readonly createdAt: ISODateString;
  readonly updatedAt: ISODateString;
}

/**
 * Project Capsule: repository metadata, project-level policies, task list
 * summary. Persists across tasks.
 */
export interface ProjectCapsule extends ContextCapsuleBase {
  readonly scope: 'project';
  readonly content: ProjectCapsuleContent;
}

export interface ProjectCapsuleContent {
  readonly repoMetadata: RepoMetadata;
  readonly policies: ProjectPolicies;
  readonly taskListSummary: readonly TaskListSummaryEntry[];
}

export interface TaskListSummaryEntry {
  readonly taskId: EntityId;
  readonly objective: string;
  readonly state: TaskState;
}

/**
 * Task Capsule: objective, agent assignment, run history, deliverables,
 * rolled-up event summaries. Maps 1:1 with a git worktree in MVP.
 */
export interface TaskCapsule extends ContextCapsuleBase {
  readonly scope: 'task';
  readonly content: TaskCapsuleContent;
}

export interface TaskCapsuleContent {
  readonly objective: string;
  readonly agentIds: readonly EntityId[];
  readonly runHistory: readonly SessionRunSummary[];
  readonly deliverableIds: readonly EntityId[];
  readonly rolledUpEventSummaries: readonly string[];
}

export interface SessionRunSummary {
  readonly sessionId: EntityId;
  readonly status: SessionStatus;
  readonly startedAt: ISODateString;
  readonly endedAt?: ISODateString;
}

/**
 * Session Capsule: raw conversation, tool calls, event stream. Ephemeral;
 * summarized into the Task Capsule when the session ends.
 */
export interface SessionCapsule extends ContextCapsuleBase {
  readonly scope: 'session';
  readonly content: SessionCapsuleContent;
}

export interface SessionCapsuleContent {
  readonly conversation: readonly string[];
  readonly toolCalls: readonly string[];
  readonly eventIds: readonly EntityId[];
}

/**
 * User Capsule (issue #65, amends DEC-020): the user's durable preference
 * memories — natural-language routing preferences every project's manager
 * may see (global defaults). Per-project overrides stay on the Project
 * capsule's own preference entries (DEC-003 need-to-know).
 */
export interface UserCapsule extends ContextCapsuleBase {
  readonly scope: 'user';
  readonly content: UserCapsuleContent;
}

export interface UserCapsuleContent {
  /**
   * Natural-language preference lines, in the user's own words
   * (e.g. "Codex for long-running work", "never Opus on Claude").
   * The structured profile (rules + deny list) is the enforced half;
   * these lines are what managers read.
   */
  readonly preferenceNotes: readonly string[];
}

/* ------------------------------------------------------------------ *
 * Conversation — the single Secretary chat thread (issue #157)
 * ------------------------------------------------------------------ */

/**
 * A tool call recorded on an assistant chat message. Structurally
 * identical to the model-port wire `ToolCall`; the domain keeps its own
 * declaration so the hexagonal direction (`domain <- application`) holds —
 * the use-case layer maps between the two verbatim.
 */
export interface ConversationToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

/**
 * One persisted message in the single Secretary conversation.
 *
 * The `chat_messages` table is the conversation's append-only journal
 * (same no-update/no-delete trigger enforcement as `events`, DEC-012) —
 * the stored history IS the FlorinaLoop's memory, replayed verbatim into
 * each turn. `toolCalls`/`toolCallId`/`name`/`isError` carry the
 * tool-call records so assistant+tool turns round-trip losslessly.
 *
 * `role` mirrors the model-port wire roles; `system` is persisted for
 * completeness but the daemon never accepts it from a client command —
 * remote surfaces cannot inject system or assistant turns.
 */
export interface ConversationMessage {
  readonly id: EntityId;
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string | null;
  /** Tool calls the assistant requested on this message. */
  readonly toolCalls?: readonly ConversationToolCall[];
  /** For `role: 'tool'`: the call this message answers. */
  readonly toolCallId?: string;
  /** For `role: 'tool'`: the tool that produced the result. */
  readonly name?: string;
  /** For `role: 'tool'`: the call failed (still a valid result). */
  readonly isError?: boolean;
  readonly createdAt: ISODateString;
}
