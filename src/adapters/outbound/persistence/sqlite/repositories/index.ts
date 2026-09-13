/**
 * Repository classes for each domain object. Each repository wraps a
 * `better-sqlite3` connection with prepared statements for insert, getById,
 * listByScope, and update (except `EventRepository`, which is append-only).
 */
export { BaseRepository } from './base.js';
export { ProjectRepository } from './project.js';
export { TaskRepository } from './task.js';
export { AgentRepository } from './agent.js';
export { SessionRepository } from './session.js';
export { DeliverableRepository } from './deliverable.js';
export { EventRepository } from './event.js';
export { AttentionItemRepository } from './attention-item.js';
export { DecisionRepository } from './decision.js';
export { ApprovalRepository } from './approval.js';
export { ContextCapsuleRepository } from './context-capsule.js';
export { CompletionDigestRepository } from './completion-digest.js';
export type { ListDigestsOptions } from './completion-digest.js';
