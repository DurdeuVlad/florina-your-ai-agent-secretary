/**
 * Secretary daemon -- the local control plane composition root (DEC-008,
 * DEC-037, issue #93).
 *
 * The daemon is a long-running localhost WebSocket server that all four
 * surfaces (CLI, desktop, voice, remote) connect to. This module is the sole
 * composition root: it is the only place concrete inbound and outbound
 * adapters are combined with core use cases. It owns:
 *
 * - Process lifecycle: start, stop, graceful shutdown on SIGINT/SIGTERM.
 * - Single-instance enforcement via a lockfile + port binding.
 * - The inbound WebSocket control-plane server
 *   ({@link WebSocketControlPlaneServer}) and live event stream
 *   ({@link EventStream}), bound to 127.0.0.1 only.
 * - The core control-plane API ({@link ControlPlaneApi}) and command API
 *   ({@link CommandApi}) wired to the SQLite persistence adapters.
 * - The outbound in-memory {@link EventBus} shared by every component.
 * - A health check endpoint ({@link collectHealth}).
 *
 * Binding to 127.0.0.1 only means the control plane is never exposed to the
 * network in MVP (DEC-008). Remote surfaces will tunnel through an
 * authenticated relay in a later milestone.
 */
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  ApprovalRepository,
  AttentionItemRepository,
  CapabilityGrantRepository,
  CompletionDigestRepository,
  ContextCapsuleRepository,
  DecisionRepository,
  DeliverableRepository,
  EventRepository,
  ProjectRepository,
  SessionRepository,
  StorageDatabase,
  TaskRepository,
} from '../adapters/outbound/persistence/sqlite/index.js';
import { EventBus } from '../adapters/outbound/events/in-memory-event-bus.js';
import { GitWorktreeAdapter } from '../adapters/outbound/git/worktree-manager.js';
import { AdapterRegistry } from '../adapters/outbound/agents/registry.js';
import { StubAdapter, STUB_ADAPTER_ID } from '../adapters/outbound/agents/stub-adapter.js';
import { EventStream } from '../adapters/inbound/websocket/event-stream.js';
import {
  WebSocketControlPlaneServer,
  type WebSocketConnection,
} from '../adapters/inbound/websocket/control-plane-server.js';
import { ControlPlaneApi } from '../core/application/use-cases/control-plane/control-plane-api.js';
import { CommandApi } from '../core/application/use-cases/tasks/command-api.js';
import { TaskStateMachine } from '../core/application/use-cases/tasks/task-lifecycle.js';
import { SessionManager } from '../core/application/use-cases/tasks/session-manager.js';
import { MetricsCollector } from '../core/application/use-cases/metrics.js';
import { AttentionInbox } from '../core/application/use-cases/attention/attention-inbox.js';
import {
  AttentionAggregator,
  type ApprovalGate,
} from '../core/application/use-cases/attention/attention-aggregator.js';
import { GrantService } from '../core/application/use-cases/capabilities/grant-service.js';
import { collectHealth } from '../core/application/use-cases/health.js';
import type { HealthStatus } from '../core/application/use-cases/health.js';
import { QuotaLedger } from '../core/application/use-cases/routing/quota-ledger.js';
import { CapacityRouter } from '../core/application/use-cases/routing/capacity-router.js';
import { FailoverService } from '../core/application/use-cases/tasks/failover.js';
import { CapsuleRollupService } from '../core/application/use-cases/context/capsule-rollup.js';
import { PreferenceProfileStore } from '../adapters/outbound/preferences/json-preference-profile.js';
import { SecretaryMcpHttpServer } from '../adapters/inbound/mcp/http-server.js';
import { managerServiceFactory } from './mcp-server.js';
import type { SupervisorEvent } from '../core/domain/events.js';

/** Default localhost port for the control plane (DEC-008). */
export const DEFAULT_DAEMON_PORT = 17419;

/** Default localhost port for the manager MCP HTTP surface (DEC-018). */
export const DEFAULT_MCP_PORT = 17420;

/** Default lockfile location (per-user OS temp dir). */
export const DEFAULT_LOCKFILE = path.join(os.tmpdir(), 'agent-secretary.lock');

/** Daemon configuration. */
export interface DaemonOptions {
  /** Localhost port to bind. Defaults to {@link DEFAULT_DAEMON_PORT}. */
  readonly port?: number;
  /**
   * Filesystem path used for single-instance enforcement. Defaults to
   * {@link DEFAULT_LOCKFILE}.
   */
  readonly lockfile?: string;
  /** SQLite database path. Use `:memory:` for ephemeral (tests). */
  readonly dbPath?: string;
  /**
   * Localhost port for the manager MCP HTTP surface (DEC-018, issue #63).
   * Defaults to {@link DEFAULT_MCP_PORT}. Pass `null` to disable the MCP
   * server. Pass `0` for an OS-assigned port (tests).
   */
  readonly mcpPort?: number | null;
  /**
   * Preference profile JSON path backing the CapacityRouter (DEC-029).
   * Defaults to `~/.agent-secretary/preferences.json`.
   */
  readonly preferenceProfilePath?: string;
  /** When true, do not install SIGINT/SIGTERM handlers (useful for tests). */
  readonly installSignalHandlers?: boolean;
}

/** Daemon lifecycle states. */
export type DaemonState = 'stopped' | 'starting' | 'running' | 'stopping';

/** Events emitted by the SecretaryDaemon. */
export interface DaemonEvents {
  state: (state: DaemonState) => void;
  connection: (socket: WebSocketConnection) => void;
  error: (err: Error) => void;
}

/**
 * The local control-plane daemon.
 *
 * Usage:
 * ```ts
 * const daemon = new SecretaryDaemon({ dbPath: './secretary.db' });
 * await daemon.start();
 * // ... clients connect to ws://127.0.0.1:17419 ...
 * await daemon.stop();
 * ```
 */
export class SecretaryDaemon extends EventEmitter {
  private readonly options: {
    port: number;
    lockfile: string;
    dbPath: string;
    mcpPort: number | null;
    preferenceProfilePath: string;
    installSignalHandlers: boolean;
  };
  private state: DaemonState = 'stopped';
  private server: WebSocketControlPlaneServer | null = null;
  private mcpServer: SecretaryMcpHttpServer | null = null;
  private db: StorageDatabase | null = null;
  private api: ControlPlaneApi | null = null;
  private commandApi: CommandApi | null = null;
  private bus: EventBus | null = null;
  private stream: EventStream | null = null;
  private attentionInbox: AttentionInbox | null = null;
  private metricsCollector: MetricsCollector | null = null;
  private attentionAggregator: AttentionAggregator | null = null;
  private worktreeManager: GitWorktreeAdapter | null = null;
  private taskStateMachine: TaskStateMachine | null = null;
  private adapterRegistry: AdapterRegistry | null = null;
  private sessionManager: SessionManager | null = null;
  private quotaLedger: QuotaLedger | null = null;
  private preferenceStore: PreferenceProfileStore | null = null;
  private failoverService: FailoverService | null = null;
  private capsuleRollup: CapsuleRollupService | null = null;
  private grantService: GrantService | null = null;
  private startedAt = 0;
  private lockFd: number | null = null;
  private signalHandlers: Array<() => void> = [];
  private readonly cleanups: Array<() => void> = [];

  constructor(options: DaemonOptions = {}) {
    super();
    this.options = {
      port: options.port ?? DEFAULT_DAEMON_PORT,
      lockfile: options.lockfile ?? DEFAULT_LOCKFILE,
      dbPath: options.dbPath ?? path.join(os.homedir(), '.agent-secretary', 'secretary.db'),
      mcpPort: options.mcpPort === undefined ? DEFAULT_MCP_PORT : options.mcpPort,
      preferenceProfilePath:
        options.preferenceProfilePath ??
        path.join(os.homedir(), '.agent-secretary', 'preferences.json'),
      installSignalHandlers: options.installSignalHandlers ?? true,
    };
  }

  /** Current lifecycle state. */
  get currentState(): DaemonState {
    return this.state;
  }

  /** Whether the daemon is currently listening. */
  get isRunning(): boolean {
    return this.state === 'running';
  }

  /** The configured port. */
  get port(): number {
    return this.options.port;
  }

  /** Exposed for tests / adapters to publish events onto the bus. */
  get eventBus(): EventBus | null {
    return this.bus;
  }

  /** Exposed for tests / health probing. */
  get controlPlane(): ControlPlaneApi | null {
    return this.api;
  }

  /** Exposed for tests to inspect the wired CommandApi. */
  get commandPlane(): CommandApi | null {
    return this.commandApi;
  }

  /** Exposed for tests to inspect the wired AdapterRegistry. */
  get adapterRegistry$(): AdapterRegistry | null {
    return this.adapterRegistry;
  }

  /** Exposed for tests to inspect the wired SessionManager. */
  get sessionManager$(): SessionManager | null {
    return this.sessionManager;
  }

  /**
   * The wired failover service (issue #64). Quota readers and adapter error
   * paths call this to freeze a task and re-route it to a provider with
   * capacity; `resumeParkedTasks` brings parked work back when quota resets.
   */
  get failover(): FailoverService | null {
    return this.failoverService;
  }

  /**
   * The wired capsule rollup service (issue #76). Also usable directly for
   * periodic mid-session rollups of long-running tasks.
   */
  get rollup(): CapsuleRollupService | null {
    return this.capsuleRollup;
  }

  /**
   * The wired scoped-approval grant service (issue #67). Grants durable
   * capability scopes; auto-approves covered adapter requests.
   */
  get grants(): GrantService | null {
    return this.grantService;
  }

  /**
   * The `http://` URL managers register with their provider CLIs to reach
   * the Secretary MCP tool surface, or `null` when the MCP server is
   * disabled or not yet started (DEC-018, issue #63).
   */
  get mcpUrl(): string | null {
    return this.mcpServer?.isListening === true ? this.mcpServer.url : null;
  }

  /** Exposed for tests to inspect the wired QuotaLedger (DEC-029). */
  get quotaLedger$(): QuotaLedger | null {
    return this.quotaLedger;
  }

  /**
   * Start the daemon: acquire the single-instance lock, open the database,
   * and begin listening on the localhost WebSocket port.
   *
   * @throws if another instance is already running or the port is in use.
   */
  async start(): Promise<void> {
    if (this.state !== 'stopped') {
      throw new Error(`Daemon cannot start from state ${this.state}`);
    }
    this.setState('starting');

    try {
      this.acquireLock();
      this.openDatabase();
      this.bus = new EventBus();
      this.stream = new EventStream(this.bus);
      const repos = this.buildRepos();
      this.api = new ControlPlaneApi(repos, this.bus);

      // Wire the typed Command API (issue #33). The CommandApi shares the
      // same EventBus, storage repositories, and worktree manager as the
      // legacy ControlPlaneApi so both surfaces operate on identical state.
      this.attentionInbox = new AttentionInbox();
      this.metricsCollector = new MetricsCollector({
        inboxSizeProvider: () => this.attentionInbox?.size ?? 0,
        attentionItemsPendingProvider: () => this.attentionInbox?.pendingCount ?? 0,
      });
      this.metricsCollector.attach(this.bus);

      // Wire scoped approvals (issue #67): durable capability grants that
      // auto-approve adapter permission requests inside granted scopes.
      // The gate sits between ApprovalRequested and the inbox — a covered
      // request is auto-approved and journaled instead of producing an
      // approval card. Uncovered requests escalate normally. An
      // `ApprovalRequested` event means the adapter already escalated, so
      // the gate can only satisfy that — never widen a deny (DEC-011).
      this.grantService = new GrantService({
        grantStore: repos.capabilityGrants,
        journal: repos.events,
        eventBus: this.bus,
      });
      const grantService = this.grantService;
      const taskStoreForGrants = repos.tasks;
      const approvalGate: ApprovalGate = {
        evaluateApprovalRequest: (event) => {
          const task = taskStoreForGrants.getById(event.taskId);
          if (task === null) return 'escalate';
          return grantService.evaluate(event, {
            projectId: task.projectId,
            taskId: event.taskId,
            sessionId: event.sessionId,
            adapterFidelityTier: event.adapterFidelityTier,
            policyDecision: 'escalate',
          }).autoApproved
            ? 'auto-approved'
            : 'escalate';
        },
      };
      this.attentionAggregator = new AttentionAggregator(this.attentionInbox, this.bus, {
        approvalGate,
      });
      this.attentionAggregator.start();
      this.worktreeManager = new GitWorktreeAdapter();
      this.taskStateMachine = new TaskStateMachine(repos.tasks, repos.events);

      // Wire the adapter registry and session manager (issue #35). The
      // registry maps stable adapter ids to factories. The stub adapter is
      // registered by default for end-to-end pipeline testing; real
      // adapters (Codex, Claude Code) can be registered by callers. The
      // session manager owns the lifecycle of active agent sessions and
      // pipes adapter events onto the EventBus.
      this.adapterRegistry = new AdapterRegistry();
      // The stub factory creates adapters WITHOUT a direct bus reference so
      // the SessionManager is the sole event publisher (no duplicates).
      this.adapterRegistry.register(STUB_ADAPTER_ID, () => new StubAdapter());

      // Wire the capsule rollup pipeline (issue #76): when a session ends —
      // by stop/freeze or natural stream completion — its journal events are
      // folded into the Task Capsule's rolledUpEventSummaries. The hook is
      // awaited on the stop path so a failover briefing reads a settled
      // capsule (#64 synergy).
      this.capsuleRollup = new CapsuleRollupService({
        journal: repos.events,
        capsuleStore: repos.capsules,
        sessionStore: repos.sessions,
        eventBus: this.bus,
      });
      const rollup = this.capsuleRollup;
      this.sessionManager = new SessionManager(this.bus, {
        onSessionEnd: async (taskId, sessionId) => {
          await rollup.rollUpSession(taskId, sessionId);
        },
      });

      this.commandApi = new CommandApi({
        eventBus: this.bus,
        taskStateMachine: this.taskStateMachine,
        attentionInbox: this.attentionInbox,
        metricsCollector: this.metricsCollector,
        worktreeManager: this.worktreeManager,
        eventRepository: repos.events,
        taskStore: repos.tasks,
        approvalStore: repos.approvals,
        sessionStore: repos.sessions,
        adapterRegistry: this.adapterRegistry,
        sessionManager: this.sessionManager,
        completionDigestRepository: repos.completionDigests,
        onShutdown: () => {
          void this.stop();
        },
      });

      // Wire the quota ledger + preference profile that the CapacityRouter
      // (and through it every manager spawn) enforces (DEC-029, issue #63).
      this.quotaLedger = new QuotaLedger();
      this.preferenceStore = await PreferenceProfileStore.load(this.options.preferenceProfilePath);

      // Wire cross-provider failover (issue #64): freezes a task's session,
      // blocks it, re-routes through a freshly-built CapacityRouter (so
      // preference-profile edits apply at failover time), and resumes in the
      // same worktree with a Task-Capsule briefing — or parks until quota
      // returns.
      const quotaLedger = this.quotaLedger;
      const preferenceStore = this.preferenceStore;
      this.failoverService = new FailoverService({
        commandApi: this.commandApi,
        taskStateMachine: this.taskStateMachine,
        sessionManager: this.sessionManager,
        router: () =>
          new CapacityRouter({ ledger: quotaLedger, profile: preferenceStore.toProfile() }),
        taskStore: repos.tasks,
        eventBus: this.bus,
        journal: repos.events,
        capsuleStore: repos.capsules,
      });

      // Wire the manager MCP surface (DEC-018, issue #63): an HTTP
      // transport on its own localhost port serving the per-project
      // manager tool service. Disabled when mcpPort is null.
      if (this.options.mcpPort !== null) {
        this.mcpServer = new SecretaryMcpHttpServer({
          port: this.options.mcpPort,
          serviceFactory: managerServiceFactory({
            commandApi: this.commandApi,
            taskStore: repos.tasks,
            worktreeManager: this.worktreeManager,
            quotaLedger: this.quotaLedger,
            preferenceStore: this.preferenceStore,
            projects: repos.projects,
          }),
          onError: (err) => this.emit('error', err),
        });
        await this.mcpServer.start();
      }

      // The inbound WebSocket server owns the socket; the daemon re-emits
      // connection/error events for its own lifecycle surface.
      this.server = new WebSocketControlPlaneServer({
        port: this.options.port,
        commandApi: this.commandApi,
        controlPlaneApi: this.api,
        eventStream: this.stream,
        onConnection: (socket) => this.emit('connection', socket),
        onError: (err) => this.emit('error', err),
      });
      // If port 0 was requested, adopt the OS-assigned port.
      this.options.port = await this.server.start();
      this.startedAt = Date.now();
      this.setState('running');
      if (this.options.installSignalHandlers) {
        this.installHandlers();
      }
    } catch (err) {
      await this.cleanup();
      this.setState('stopped');
      throw err;
    }
  }

  /**
   * Stop the daemon gracefully: close the WebSocket server, close the
   * database, and release the single-instance lock.
   */
  async stop(): Promise<void> {
    if (this.state === 'stopped') {
      return;
    }
    this.setState('stopping');
    await this.cleanup();
    this.setState('stopped');
  }

  /**
   * Collect a {@link HealthStatus} snapshot. Throws if the daemon is not
   * running.
   */
  health(): HealthStatus {
    if (!this.db || !this.stream || !this.bus) {
      throw new Error('Daemon is not running');
    }
    return collectHealth(this.db, this.stream, this.bus, this.startedAt);
  }

  /**
   * Publish a validated SupervisorEvent onto the live stream. Adapters call
   * this after normalizing provider observations (DEC-019).
   */
  publishEvent(event: SupervisorEvent): number {
    if (!this.bus) {
      throw new Error('Daemon is not running');
    }
    return this.bus.publish(event);
  }

  /* ---------------------------------------------------------------- *
   * Internal helpers
   * ---------------------------------------------------------------- */

  private buildRepos() {
    if (!this.db) {
      throw new Error('Database not open');
    }
    const raw = this.db.connection;
    return {
      projects: new ProjectRepository(raw),
      tasks: new TaskRepository(raw),
      events: new EventRepository(raw),
      attention: new AttentionItemRepository(raw),
      approvals: new ApprovalRepository(raw),
      deliverables: new DeliverableRepository(raw),
      sessions: new SessionRepository(raw),
      decisions: new DecisionRepository(raw),
      capsules: new ContextCapsuleRepository(raw),
      completionDigests: new CompletionDigestRepository(raw),
      capabilityGrants: new CapabilityGrantRepository(raw),
    };
  }

  /**
   * Single-instance enforcement. We use a TCP server bound to the configured
   * port as the primary lock (the OS guarantees only one listener). A
   * lockfile is also written as a secondary marker so a crashed daemon can be
   * detected. If the port is already in use, we treat it as "another
   * instance is running" and throw.
   */
  private acquireLock(): void {
    // Secondary marker: write a lockfile with the current pid. If a stale
    // lockfile exists for a dead process, remove it first.
    try {
      const existing = fs.readFileSync(this.options.lockfile, 'utf8');
      const pid = Number.parseInt(existing.trim(), 10);
      if (Number.isNaN(pid) || !isPidAlive(pid)) {
        fs.unlinkSync(this.options.lockfile);
      } else {
        throw new Error(
          `Another Secretary daemon is already running (pid ${pid}, lockfile ${this.options.lockfile})`,
        );
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Re-throw our own "already running" error; otherwise continue.
        if (err instanceof Error && err.message.startsWith('Another Secretary')) {
          throw err;
        }
        // Other read errors: ignore and try to write our own lockfile.
      }
    }
    this.lockFd = fs.openSync(this.options.lockfile, 'wx');
    fs.writeSync(this.lockFd, String(process.pid));
    this.cleanups.push(() => this.releaseLock());
  }

  private releaseLock(): void {
    if (this.lockFd !== null) {
      try {
        fs.closeSync(this.lockFd);
      } catch {
        /* ignore */
      }
      this.lockFd = null;
    }
    try {
      fs.unlinkSync(this.options.lockfile);
    } catch {
      /* ignore */
    }
  }

  private openDatabase(): void {
    const dbPath = this.options.dbPath;
    if (dbPath !== ':memory:') {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    this.db = new StorageDatabase({ path: dbPath });
    this.db.open();
    this.cleanups.push(() => {
      if (this.db) {
        this.db.close();
        this.db = null;
      }
    });
  }

  private installHandlers(): void {
    const onSignal = (): void => {
      void this.stop();
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    this.signalHandlers.push(onSignal);
  }

  private removeHandlers(): void {
    for (const handler of this.signalHandlers) {
      process.off('SIGINT', handler);
      process.off('SIGTERM', handler);
    }
    this.signalHandlers = [];
  }

  private async cleanup(): Promise<void> {
    this.removeHandlers();
    // Stop all active adapter sessions before tearing down the bus so
    // adapters are cleanly cancelled/disconnected (issue #35).
    if (this.sessionManager) {
      await this.sessionManager.stopAll();
      this.sessionManager = null;
    }
    if (this.attentionAggregator) {
      this.attentionAggregator.stop();
      this.attentionAggregator = null;
    }
    if (this.metricsCollector) {
      this.metricsCollector.detach();
      this.metricsCollector = null;
    }
    if (this.stream) {
      this.stream.close();
      this.stream = null;
    }
    // Close the manager MCP surface before the control-plane server so no
    // in-flight tool call can touch torn-down state.
    if (this.mcpServer) {
      await this.mcpServer.stop();
      this.mcpServer = null;
    }
    // Close the server so no new connections arrive and every registered
    // connection is unwired from the event stream.
    if (this.server) {
      await this.server.stop();
      this.server = null;
    }
    // Run remaining cleanups (db close, lock release) in reverse order.
    while (this.cleanups.length > 0) {
      const cleanup = this.cleanups.pop();
      if (!cleanup) {
        continue;
      }
      try {
        cleanup();
      } catch {
        /* ignore cleanup errors */
      }
    }
    this.api = null;
    this.commandApi = null;
    this.bus = null;
    this.attentionInbox = null;
    this.worktreeManager = null;
    this.taskStateMachine = null;
    this.adapterRegistry = null;
    this.quotaLedger = null;
    this.preferenceStore = null;
    this.failoverService = null;
    this.capsuleRollup = null;
    this.grantService = null;
  }

  private setState(state: DaemonState): void {
    this.state = state;
    this.emit('state', state);
  }
}

/**
 * Check whether a process id is currently alive. Cross-platform: uses
 * `process.kill(pid, 0)` which does not actually send a signal.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Probe whether a localhost TCP port is already in use. Used by tests and by
 * the CLI to detect a running daemon without acquiring the lock.
 */
export function isPortInUse(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(true));
    tester.once('listening', () => {
      tester.close(() => resolve(false));
    });
    tester.listen(port, '127.0.0.1');
  });
}
