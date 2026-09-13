/**
 * Daemon module — the local control plane the Secretary runs on (DEC-008).
 *
 * Adapters, the attention engine, voice, and the desktop client all talk to
 * this daemon over localhost WebSocket. The daemon owns process lifecycle,
 * single-instance enforcement, the typed control-plane API, the live event
 * stream, and a health check endpoint.
 */
export { SecretaryDaemon, isPortInUse, DEFAULT_DAEMON_PORT, DEFAULT_LOCKFILE } from './daemon.js';
export type { DaemonOptions, DaemonState, DaemonEvents } from './daemon.js';
export { ControlPlaneApi, dispatch, parseApiRequest } from './api.js';
export type {
  ApiMethod,
  ApiRequest,
  ApiSuccessResponse,
  ApiErrorResponse,
  ApiError,
  ApiResponse,
  StartTaskParams,
  StartTaskResult,
  StartTaskRequest,
  StartTaskResponse,
  GetInboxParams,
  GetInboxResult,
  GetInboxRequest,
  GetInboxResponse,
  GetStatusParams,
  GetStatusResult,
  GetStatusRequest,
  GetStatusResponse,
  ShowTaskParams,
  ShowTaskResult,
  ShowTaskRequest,
  ShowTaskResponse,
  ApprovePermissionParams,
  ApprovePermissionResult,
  ApprovePermissionRequest,
  ApprovePermissionResponse,
  DenyPermissionParams,
  DenyPermissionResult,
  DenyPermissionRequest,
  DenyPermissionResponse,
  StopTaskParams,
  StopTaskResult,
  StopTaskRequest,
  StopTaskResponse,
  GetDigestParams,
  GetDigestResult,
  GetDigestRequest,
  GetDigestResponse,
  SwitchProjectParams,
  SwitchProjectResult,
  SwitchProjectRequest,
  SwitchProjectResponse,
  ApiRepositories,
} from './api.js';
export { EventBus, EventStream, EventBusEvents } from './event-stream.js';
export type { EventStreamMessage, EventStreamControlMessage } from './event-stream.js';
export { collectHealth } from './health.js';
export type { HealthStatus } from './health.js';

/* Context Capsule routing & isolation (DEC-003, DEC-020) */
export { ContextStore } from './context-store.js';
export type { LoadRecord } from './context-store.js';
export { ScopeAccessError, validateScopeAccess, withContextBoundary } from './context-isolation.js';
export type { ScopedQuery } from './context-isolation.js';
export { ContextRouter, createContextRouter } from './context-router.js';
export type { CapsuleSource, GlobalAwareness, UnloadResult } from './context-router.js';

/* Credential / secret brokering (DEC-022) */
export { CredentialBroker } from './credential-broker.js';
export type {
  CredentialBackend,
  CredentialMetadata,
  StoredCredential,
  CredentialBrokerOptions,
} from './credential-broker.js';
export { CapabilityBroker } from './capability-broker.js';
export type {
  ActionExecutor,
  ActionResult,
  BrokerActionOutcome,
  ActionRegistration,
  ActionContext,
  CapabilityBrokerOptions,
} from './capability-broker.js';

/* Quota-aware capacity routing (DEC-029, issue #60) */
export { QuotaLedger } from './quota-ledger.js';
export type {
  QuotaSource,
  QuotaWindow,
  QuotaWindowStatus,
  ProviderQuotaState,
  QuotaLedgerOptions,
} from './quota-ledger.js';
export { CapacityRouter } from './capacity-router.js';
export type {
  RoutingRule,
  DenyRule,
  PreferenceProfile,
  RouteRequest,
  RouteResult,
  CapacityRouterOptions,
} from './capacity-router.js';

/* Runtime metrics instrumentation (DEC-015, issue #18) */
export { MetricsCollector, DEFAULT_HISTOGRAM_BUCKETS } from './metrics.js';
export type { MetricsCollectorOptions, MetricsSnapshot, HistogramSummary } from './metrics.js';

/* Attention Compression Ratio + supplemental metrics (DEC-015, issue #18) */
export {
  computeAttentionMetrics,
  MetricsQueryService,
  MetricsRecorder,
} from '../attention/attention-metrics.js';
export type {
  AttentionMetricsInput,
  AttentionMetricsReport,
  AttentionItemResolution,
  ApprovalExecutionPair,
  MetricsQueryOptions,
  MetricsQuerySources,
} from '../attention/attention-metrics.js';

/* Typed command API shared by CLI and voice (issue #19, DEC-002, DEC-026) */
export { CommandApi, executeCommand, COMMAND_KINDS } from './command-api.js';
export type {
  Command,
  Response,
  CommandResponse,
  StartTaskCommand,
  StopTaskCommand,
  ApproveCommand,
  QueryInboxCommand,
  AcknowledgeItemCommand,
  ResolveItemCommand,
  EscalateItemCommand,
  QueryMetricsCommand,
  QueryTaskCommand,
  ListTasksCommand,
  PruneWorktreeCommand,
  ShutdownCommand,
  GetDigestCommand,
  ApproveResponse,
  InboxResponse,
  ItemMutationResponse,
  MetricsResponse,
  TaskResponse,
  TaskListResponse,
  PruneResponse,
  ShutdownResponse,
  DigestResponse,
  UnknownCommandResponse,
  SessionConfig,
  InboxFilter,
  AttentionItemSnapshot,
  TaskSnapshot,
  CommandApiDeps,
  TaskStore,
  ApprovalStore,
  SessionStore,
} from './command-api.js';

/* Adapter session management (issue #35, DEC-005) */
export { SessionManager } from './session-manager.js';
export type { SessionInfo, StartSessionResult, StopSessionResult } from './session-manager.js';

/* Voice session management (DEC-021, DEC-002, issue #41) */
export { VoiceSessionManager, buildDefaultVoiceTools, mapToolCallToCommand, DEFAULT_VOICE_INSTRUCTIONS } from './voice-session-manager.js';
export type {
  VoiceSessionManagerOptions,
  CommandExecutor,
  VoiceTranscriptCallback,
  VoiceModeCallback,
  VoiceToolCallCallback,
  VoiceStateCallback,
} from './voice-session-manager.js';
