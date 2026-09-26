/**
 * Outbound adapters � canonical implementations of the core outbound ports
 * (DEC-037, issue #92).
 *
 * Each subtree adapts one outbound boundary: SQLite persistence, provider
 * agent runtimes, quota observation readers, file-backed preference
 * profiles, the OS credential vault, the LiteLLM model connector, and git
 * worktree/diff adapters.
 */
export * from './persistence/sqlite/index.js';
export * from './agents/index.js';
export * from './quota/index.js';
export * from './preferences/index.js';
export * from './credentials/index.js';
export * from './model/index.js';
export * from './git/index.js';
export * from './voice/index.js';
export * from './events/index.js';
export * from './security/index.js';
export * from './ideas/index.js';
export * from './projects/index.js';
