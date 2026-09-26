export * from './ports/index.js';
export * from './use-cases/index.js';

/*
 * Disambiguate `SessionConfig`: the agent-runtime port and the command-api
 * use case export different `SessionConfig` interfaces — the adapter-facing
 * run config versus the command-facing session config. Mirroring
 * `src/index.ts`, the command API's variant is the package-facing default;
 * the adapter variant stays importable as `AdapterSessionConfig` (and
 * directly from the agent-runtime port).
 */
export type { SessionConfig } from './use-cases/tasks/command-api.js';
export type { SessionConfig as AdapterSessionConfig } from './ports/outbound/agent-runtime.js';
