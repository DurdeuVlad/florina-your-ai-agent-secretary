/**
 * MCP inbound adapter family (DEC-018, DEC-037, issue #63) — the tool
 * server surface manager agents drive. Managers dispatch workers only
 * through these tools; every call flows through the core
 * {@link ManagerToolService}, the typed command API, and the
 * CapacityRouter.
 */
export {
  createSecretaryMcpServer,
  runSecretaryMcpStdio,
  SECRETARY_MCP_SERVER_NAME,
  SECRETARY_MCP_SERVER_VERSION,
} from './secretary-mcp-server.js';
export {
  ManagerToolService,
  ManagerToolError,
} from '../../../core/application/use-cases/managers/manager-tools.js';
export type {
  ManagerToolDeps,
  ManagerTaskStore,
  ManagerWorktreePort,
  SpawnTaskInput,
  SpawnTaskResult,
} from '../../../core/application/use-cases/managers/manager-tools.js';
