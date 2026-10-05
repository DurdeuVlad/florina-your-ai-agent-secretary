/**
 * Florina daemon -- the local control plane composition root (DEC-008,
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
  AgentRepository,
  ApprovalRepository,
  AttentionInboxSnapshotRepository,
  AttentionItemRepository,
  CapabilityGrantRepository,
  ChatMessageRepository,
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
import {
  attachLocalAgentProviders,
  makeCredentialProbe,
  refreshSkippedProviders,
  resolveProviderCommand,
  type LocalProviderAttachment,
} from './agent-providers.js';
import { ProviderReadiness } from '../core/application/use-cases/readiness/provider-readiness.js';
import { launchVisibleTerminal } from '../adapters/outbound/platform/terminal-launcher.js';
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
import {
  AttentionInbox,
  type AttentionInboxSnapshot,
} from '../core/application/use-cases/attention/attention-inbox.js';
import { reconcileJournalFailureItems } from '../core/application/use-cases/attention/journal-failure-reconcile.js';
import {
  AttentionAggregator,
  type ApprovalGate,
} from '../core/application/use-cases/attention/attention-aggregator.js';
import { GrantService } from '../core/application/use-cases/capabilities/grant-service.js';
import {
  EventJournalWriter,
  isPermanentJournalError,
} from '../core/application/use-cases/journal/event-journal-writer.js';
import { VerificationGate } from '../core/application/use-cases/verification/verification-gate.js';
import { ContextHealthMonitor } from '../core/application/use-cases/context/context-health-monitor.js';
import {
  IdeaService,
  type BriefDispatcherPort,
} from '../core/application/use-cases/ideas/idea-service.js';
import { ManagerToolService } from '../core/application/use-cases/managers/manager-tools.js';
import { FsIdeaLedger } from '../adapters/outbound/ideas/fs-idea-ledger.js';
import { BriefRepository } from '../adapters/outbound/persistence/sqlite/repositories/brief.js';
import { collectHealth } from '../core/application/use-cases/health.js';
import type { HealthStatus } from '../core/application/use-cases/health.js';
import { QuotaLedger } from '../core/application/use-cases/routing/quota-ledger.js';
import { CapacityRouter } from '../core/application/use-cases/routing/capacity-router.js';
import { FailoverService } from '../core/application/use-cases/tasks/failover.js';
import { DelegationService } from '../core/application/use-cases/federation/delegation.js';
import { RemoteFlorinaAdapter } from '../adapters/outbound/federation/remote-florina-adapter.js';
import { CapsuleRollupService } from '../core/application/use-cases/context/capsule-rollup.js';
import { PreferenceProfileStore } from '../adapters/outbound/preferences/json-preference-profile.js';
import { RepoRootsStore } from '../adapters/outbound/repos/json-repo-roots.js';
import { FsRepoScanner } from '../adapters/outbound/repos/fs-repo-scanner.js';
import { EncryptedFileSecretsVault } from '../adapters/outbound/credentials/encrypted-file-secrets-vault.js';
import {
  CredentialBroker,
  type CredentialBackend,
} from '../adapters/outbound/credentials/os-credential-vault.js';
import { SecretsVaultService } from '../core/application/use-cases/security/secrets-vault-service.js';
import type { SecretsVaultPort } from '../core/application/ports/outbound/secrets-vault.js';
import type { AttentionInboxStorePort } from '../core/application/ports/outbound/repositories.js';
import { FlorinaMcpHttpServer } from '../adapters/inbound/mcp/http-server.js';
import { managerServiceFactory } from './mcp-server.js';
import type { SupervisorEvent } from '../core/domain/events.js';

/** Default localhost port for the control plane (DEC-008). */
export const DEFAULT_DAEMON_PORT = 17419;

/** Default localhost port for the manager MCP HTTP surface (DEC-018). */
export const DEFAULT_MCP_PORT = 17420;

/** Default lockfile location (per-user OS temp dir). */
export const DEFAULT_LOCKFILE = path.join(os.tmpdir(), 'florina.lock');

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
   * Root directory for idea ledgers (DEC-033, issue #69). Defaults to
   * `ideas/` beside {@link dbPath}; required for `:memory:` databases
   * to be deterministic (falls back to an isolated tempdir).
   */
  readonly ideasDir?: string;
  /**
   * Localhost port for the manager MCP HTTP surface (DEC-018, issue #63).
   * Defaults to {@link DEFAULT_MCP_PORT}. Pass `null` to disable the MCP
   * server. Pass `0` for an OS-assigned port (tests).
   */
  readonly mcpPort?: number | null;
  /**
   * Preference profile JSON path backing the CapacityRouter (DEC-029).
   * Defaults to `~/.florina/preferences.json`.
   */
  readonly preferenceProfilePath?: string;
  /**
   * Repo-roots JSON path (issue #253) -- the folders the user keeps their
   * repos in, scanned for `set-repo-roots`/`query-repos`. Defaults to
   * `~/.florina/repo-roots.json`.
   */
  readonly repoRootsPath?: string;
  /** When true, do not install SIGINT/SIGTERM handlers (useful for tests). */
  readonly installSignalHandlers?: boolean;
  /**
   * Shared-secret auth for remote parents (DEC-036, issue #78). When
   * set, every control-plane connection must authenticate with
   * `{type:'auth', token}` before commands or subscription.
   */
  readonly authToken?: string;
  /**
   * Command kinds a remote connection may invoke (DEC-011). Unset →
   * all commands. A federated child typically scopes this to the
   * delegation surface (e.g. `delegate-task`, `stop-task`, `query-task`).
   */
  readonly allowedCommands?: readonly string[];
  /**
   * `florina.method.enabled` (issue #288) — when `false`, dispatched
   * prompts are sent without the Florina Method contract block and
   * `AgentStarted` journals the opt-out honestly. Default on. Reached
   * via `FLORINA_METHOD_ENABLED=0|false|off` on `florina daemon`.
   * Governs delegated dispatch only — the Secretary's own chat prompt
   * is governed by the `systemPrompt` composition seam instead.
   */
  readonly methodEnabled?: boolean;
  /**
   * Remote capacity pools (DEC-036): child daemons registered in the
   * adapter registry under `provider@host` ids so the router treats
   * them as provider capacity.
   */
  readonly remoteProviders?: readonly {
    readonly id: string;
    readonly host: string;
    readonly port: number;
    readonly projectId: string;
    readonly preferProvider?: string;
    readonly authToken?: string;
  }[];
  /**
   * Model connector config for Secretary chat turns (issue #158,
   * DEC-034): an OpenAI-compatible endpoint (LiteLLM proxy or direct).
   * When absent, `chat-send` still journals the user message but no
   * turn runs — the response says `turn: 'unavailable'`.
   */
  readonly chatModel?: {
    readonly baseUrl: string;
    readonly model: string;
    readonly apiKey?: string;
    /** Passed to the connector — e.g. `'none'` for models that reject tools with reasoning. */
    readonly reasoningEffort?: string;
  };
  /**
   * Secrets vault port override (issue #292). When absent the daemon
   * constructs an {@link EncryptedFileSecretsVault} whose file lives beside
   * {@link dbPath} (`secrets.enc`) with its master key held by a
   * {@link CredentialBroker} whose file store is `credentials/` beside
   * {@link dbPath} — test daemons with a temp dbPath get an isolated vault
   * automatically. Pass an injected port for tests that need full control.
   */
  readonly secretsVault?: SecretsVaultPort;
  /**
   * Credential backend for the vault's master key (issue #292). Defaults
   * to OS auto-detect; `'file'` keeps the key entirely inside the
   * daemon-local `credentials/` store — the right choice for headless
   * hosts and test daemons so no real OS keychain is touched. Forced to
   * `'file'` for `:memory:` databases regardless.
   */
  readonly secretsCredentialBackend?: CredentialBackend;
}

/** Daemon lifecycle states. */
export type DaemonState = 'stopped' | 'starting' | 'running' | 'stopping';

/** Events emitted by the FlorinaDaemon. */
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
 * const daemon = new FlorinaDaemon({ dbPath: './florina.db' });
 * await daemon.start();
 * // ... clients connect to ws://127.0.0.1:17419 ...
 * await daemon.stop();
 * ```
 */
/**
 * Coalescing window for attention-inbox snapshot saves (issue #272):
 * the leading mutation persists immediately, a burst lands one
 * trailing write this many milliseconds after the window opens.
 */
const INBOX_SAVE_DEBOUNCE_MS = 250;

/**
 * How many Resolved items the persisted inbox snapshot retains (issue
 * #272). Resolved items are audit history, not live state — capping
 * the tail keeps the single-row blob bounded on long-lived installs.
 */
const MAX_PERSISTED_RESOLVED_ITEMS = 100;

export class FlorinaDaemon extends EventEmitter {
  private readonly options: {
    port: number;
    lockfile: string;
    dbPath: string;
    mcpPort: number | null;
    preferenceProfilePath: string;
    repoRootsPath: string;
    installSignalHandlers: boolean;
    ideasDir?: string;
    authToken?: string;
    allowedCommands?: readonly string[];
    remoteProviders?: NonNullable<DaemonOptions['remoteProviders']>;
    chatModel?: DaemonOptions['chatModel'];
    methodEnabled: boolean;
    secretsVault?: SecretsVaultPort;
    secretsCredentialBackend?: CredentialBackend;
  };
  private state: DaemonState = 'stopped';
  private server: WebSocketControlPlaneServer | null = null;
  private mcpServer: FlorinaMcpHttpServer | null = null;
  private db: StorageDatabase | null = null;
  private api: ControlPlaneApi | null = null;
  private commandApi: CommandApi | null = null;
  private bus: EventBus | null = null;
  private stream: EventStream | null = null;
  private attentionInbox: AttentionInbox | null = null;
  /** Trailing-edge debounce timer for inbox snapshot saves (issue #272). */
  private inboxSaveTimer: NodeJS.Timeout | null = null;
  /** Whether a mutation arrived while the debounce window was open. */
  private inboxSaveDirty = false;
  /** The inbox snapshot store (issue #272); set while the daemon runs. */
  private attentionInboxSnapshots: AttentionInboxStorePort<AttentionInboxSnapshot> | null = null;
  private metricsCollector: MetricsCollector | null = null;
  private attentionAggregator: AttentionAggregator | null = null;
  private worktreeManager: GitWorktreeAdapter | null = null;
  private taskStateMachine: TaskStateMachine | null = null;
  private adapterRegistry: AdapterRegistry | null = null;
  private localProviders: LocalProviderAttachment | null = null;
  /** In-flight re-resolution — concurrent queries share one refresh. */
  private providerRefresh: Promise<LocalProviderAttachment | null> | null = null;
  private acceptingProviderRefresh = true;
  private providerReadiness: ProviderReadiness | null = null;
  private sessionManager: SessionManager | null = null;
  private quotaLedger: QuotaLedger | null = null;
  private preferenceStore: PreferenceProfileStore | null = null;
  private repoRootsStore: RepoRootsStore | null = null;
  private readonly repoScanner = new FsRepoScanner();
  private secretsVaultService: SecretsVaultService | null = null;
  /** Why vault wiring failed at startup — surfaced in command errors. */
  private secretsUnavailableReason: string | undefined;
  private failoverService: FailoverService | null = null;
  private capsuleRollup: CapsuleRollupService | null = null;
  private grantService: GrantService | null = null;
  private journalWriter: EventJournalWriter | null = null;
  private verificationGate: VerificationGate | null = null;
  private contextHealth: ContextHealthMonitor | null = null;
  private ideaService: IdeaService | null = null;
  private startedAt = 0;
  private lockFd: number | null = null;
  private signalHandlers: Array<() => void> = [];
  private readonly cleanups: Array<() => void> = [];

  constructor(options: DaemonOptions = {}) {
    super();
    this.options = {
      port: options.port ?? DEFAULT_DAEMON_PORT,
      lockfile: options.lockfile ?? DEFAULT_LOCKFILE,
      dbPath: options.dbPath ?? path.join(os.homedir(), '.florina', 'florina.db'),
      mcpPort: options.mcpPort === undefined ? DEFAULT_MCP_PORT : options.mcpPort,
      preferenceProfilePath:
        options.preferenceProfilePath ?? path.join(os.homedir(), '.florina', 'preferences.json'),
      repoRootsPath:
        options.repoRootsPath ?? path.join(os.homedir(), '.florina', 'repo-roots.json'),
      installSignalHandlers: options.installSignalHandlers ?? true,
      methodEnabled: options.methodEnabled !== false,
      ...(options.ideasDir !== undefined ? { ideasDir: options.ideasDir } : {}),
      ...(options.authToken !== undefined ? { authToken: options.authToken } : {}),
      ...(options.allowedCommands !== undefined
        ? { allowedCommands: options.allowedCommands }
        : {}),
      ...(options.remoteProviders !== undefined
        ? { remoteProviders: options.remoteProviders }
        : {}),
      ...(options.chatModel !== undefined ? { chatModel: options.chatModel } : {}),
      ...(options.secretsVault !== undefined ? { secretsVault: options.secretsVault } : {}),
      ...(options.secretsCredentialBackend !== undefined
        ? { secretsCredentialBackend: options.secretsCredentialBackend }
        : {}),
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
   * The wired context-health monitor (DEC-035, issue #77) — per-agent
   * window-fill snapshots for `florina status` and the fleet view.
   */
  get contextHealthMonitor(): ContextHealthMonitor | null {
    return this.contextHealth;
  }

  /**
   * The wired idea-ledger + Brief service (DEC-033, issue #69) —
   * ledgers, compiled Briefs, and the confirmed-gate dispatch path.
   */
  get ideas(): IdeaService | null {
    return this.ideaService;
  }

  /**
   * The `http://` URL managers register with their provider CLIs to reach
   * the Florina MCP tool surface, or `null` when the MCP server is
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
      // Restore the attention inbox from its durable snapshot (issue
      // #272): an in-memory-only inbox loses every item on restart —
      // critically the `JournalFailure` cards whose retained `writes[]`
      // are the ONLY copy of journal rows that never landed. Then hook
      // persistence so every successful mutation rewrites the snapshot.
      const inboxSnapshot = repos.attentionInboxSnapshots.load();
      try {
        this.attentionInbox =
          inboxSnapshot !== null ? AttentionInbox.restore(inboxSnapshot) : new AttentionInbox();
      } catch {
        // A snapshot that passed load()'s validation but still fails to
        // restore must not wedge boot — an empty inbox is the pre-#272
        // baseline, a crashed daemon is worse.
        this.attentionInbox = new AttentionInbox();
      }
      this.attentionInboxSnapshots = repos.attentionInboxSnapshots;
      this.attentionInbox.setMutationObserver(() => this.scheduleInboxSave());
      // Reconcile restored JournalFailure cards: retained rows that
      // landed while the daemon was down drop out of writes[]; a
      // fully-landed card resolves instead of re-offering a Retry with
      // nothing to do.
      const reconciled = reconcileJournalFailureItems(this.attentionInbox, repos.events);
      if (reconciled.landed > 0 || reconciled.resolved > 0) {
        console.error(
          `[florina] restored attention inbox: ${reconciled.landed} retained writes ` +
            `already landed, ${reconciled.resolved} cards resolved, ` +
            `${reconciled.surviving} still failing`,
        );
      }
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
      // Wire the verification gate (DEC-032, issue #68): a claimed
      // completion surfaces as done only with journaled proof. The gate
      // reads evidence persisted by the journal writer.
      this.verificationGate = new VerificationGate({
        journal: repos.events,
        // Lazy sink — the aggregator is constructed right after the
        // gate, so resolve it at failure time, not construction time.
        onJournalFailure: (err, row) => {
          this.attentionAggregator?.reportJournalFailure({
            source: 'verification-gate',
            error: err instanceof Error ? err.message : String(err),
            write: row,
            retryable: !isPermanentJournalError(err),
          });
        },
      });
      this.attentionAggregator = new AttentionAggregator(this.attentionInbox, this.bus, {
        approvalGate,
        verificationGate: this.verificationGate,
      });
      this.attentionAggregator.start();

      // Wire the bus→journal bridge (DEC-012): adapter observations —
      // test results, verification probes, file changes — are durable
      // evidence in the immutable journal, not just transient bus
      // traffic. Required by the verification gate (#68).
      this.journalWriter = new EventJournalWriter({
        journal: repos.events,
        bus: this.bus,
        // Journaling is best-effort: events for unregistered
        // tasks/sessions can't satisfy the journal's foreign keys and
        // must not break the publish pipeline. But silent is not honest
        // (issue #264): every failed write becomes a Needs-you item with
        // the retained row, retryable when the failure is transient.
        // 'error' is only emitted when a listener exists (emitting it
        // without one throws). This sink runs inside the publish
        // pipeline — it must never throw.
        onError: (err, _event, row) => {
          try {
            this.attentionAggregator?.reportJournalFailure({
              source: 'event-journal',
              error: err instanceof Error ? err.message : String(err),
              write: row,
              retryable: !isPermanentJournalError(err),
            });
          } catch {
            /* the failure sink itself must never break the pipeline */
          }
          try {
            if (this.listenerCount('error') > 0) this.emit('error', err);
          } catch {
            /* a throwing 'error' listener is contained too */
          }
        },
      });
      this.journalWriter.start();

      // Wire context-health tracking (DEC-035, issue #77): per-agent
      // window-fill estimates derived from usage reports and event
      // counts; a status transition publishes ContextHealthChanged —
      // journaled by the writer, elevated by the aggregator.
      this.contextHealth = new ContextHealthMonitor({ bus: this.bus });
      this.contextHealth.start();
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

      // Local provider attachment: probe the provider CLIs declared in
      // PROVIDER_MANIFESTS and register their real adapters so tasks
      // can route to them. Skipped providers are logged to the
      // journal-free stderr — daemon stdio is detached; the fleet view
      // (adapterRegistry.list()) is the user-visible surface.
      this.acceptingProviderRefresh = true;
      this.localProviders = await attachLocalAgentProviders(this.adapterRegistry);

      // Provider auth readiness (issue #294): cheap local evidence —
      // credential-file probe (lazy, re-read per query so a fresh
      // sign-in is seen without restart) + classified runtime failures
      // from dispatch, the bus (AgentFailed mid-run), and chat turns.
      // Auth/config-class failures raise one deduped inbox card.
      this.providerReadiness = new ProviderReadiness({
        credsProbe: makeCredentialProbe(),
        bus: this.bus,
        onAuthIssue: (issue) => {
          try {
            this.attentionAggregator?.reportProviderAuthIssue(issue);
          } catch {
            /* the inbox sink must never break a failure path */
          }
        },
      });
      this.providerReadiness.start();

      // Federated capacity pools (DEC-036, issue #78): each configured
      // child daemon registers under its `provider@host` id — the router
      // treats it as ordinary provider capacity.
      for (const remote of this.options.remoteProviders ?? []) {
        this.adapterRegistry.register(remote.id, () => {
          const adapter = new RemoteFlorinaAdapter(null, {
            id: remote.id,
            remote: {
              host: remote.host,
              port: remote.port,
              ...(remote.authToken !== undefined ? { authToken: remote.authToken } : {}),
            },
            projectId: remote.projectId,
            ...(remote.preferProvider !== undefined
              ? { preferProvider: remote.preferProvider }
              : {}),
          });
          return adapter;
        });
      }

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
        // Scoped secret injection at spawn time (issue #293). Resolved
        // lazily at session start — the vault service is constructed
        // later in this method, so the closure dereferences it at call
        // time. No vault (or an unwired one) → no injections. A vault
        // read failure degrades to no injection rather than breaking the
        // dispatch — but it is surfaced as an attention item so a vault
        // outage is never indistinguishable from "no matching secrets".
        secretEnvResolver: async (ctx) => {
          const service = this.secretsVaultService;
          if (service === null) {
            return undefined;
          }
          try {
            return await service.resolveInjections({
              taskId: ctx.taskId,
              sessionId: ctx.sessionId,
              provider: ctx.provider,
              projectId: ctx.projectId,
            });
          } catch (err) {
            try {
              this.attentionAggregator?.reportJournalFailure({
                source: 'secrets-injection',
                error: `secret resolution failed for task ${ctx.taskId}: ${err instanceof Error ? err.message : String(err)} — dispatch proceeds without injected secrets`,
                // No retained write to replay — retryable:false keeps the
                // card honest (a Retry verb would be a no-op).
                retryable: false,
              });
            } catch {
              /* the failure sink must never break dispatch */
            }
            return undefined;
          }
        },
      });

      // Idea ledger + Brief pipeline (DEC-033, issue #69): ledgers live
      // beside the daemon database; confirmed Briefs dispatch through
      // the same ManagerToolService spawn path the MCP surface uses —
      // the dispatcher resolves its deps lazily at confirm time.
      const briefDispatcher: BriefDispatcherPort = {
        spawnTask: (projectId, input) => {
          const project = repos.projects.getById(projectId);
          if (project === null) {
            return Promise.resolve({
              status: 'error' as const,
              error: `unknown project: ${projectId}`,
            });
          }
          const commandApi = this.commandApi;
          const quotaLedger = this.quotaLedger;
          const worktreeManager = this.worktreeManager;
          const preferenceStore = this.preferenceStore;
          if (
            commandApi === null ||
            quotaLedger === null ||
            worktreeManager === null ||
            preferenceStore === null
          ) {
            return Promise.resolve({
              status: 'error' as const,
              error: 'daemon not fully started',
            });
          }
          const router = new CapacityRouter({
            ledger: quotaLedger,
            profile: preferenceStore.toProfile(),
          });
          return new ManagerToolService({
            commandApi,
            router,
            taskStore: repos.tasks,
            worktreeManager,
            repoPath: project.repo.path,
            projectId,
            preferences: preferenceStore,
          }).spawnTask(input);
        },
      };
      // The quota ledger + preference profile must exist before the
      // command API is composed: brief dispatch routes through them and
      // `update-preference` mutates the store (DEC-029, issues #63/#73).
      this.quotaLedger = new QuotaLedger();
      this.preferenceStore = await PreferenceProfileStore.load(this.options.preferenceProfilePath);
      this.repoRootsStore = await RepoRootsStore.load(this.options.repoRootsPath);

      this.ideaService = new IdeaService({
        ledger: new FsIdeaLedger(this.ideasRootDir()),
        briefs: repos.briefs,
        dispatcher: briefDispatcher,
      });

      // Secrets vault (issue #292, DEC-011/DEC-022): the #172 engine wired
      // into the command API so `secrets-*` commands reach real encrypted
      // storage. Default file locations follow the database directory so
      // temp-db daemons get isolated vaults; `:memory:` daemons get an
      // isolated tempdir (never the real ~/.florina vault). Construction
      // can hit the OS keychain — a failure degrades to the honest
      // "vault not wired" command response instead of failing daemon start.
      // Journal-write failures surface as attention items via the #264
      // sink convention — never throw here.
      const ephemeralSecrets = this.options.dbPath === ':memory:';
      try {
        const secretsDir = ephemeralSecrets
          ? fs.mkdtempSync(path.join(os.tmpdir(), 'florina-secrets-'))
          : path.dirname(this.options.dbPath);
        if (ephemeralSecrets) {
          // The whole vault — encrypted file, key material, audit log — is
          // throwaway state for memory-mode daemons; remove it on stop so
          // tests never litter key material into the shared tempdir.
          const dir = secretsDir;
          this.cleanups.push(() => {
            try {
              fs.rmSync(dir, { recursive: true, force: true });
            } catch {
              /* best effort — temp litter is not a stop failure */
            }
          });
        }
        const vaultAuditLog = path.join(secretsDir, 'secrets.audit.jsonl');
        const secretsVault =
          this.options.secretsVault ??
          new EncryptedFileSecretsVault({
            filePath: path.join(secretsDir, 'secrets.enc'),
            credentialBroker: new CredentialBroker({
              fileStoreDir: path.join(secretsDir, 'credentials'),
              // Memory-mode daemons are tests: force the file backend so
              // they never touch the real OS keychain (cmdkey/security)
              // with test master keys. An explicit option (headless
              // hosts, hermetic tests) wins otherwise.
              ...(this.options.secretsCredentialBackend !== undefined || ephemeralSecrets
                ? { backend: this.options.secretsCredentialBackend ?? 'file' }
                : {}),
            }),
          });
        this.secretsVaultService = new SecretsVaultService({
          vault: secretsVault,
          eventJournal: repos.events,
          eventBus: this.bus,
          onJournalFailure: (err, row) => {
            try {
              this.attentionAggregator?.reportJournalFailure({
                source: 'secrets-vault',
                error: err instanceof Error ? err.message : String(err),
                write: row,
                retryable: !isPermanentJournalError(err),
              });
            } catch {
              /* the failure sink must never break vault operations */
            }
          },
          // Vault-local audit ledger (issue #292): user-scope secret ops
          // carry no task/session context so the event journal's FK schema
          // can't hold them — provenance lands in an append-only JSONL
          // beside secrets.enc (who/what/when/scope, never values).
          auditSink: (entry) => {
            try {
              fs.appendFileSync(vaultAuditLog, JSON.stringify(entry) + '\n', {
                encoding: 'utf8',
                mode: 0o600,
              });
              // mode above only applies at file creation — re-assert so
              // a pre-existing loose-mode audit file is tightened too.
              try {
                fs.chmodSync(vaultAuditLog, 0o600);
              } catch {
                /* best effort on platforms without chmod */
              }
            } catch (err) {
              try {
                // No `write` row — the dropped entry targets the JSONL
                // audit ledger, not the event journal, so a journal
                // retry card must not try to re-insert it. Its metadata
                // (never values) rides in the error text instead.
                this.attentionAggregator?.reportJournalFailure({
                  source: 'secrets-vault-audit',
                  error:
                    `${err instanceof Error ? err.message : String(err)} ` +
                    `(dropped audit entry: ${JSON.stringify(entry)})`,
                  retryable: true,
                });
              } catch {
                /* the failure sink must never break vault operations */
              }
            }
          },
        });
      } catch (err) {
        // Broker/keychain unavailable (headless, locked keychain, missing
        // cmdkey) — secrets-* commands will honestly report the vault as
        // unwired rather than the daemon failing to start, and the
        // reason reaches the user through the error text.
        this.secretsVaultService = null;
        this.secretsUnavailableReason = err instanceof Error ? err.message : String(err);
      }

      // Federated delegation surface (DEC-036, issue #78): remote
      // parents delegate into this daemon through `delegate-task`. The
      // command API is resolved lazily — delegation delegates arrive
      // only after construction completes.
      const delegation = new DelegationService({
        commandApi: {
          execute: (cmd) => {
            const api = this.commandApi;
            if (api === null) {
              return Promise.resolve({ ok: false, error: 'daemon not started' });
            }
            return api.execute(cmd);
          },
        },
        router: () =>
          new CapacityRouter({
            ledger: this.quotaLedger ?? new QuotaLedger(),
            profile: this.preferenceStore?.toProfile() ?? { rules: [], denied: [] },
          }),
        taskStore: repos.tasks,
        worktreeManager: this.worktreeManager,
        projects: repos.projects,
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
        agentStore: repos.agents,
        adapterRegistry: this.adapterRegistry,
        sessionManager: this.sessionManager,
        completionDigestRepository: repos.completionDigests,
        contextHealth: this.contextHealth ?? undefined,
        ideas: this.ideaService,
        preferences: this.preferenceStore,
        repoRoots: this.repoRootsStore,
        repoScanner: this.repoScanner,
        delegation,
        quotaLedger: this.quotaLedger ?? undefined,
        // Onboarding/setup surface (issue #277): exposes which provider
        // CLIs the probe attached vs. skipped. Live accessor — each call
        // re-resolves providers previously skipped 'not-found' so a CLI
        // installed mid-run (e.g. `florina install`) shows up without a
        // restart (issue #301). Deduped: concurrent queries share one
        // refresh rather than racing a second app-server spawn.
        providerAttachment: async () => this.refreshLocalProviders(),
        providerReadiness: this.providerReadiness ?? undefined,
        // signin-provider launches the provider's own login in a visible
        // terminal (issue #294) — the spawn stays at the composition
        // boundary; core never touches child_process. The command's
        // leading executable is rewritten to the daemon-resolved path
        // when it matches a manifest executable: a provider found via a
        // beyond-PATH candidate (agy under %LOCALAPPDATA%, opencode in
        // ~/.opencode/bin, …) is invisible to the launcher's PATH
        // preflight, which would otherwise wrongly refuse sign-in for an
        // installed provider.
        terminalLauncher: (command) => this.launchProviderCommand(command),
        platform: process.platform,
        // Chat-model readiness (issue #294): configured/key-source/state
        // computed live — a vault key stored mid-run is seen immediately.
        chatModelStatus: async () => {
          const chatModel = this.options.chatModel;
          const configured = chatModel !== undefined;
          const vaultKey =
            this.secretsVaultService === null
              ? false
              : await this.secretsVaultService.hasProviderCredential({
                  envVarNames: ['FLORINA_LITELLM_KEY', 'OPENAI_API_KEY'],
                  providers: ['litellm', 'openai'],
                });
          const keySource =
            vaultKey === true
              ? 'vault'
              : chatModel?.apiKey !== undefined && chatModel.apiKey !== ''
                ? 'env'
                : 'none';
          const failure = this.providerReadiness?.lastFailure('chat-model');
          const state = !configured
            ? 'unconfigured'
            : failure !== undefined
              ? failure.failureClass === 'auth'
                ? 'auth-failing'
                : failure.failureClass === 'config'
                  ? 'misconfigured'
                  : failure.failureClass === 'network'
                    ? 'unreachable'
                    : 'unknown'
              : this.providerReadiness?.hasSucceeded('chat-model') === true
                ? 'ok'
                : 'unknown';
          return {
            configured,
            keySource,
            state,
            ...(failure !== undefined ? { detail: failure.detail } : {}),
          };
        },
        // Voice sessions report live state here (issue #131); it is
        // broadcast to subscribed surfaces as an ephemeral voice:state
        // push — session ephemera is not journaled.
        voiceStateSink: (report) => {
          this.stream?.broadcast({ type: 'voice:state', ...report });
        },
        // Secretary conversation (issue #157): the append-only store plus
        // a broadcast sink so every subscribed surface sees new journaled
        // messages no matter which client sent them.
        chatStore: repos.chatMessages,
        chatMessageSink: (message) => {
          this.stream?.broadcast({ type: 'chat:message', message });
        },
        // Florina Method (issue #288): `florina.method.enabled` opt-out.
        methodEnabled: this.options.methodEnabled,
        // Secrets vault (issue #292): `secrets-*` commands; null when the
        // keychain/broker was unreachable at start — handlers report the
        // vault as unwired honestly.
        secrets: this.secretsVaultService ?? undefined,
        secretsUnavailableReason: this.secretsUnavailableReason,
        onShutdown: () => {
          void this.stop();
        },
      });

      // Secretary chat turns (issue #158): the single conversation runs
      // the Florina loop on the configured model connector. Constructed
      // after the command API because its tools route back through it;
      // attached via setChatService. Without chatModel config, chat-send
      // still journals — the turn simply reports unavailable.
      if (this.options.chatModel !== undefined) {
        const { LiteLLMConnector } =
          await import('../adapters/outbound/model/litellm-connector.js');
        const { ChatService } = await import('../core/application/use-cases/chat/chat-service.js');
        const chatService = new ChatService({
          store: repos.chatMessages,
          // The connector resolves its API key per request (issue #293):
          // a key stored in the secrets vault (env var `FLORINA_LITELLM_KEY`
          // / `OPENAI_API_KEY`, or provider `litellm`/`openai` scope) is
          // picked up without a daemon restart and takes precedence over
          // the env-configured key — storing a fresh key is how the user
          // remediates a dead one.
          connector: new LiteLLMConnector({
            ...this.options.chatModel,
            apiKeyResolver: () =>
              this.secretsVaultService === null
                ? Promise.resolve(null)
                : this.secretsVaultService.resolveProviderCredential({
                    envVarNames: ['FLORINA_LITELLM_KEY', 'OPENAI_API_KEY'],
                    providers: ['litellm', 'openai'],
                  }),
          }),
          commandApi: this.commandApi,
          onMessage: (message) => {
            this.stream?.broadcast({ type: 'chat:message', message });
          },
          onEvent: (event) => {
            this.stream?.broadcast({ type: 'chat:event', event });
          },
          // Chat-model readiness (issue #294): classify turn outcomes so
          // a dead key/unreachable endpoint flips `chatModel.state` and
          // raises an inbox card instead of only failing this turn.
          onTurnError: (err) => this.providerReadiness?.recordFailure('chat-model', err),
          onTurnSuccess: () => this.providerReadiness?.recordSuccess('chat-model'),
        });
        this.commandApi.setChatService(chatService);
      }

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
        methodEnabled: this.options.methodEnabled,
      });

      // Wire the manager MCP surface (DEC-018, issue #63): an HTTP
      // transport on its own localhost port serving the per-project
      // manager tool service. Disabled when mcpPort is null.
      if (this.options.mcpPort !== null) {
        this.mcpServer = new FlorinaMcpHttpServer({
          port: this.options.mcpPort,
          serviceFactory: managerServiceFactory({
            commandApi: this.commandApi,
            taskStore: repos.tasks,
            worktreeManager: this.worktreeManager,
            quotaLedger: this.quotaLedger,
            preferenceStore: this.preferenceStore,
            projects: repos.projects,
            // Resolved lazily — the server binds after this factory is
            // composed, so the URL only exists post-start().
            mcpUrl: () => this.mcpUrl ?? undefined,
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
        ...(this.options.authToken !== undefined ? { authToken: this.options.authToken } : {}),
        ...(this.options.allowedCommands !== undefined
          ? { allowedCommands: this.options.allowedCommands }
          : {}),
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
   * Persist the attention inbox snapshot now (issue #272).
   *
   * Resolved items accumulate forever — bound the persisted tail so a
   * long-lived install doesn't rewrite an unbounded history blob on
   * every mutation. A failed save must not break the inbox — but
   * silent is not honest (same rule as the journal writer's onError
   * sink): nothing listens to 'error' in production, so the failure
   * also goes to stderr.
   */
  private saveInboxSnapshot(): void {
    if (this.attentionInbox === null || this.attentionInboxSnapshots === null) return;
    try {
      this.attentionInboxSnapshots.save(
        this.attentionInbox.snapshot({ maxResolved: MAX_PERSISTED_RESOLVED_ITEMS }),
      );
    } catch (err) {
      try {
        if (this.listenerCount('error') > 0) this.emit('error', err);
      } catch {
        /* a throwing 'error' listener is contained too */
      }
      console.error(
        `[florina] attention inbox snapshot save failed: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Leading + trailing debounce for inbox snapshot saves: the first
   * mutation persists immediately (a crash loses nothing before it), a
   * burst coalesces into one trailing write instead of one fsync per
   * mutation (a JournalFailure storm is exactly when this matters).
   */
  private scheduleInboxSave(): void {
    this.inboxSaveDirty = true;
    if (this.inboxSaveTimer !== null) return;
    this.inboxSaveDirty = false;
    this.saveInboxSnapshot();
    this.inboxSaveTimer = setTimeout(() => {
      this.inboxSaveTimer = null;
      if (this.inboxSaveDirty) {
        this.inboxSaveDirty = false;
        this.saveInboxSnapshot();
      }
    }, INBOX_SAVE_DEBOUNCE_MS);
    this.inboxSaveTimer.unref();
  }

  /** Clear the debounce timer and land any pending save (shutdown path). */
  private flushInboxSave(): void {
    if (this.inboxSaveTimer !== null) {
      clearTimeout(this.inboxSaveTimer);
      this.inboxSaveTimer = null;
    }
    if (this.inboxSaveDirty) {
      this.inboxSaveDirty = false;
      this.saveInboxSnapshot();
    }
    this.attentionInbox?.setMutationObserver(undefined);
    this.attentionInboxSnapshots = null;
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
      agents: new AgentRepository(raw),
      decisions: new DecisionRepository(raw),
      capsules: new ContextCapsuleRepository(raw),
      completionDigests: new CompletionDigestRepository(raw),
      capabilityGrants: new CapabilityGrantRepository(raw),
      briefs: new BriefRepository(raw),
      chatMessages: new ChatMessageRepository(raw),
      attentionInboxSnapshots: new AttentionInboxSnapshotRepository(raw),
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
          `Another Florina daemon is already running (pid ${pid}, lockfile ${this.options.lockfile})`,
        );
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Re-throw our own "already running" error; otherwise continue.
        if (err instanceof Error && err.message.startsWith('Another Florina')) {
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

  /**
   * Ideas root for the {@link FsIdeaLedger} (DEC-033, issue #69):
   * `ideas/` beside the database file. For `:memory:` databases (tests)
   * each daemon gets an isolated tempdir so ledgers never leak across
   * daemon instances or into the repo working tree.
   */
  private ideasRootDir(): string {
    if (this.options.ideasDir !== undefined) {
      return this.options.ideasDir;
    }
    const dbPath = this.options.dbPath;
    if (dbPath === ':memory:') {
      return fs.mkdtempSync(path.join(os.tmpdir(), 'florina-ideas-'));
    }
    return path.join(path.dirname(dbPath), 'ideas');
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
    // Kill provider helper processes (codex app-server) after sessions stop.
    // A query can race `stop` — an in-flight refresh resolving after this
    // point would write a fresh attachment (with its own spawned children)
    // onto a stopped daemon and orphan them. Null the snapshot first so no
    // new refresh can start, then drain any in-flight one and dispose its
    // result (flat children list → one loop kills them all).
    this.acceptingProviderRefresh = false;
    const inFlightRefresh = this.providerRefresh;
    this.localProviders?.dispose();
    this.localProviders = null;
    if (inFlightRefresh !== null) {
      try {
        (await inFlightRefresh)?.dispose();
      } catch {
        // refresh failed mid-shutdown — nothing new was attached
      }
      this.localProviders = null;
    }
    this.providerReadiness?.stop();
    this.providerReadiness = null;
    if (this.attentionAggregator) {
      this.attentionAggregator.stop();
      this.attentionAggregator = null;
      this.journalWriter?.stop();
      this.journalWriter = null;
      this.contextHealth?.stop();
      this.contextHealth = null;
      this.ideaService = null;
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
    // Flush any debounced inbox snapshot write before the db close
    // cleanup runs (issue #272): a mutation inside the debounce window
    // must still land durably on shutdown.
    this.flushInboxSave();
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
    this.repoRootsStore = null;
    this.failoverService = null;
    this.capsuleRollup = null;
    this.secretsVaultService = null;
    this.secretsUnavailableReason = undefined;
    this.grantService = null;
    this.verificationGate = null;
  }

  private setState(state: DaemonState): void {
    this.state = state;
    this.emit('state', state);
  }

  /**
   * The provider attachment seen by query-providers — re-resolving
   * 'not-found' skips on every call so a CLI installed mid-run shows up
   * without a restart (issue #301). Concurrent callers share one
   * in-flight refresh so codex's app-server can't be spawned twice.
   */
  private refreshLocalProviders(): Promise<LocalProviderAttachment | null> {
    // `acceptingProviderRefresh` closes the cleanup drain gap — after
    // cleanup() snapshots the in-flight refresh, a late query must not
    // start an untracked one whose spawned children would never dispose.
    if (
      !this.acceptingProviderRefresh ||
      this.adapterRegistry === null ||
      this.localProviders === null
    ) {
      return Promise.resolve(this.localProviders);
    }
    const registry = this.adapterRegistry;
    const current = this.localProviders;
    this.providerRefresh ??= refreshSkippedProviders(registry, current)
      .then((next) => {
        this.localProviders = next;
        return next;
      })
      .finally(() => {
        this.providerRefresh = null;
      });
    return this.providerRefresh;
  }

  /**
   * Launch a sign-in recipe's command in a visible terminal. When the
   * command's leading executable is a manifest provider executable, the
   * daemon's own resolved path is substituted — a provider attached via
   * a beyond-PATH candidate is invisible to `where`/`which`, so a bare
   * command would launch a terminal that can't find the binary (or get
   * refused outright by the launcher's PATH preflight).
   */
  private async launchProviderCommand(command: string): Promise<{ ok: boolean; detail: string }> {
    const attached = (await this.refreshLocalProviders())?.attached ?? [];
    return launchVisibleTerminal(resolveProviderCommand(command, attached));
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
