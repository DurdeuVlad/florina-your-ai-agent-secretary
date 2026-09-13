/**
 * Domain module — core domain objects: Project, Task, Agent, Session,
 * Deliverable, Event, AttentionItem, Decision, Approval, ContextCapsule
 * (DEC-004), plus enums, factory helpers, and the canonical SupervisorEvent
 * union (DEC-019).
 */
export * from './enums.js';
export * from './types.js';
export * from './factories.js';
export * from './capabilities.js';
export * from './policy.js';
export * from './approval.js';
export * from './grants.js';
export * from './events.js';
