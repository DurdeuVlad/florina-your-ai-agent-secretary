/**
 * Outbound adapters — canonical implementations of the core outbound ports
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
