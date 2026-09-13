/**
 * CLI inbound adapter family (DEC-026, DEC-037, issue #93) — the
 * `secretary` / `asec` terminal surface: argv parsing, subcommand
 * dispatch, terminal formatters, and the daemon WebSocket client.
 */
export * from './client.js';
export * from './formatters.js';
export * from './deps.js';
export * from './cli.js';
