/**
 * Persistence repository ports — the core-owned outbound contracts for the
 * domain stores (DEC-012, DEC-020, DEC-037).
 *
 * Use cases read and mutate domain objects exclusively through these
 * interfaces; persistence adapters satisfy them and tests substitute
 * in-memory implementations. Methods are synchronous because that is the
 * current application contract — transitions and journal appends must apply
 * immediately and in-process, in a defined order, before the use case
 * proceeds.
 */
import type {
  Agent,
  Approval,
  AttentionItem as DomainAttentionItem,
  ContextCapsule,
  ConversationMessage,
  Decision,
  Deliverable,
  EntityId,
  Event,
  ISODateString,
  Project,
  Session,
  Task,
} from '../../../domain/types.js';
import type { ContextCapsuleScope } from '../../../domain/enums.js';
import type { CapabilityGrant } from '../../../domain/grants.js';
import type { Brief } from '../../../domain/ideas.js';

/** Task store (DEC-004). */
export interface TaskRepositoryPort {
  insert(task: Task): void;
  getById(id: EntityId): Task | null;
  listByProject(projectId: EntityId): Task[];
  listAll(): readonly Task[];
  update(task: Task): void;
}

/** Immutable event journal (DEC-012). */
export interface EventJournalPort {
  insert(event: Event): void;
  getById(id: EntityId): Event | null;
  listByTask(taskId: EntityId): Event[];
  listBySession(sessionId: EntityId): Event[];
  listByTimestampRange(start: string, end: string): Event[];
}

/** Approval store. */
export interface ApprovalRepositoryPort {
  insert(approval: Approval): void;
  getById(id: EntityId): Approval | null;
  listByTask(taskId: EntityId): Approval[];
  update(approval: Approval): void;
}

/**
 * Capability grant store (DEC-010/011, issue #67). Grants are durable,
 * journaled scope records; revocation sets `revokedAt` via {@link update}
 * — grants are never deleted.
 */
export interface CapabilityGrantRepositoryPort {
  insert(grant: CapabilityGrant): void;
  getById(id: EntityId): CapabilityGrant | null;
  /** All grants for a project (active and revoked — audit surface). */
  listByProject(projectId: EntityId): CapabilityGrant[];
  /** Task-scoped grants for a task. */
  listByTask(taskId: EntityId): CapabilityGrant[];
  update(grant: CapabilityGrant): void;
}

/** Session (run) store. */
export interface SessionRepositoryPort {
  insert(session: Session): void;
  getById(id: EntityId): Session | null;
  listByTask(taskId: EntityId): Session[];
  update(session: Session): void;
  delete(id: EntityId): void;
}

/** Agent (provider runtime) store — backs the sessions.agent_id FK. */
export interface AgentRepositoryPort {
  insert(agent: Agent): void;
  getById(id: EntityId): Agent | null;
}

/** Context Capsule store (DEC-020). */
export interface ContextCapsuleRepositoryPort {
  insert(capsule: ContextCapsule): void;
  getById(id: EntityId): ContextCapsule | null;
  loadByScope(scope: ContextCapsuleScope, ownerId: EntityId): ContextCapsule | null;
  listByScope(scope: ContextCapsuleScope): ContextCapsule[];
  update(capsule: ContextCapsule): void;
  unloadByScope(scope: ContextCapsuleScope, ownerId: EntityId): number;
}

/** Decision Ledger store (read surface used by context resolution). */
export interface DecisionRepositoryPort {
  listByTask(taskId: EntityId): Decision[];
}

/** Project store (DEC-004). */
export interface ProjectRepositoryPort {
  insert(project: Project): void;
  getById(id: EntityId): Project | null;
  listAll(): Project[];
  update(project: Project): void;
}

/**
 * Persisted attention-item store (DEC-014). The domain {@link AttentionItem}
 * projection is aliased to distinguish it from the in-memory inbox item the
 * attention engine manages.
 */
export interface AttentionRecordRepositoryPort {
  insert(item: DomainAttentionItem): void;
  getById(id: EntityId): DomainAttentionItem | null;
  listByTask(taskId: EntityId): DomainAttentionItem[];
  listByResolved(resolved: boolean): DomainAttentionItem[];
  update(item: DomainAttentionItem): void;
}

/** Deliverable store (DEC-004). */
export interface DeliverableRepositoryPort {
  insert(deliverable: Deliverable): void;
  getById(id: EntityId): Deliverable | null;
  listByTask(taskId: EntityId): Deliverable[];
  listBySession(sessionId: EntityId): Deliverable[];
  update(deliverable: Deliverable): void;
}

/**
 * Brief store (DEC-033, issue #69). Compiled Briefs and their
 * confirmation record — the journaled gate decision (DEC-012). Briefs
 * are never deleted; status moves `draft` → `confirmed` → `dispatched`.
 */
export interface BriefRepositoryPort {
  insert(brief: Brief): void;
  getById(id: EntityId): Brief | null;
  /** All briefs compiled from an idea ledger. */
  listByIdea(ideaId: EntityId): Brief[];
  list(): Brief[];
  update(brief: Brief): void;
}

/**
 * Attention-inbox snapshot store (issue #272). The inbox's whole
 * serialized state is persisted as one opaque blob — generic over the
 * snapshot shape so the port stays decoupled from the inbox's
 * serialization (same rationale as {@link CompletionDigestRepositoryPort}).
 * Persisting the snapshot preserves the retained writes inside
 * `JournalFailure` cards — the only copy of journal rows that never
 * landed.
 */
export interface AttentionInboxStorePort<TSnapshot> {
  /** The last saved snapshot, or `null` when none has been persisted. */
  load(): TSnapshot | null;
  /** Replace the persisted snapshot atomically. */
  save(snapshot: TSnapshot): void;
}

/**
 * Completion digest store (issue #16/#37). Generic over the digest type so
 * the port stays decoupled from any one digest representation.
 */
export interface CompletionDigestRepositoryPort<TDigest> {
  save(digest: TDigest): string;
  findByTaskId(taskId: string): TDigest | null;
  findBySessionId(sessionId: string): TDigest | null;
  list(options?: { readonly limit?: number }): TDigest[];
}

/**
 * Secretary conversation store (issue #157). The single chat thread is
 * append-only like the events journal (DEC-012): the stored history IS
 * the FlorinaLoop's memory. `chat-clear` records a clear mark instead of
 * deleting rows — {@link listVisible} returns only messages after the
 * latest mark.
 */
export interface ChatMessageRepositoryPort {
  /** Append a message to the conversation journal. */
  append(message: ConversationMessage): void;
  /** Messages after the latest clear mark, oldest first. */
  listVisible(): ConversationMessage[];
  /** Full history including pre-clear messages (audit/inspection). */
  listAll(): ConversationMessage[];
  /** Record a clear mark; later `listVisible` calls exclude prior rows. */
  recordClear(at: ISODateString): void;
  /** The latest clear mark, if any. */
  latestClear(): ISODateString | null;
}
