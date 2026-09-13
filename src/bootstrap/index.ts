/**
 * Bootstrap — the composition root (DEC-037, issue #93).
 *
 * The only place concrete inbound and outbound adapters are combined with
 * core use cases: the daemon process, the daemon runner's OS-level process
 * lifecycle, the CLI binary surface, and the voice session stack.
 */
export * from './daemon.js';
export * from './daemon-runner.js';
export * from './voice-session.js';
export * from './cli.js';
