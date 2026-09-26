/**
 * Git adapters (DEC-024, issue #92): the Node git client implementing the
 * core GitClientPort, the concrete DiffAnalyzer wrapper, and the canonical
 * GitWorktreeAdapter implementing WorktreePort.
 */
export * from './node-git-client.js';
export * from './diff-analyzer.js';
export * from './worktree-manager.js';
