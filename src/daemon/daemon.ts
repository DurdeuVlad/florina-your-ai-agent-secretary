/**
 * Secretary daemon -- the local control plane (DEC-008).
 *
 * The daemon is a long-running localhost WebSocket server that all four
 * surfaces (CLI, desktop, voice, remote) connect to. It owns:
 *
 * - Process lifecycle: start, stop, graceful shutdown on SIGINT/SIGTERM.
 * - Single-instance enforcement via a lockfile + port binding.
 * - A localhost-only WebSocket server (bound to 127.0.0.1, configurable
 *   port, default 17419).
 * - The typed control-plane API ({@link ControlPlaneApi}) and routing.
 * - The live event stream ({@link EventBus} / {@link EventStream}).
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

import { WebSocketServer, type WebSocket } from 'ws';

import {
  ApprovalRepository,
  AttentionItemRepository,
  CompletionDigestRepository,
  ContextCapsuleRepository,
  DecisionRepository,
  DeliverableRepository,
  EventRepository,
  ProjectRepository,
  SessionRepository,
  StorageDatabase,
  TaskRepository,
} from '../storage/index.js';
import type { SupervisorEvent } from '../domain/events.js';
import { ControlPlaneApi, dispatch, parseApiRequest } from './api.js';
import type { ApiRequest, ApiResponse } from './api.js';
import { CommandApi } from './command-api.js';
import type { Command, Response } from './command-api.js';
import { EventBus, EventStream } from './event-stream.js';
import { TaskStateMachine } from './task-lifecycle.js';
import { MetricsCollector } from './metrics.js';
import { WorktreeManager } from './worktree.js';
import { AttentionInbox } from '../attention/attention-inbox.js';
import { AttentionAggregator } from '../attention/attention-aggregator.js';
import { AdapterRegistry } from '../adapters/registry.js';
import { StubAdapter, STUB_ADAPTER_ID } from '../adapters/stub-adapter.js';
import { SessionManager } from './session-manager.js';
import { collectHealth } from './health.js';
import type { HealthStatus } from './health.js';

/** Default localhost port for the control plane (DEC-008). */
export const DEFAULT_DAEMON_PORT = 17419;

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
  /** When true, do not install SIGINT/SIGTERM handlers (useful for tests). */
  readonly installSignalHandlers?: boolean;
}

/** Daemon lifecycle states. */
export type DaemonState = 'stopped' | 'starting' | 'running' | 'stopping';

/** Events emitted by the SecretaryDaemon. */
export interface DaemonEvents {
  state: (state: DaemonState) => void;
  connection: (socket: WebSocket) => void;
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
    installSignalHandlers: boolean;
  };
  private state: DaemonState = 'stopped';
  private wss: WebSocketServer | null = null;
  private db: StorageDatabase | null = null;
  private api: ControlPlaneApi | null = null;
  private commandApi: CommandApi | null = null;
  private bus: EventBus | null = null;
  private stream: EventStream | null = null;
  private attentionInbox: AttentionInbox | null = null;
  private metricsCollector: MetricsCollector | null = null;
  private attentionAggregator: AttentionAggregator | null = null;
  private worktreeManager: WorktreeManager | null = null;
  private taskStateMachine: TaskStateMachine | null = null;
  private adapterRegistry: AdapterRegistry | null = null;
  private sessionManager: SessionManager | null = null;
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
      this.attentionAggregator = new AttentionAggregator(this.attentionInbox, this.bus);
      this.attentionAggregator.start();
      this.worktreeManager = new WorktreeManager({ taskRepository: repos.tasks });
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
      this.adapterRegistry.register(STUB_ADAPTER_ID, () => new StubAdapter(null));
      this.sessionManager = new SessionManager(this.bus);

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

      await this.listen();
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

  private listen(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const wss = new WebSocketServer({
        host: '127.0.0.1',
        port: this.options.port,
      });
      this.wss = wss;

      wss.on('connection', (socket) => this.handleConnection(socket));

      wss.on('error', (err) => {
        if (this.state === 'starting') {
          reject(err);
        } else {
          this.emit('error', err);
        }
      });

      wss.on('listening', () => {
        // If port 0 was requested, capture the OS-assigned port so callers
        // (notably tests) can connect to the actual bound port.
        const addr = wss.address();
        if (typeof addr === 'object' && addr !== null) {
          this.options.port = addr.port;
        }
        this.cleanups.push(() => this.closeServer());
        resolve();
      });
    });
  }

  private closeServer(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.wss) {
        resolve();
        return;
      }
      const wss = this.wss;
      this.wss = null;
      wss.close(() => resolve());
    });
  }

  private handleConnection(socket: WebSocket): void {
    if (!this.stream || !this.api) {
      socket.close();
      return;
    }
    this.emit('connection', socket);

    // Register the socket with the event stream so it can subscribe/unsubscribe.
    const unregister = this.stream.register(socket);
    this.cleanups.push(unregister);

    socket.on('message', async (data) => {
      // Parse the raw JSON once so we can discriminate between the two
      // protocols that share this socket:
      //   - Command objects ({ kind: "start-task", ... })  → CommandApi
      //   - ApiRequest envelopes ({ id, method, params })  → ControlPlaneApi
      //   - Event-stream control messages ({ type: "subscribe" }) are
      //     handled by the EventStream's own listener installed via register.
      const text = typeof data === 'string' ? data : (data as Buffer).toString('utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        // Not valid JSON; let the event-stream listener handle control msgs.
        return;
      }

      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        typeof (parsed as { kind?: unknown }).kind === 'string'
      ) {
        // Command dispatch path (issue #33).
        const response = await this.routeCommand(parsed as Command);
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify(response));
        }
        return;
      }

      // Legacy ControlPlaneApi dispatch path.
      const request = parseApiRequest(data);
      if (!request) {
        // Not an API request; the event stream's own control-message
        // listener (installed via register) handles subscribe/unsubscribe.
        return;
      }
      const response = await this.routeApi(request);
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(response));
      }
    });

    socket.on('close', () => {
      unregister();
    });
    socket.on('error', () => {
      unregister();
    });
  }

  /**
   * Route a typed {@link Command} to the {@link CommandApi} and return its
   * {@link Response}. If the CommandApi is not wired (e.g. the daemon is
   * shutting down), an error response is returned instead.
   */
  private async routeCommand(command: Command): Promise<Response> {
    if (!this.commandApi) {
      return { ok: false, error: 'Daemon is not ready' };
    }
    return this.commandApi.execute(command);
  }

  private async routeApi(request: ApiRequest): Promise<ApiResponse<unknown>> {
    if (!this.api) {
      return {
        id: request.id,
        error: { code: 'not_ready', message: 'Daemon is not ready' },
      };
    }
    return dispatch(this.api, request);
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
    // Close server first so no new connections arrive.
    await this.closeServer();
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
