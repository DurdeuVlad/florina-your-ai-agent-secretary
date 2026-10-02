/**
 * DaemonRunner — manages the Florina daemon process lifecycle (#20,
 * DEC-037).
 *
 * The CLI uses this to start, stop, and inspect the daemon. For MVP the
 * daemon runs in-process (the CLI process becomes the daemon) when `start`
 * is invoked; a PID file is written so subsequent `status` / `stop` calls
 * can locate and manage it. The design is forward-compatible with forking
 * a child process — the {@link DaemonRunner.start} method accepts a `fork`
 * flag, but defaults to in-process for simplicity.
 *
 * This is a bootstrap module: it composes the {@link FlorinaDaemon}
 * composition root with OS-level process management (PID files, signals).
 *
 * PID file management:
 * - On start, write `process.pid` to the PID file (overwriting stale ones).
 * - On stop, read the PID, signal the process, and remove the PID file.
 * - On status, read the PID and check whether the process is alive.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { FlorinaDaemon, isPortInUse, DEFAULT_DAEMON_PORT, DEFAULT_MCP_PORT } from './daemon.js';
import { ensureLocalAuthToken } from '../adapters/outbound/credentials/local-auth-token.js';
import type { CredentialBackend } from '../adapters/outbound/credentials/os-credential-vault.js';
import type { SecretsVaultPort } from '../core/application/ports/outbound/secrets-vault.js';

/** Default PID file location (per-user OS temp dir). */
export const DEFAULT_PID_FILE = path.join(os.tmpdir(), 'florina.pid');

/** Default SQLite database path. */
export const DEFAULT_DB_PATH = path.join(os.homedir(), '.florina', 'florina.db');

/** Options for constructing a {@link DaemonRunner}. */
export interface DaemonRunnerOptions {
  /** PID file path (defaults to {@link DEFAULT_PID_FILE}). */
  readonly pidFile?: string;
  /** Daemon port (defaults to {@link DEFAULT_DAEMON_PORT}). */
  readonly port?: number;
  /** SQLite database path (defaults to {@link DEFAULT_DB_PATH}). */
  readonly dbPath?: string;
  /** Lockfile path (defaults to the daemon's own default). */
  readonly lockfile?: string;
  /**
   * Manager MCP HTTP port (defaults to {@link DEFAULT_MCP_PORT}). Pass
   * `null` to disable the MCP surface, `0` for an OS-assigned port.
   */
  readonly mcpPort?: number | null;
  /**
   * Directory holding the local control-plane auth token (issue #118).
   * Defaults to `dirname(dbPath)` so a test temp database gets an isolated
   * token. Pass `null` to start the daemon without local auth (not
   * recommended — the control plane is then open to any local process).
   */
  readonly authTokenDir?: string | null;
  /**
   * Secrets-vault overrides forwarded to {@link FlorinaDaemon} (issue
   * #292): tests pass `secretsCredentialBackend: 'file'` (or an injected
   * vault) so a runner-started daemon never touches the real OS keychain.
   */
  readonly secretsVault?: SecretsVaultPort;
  readonly secretsCredentialBackend?: CredentialBackend;
}

/** Status snapshot returned by {@link DaemonRunner.status}. */
export interface DaemonStatus {
  /** Whether the daemon process is alive. */
  readonly running: boolean;
  /** PID of the daemon process, if known. */
  readonly pid?: number;
  /** Port the daemon is configured to listen on. */
  readonly port: number;
}

/**
 * Manages the Florina daemon lifecycle from the CLI.
 *
 * The runner holds an optional in-process {@link FlorinaDaemon} reference
 * so `stop` can shut down a daemon started in the same process. For daemons
 * started in a separate process (future), `stop` signals the PID directly.
 */
export class DaemonRunner {
  private readonly pidFile: string;
  private readonly port: number;
  private readonly dbPath: string;
  private readonly lockfile: string;
  private readonly mcpPort: number | null;
  private readonly authTokenDir: string | null;
  private readonly secretsVault?: SecretsVaultPort;
  private readonly secretsCredentialBackend?: CredentialBackend;
  private daemon: FlorinaDaemon | null = null;

  constructor(options: DaemonRunnerOptions = {}) {
    this.pidFile = options.pidFile ?? DEFAULT_PID_FILE;
    this.port = options.port ?? DEFAULT_DAEMON_PORT;
    this.dbPath = options.dbPath ?? DEFAULT_DB_PATH;
    this.lockfile = options.lockfile ?? path.join(os.tmpdir(), 'florina.lock');
    this.mcpPort = options.mcpPort === undefined ? DEFAULT_MCP_PORT : options.mcpPort;
    this.authTokenDir =
      options.authTokenDir === undefined ? path.dirname(this.dbPath) : options.authTokenDir;
    this.secretsVault = options.secretsVault;
    this.secretsCredentialBackend = options.secretsCredentialBackend;
  }

  /**
   * Start the daemon. For MVP the daemon runs in-process (this process
   * becomes the daemon and stays alive until stopped). A PID file is written
   * so other CLI invocations can find it.
   *
   * @returns the PID of the running daemon.
   */
  async start(): Promise<number> {
    // If a daemon is already running (by PID file or port), refuse.
    const existing = this.readPid();
    if (existing !== undefined && isPidAlive(existing)) {
      throw new Error(`Daemon is already running (pid ${existing})`);
    }
    if (await isPortInUse(this.port)) {
      throw new Error(`Port ${this.port} is already in use — is the daemon already running?`);
    }

    // Clean up a stale PID file before starting.
    this.removePidFile();

    // Secretary chat turns (issue #158): an OpenAI-compatible endpoint
    // (LiteLLM proxy or api.openai.com) from the same env vars the voice
    // surface uses. Absent config → chat still journals, turns report
    // unavailable.
    const chatModel =
      typeof process.env['FLORINA_LITELLM_URL'] === 'string' &&
      typeof process.env['FLORINA_MODEL'] === 'string'
        ? {
            baseUrl: process.env['FLORINA_LITELLM_URL']!,
            model: process.env['FLORINA_MODEL']!,
            ...(typeof process.env['FLORINA_LITELLM_KEY'] === 'string'
              ? { apiKey: process.env['FLORINA_LITELLM_KEY']! }
              : {}),
            ...(typeof process.env['FLORINA_REASONING_EFFORT'] === 'string'
              ? { reasoningEffort: process.env['FLORINA_REASONING_EFFORT']! }
              : {}),
          }
        : undefined;

    this.daemon = new FlorinaDaemon({
      port: this.port,
      dbPath: this.dbPath,
      lockfile: this.lockfile,
      mcpPort: this.mcpPort,
      installSignalHandlers: true,
      // Local control-plane auth (#118): provision a token so the socket
      // rejects unauthenticated commands. Surfaces read the same file.
      ...(this.authTokenDir !== null ? { authToken: ensureLocalAuthToken(this.authTokenDir) } : {}),
      ...(chatModel !== undefined ? { chatModel } : {}),
      // florina.method.enabled (#288): opt out of the dispatch-time
      // contract prepend with FLORINA_METHOD_ENABLED=0|false|off.
      methodEnabled: !['0', 'false', 'off', 'no', 'disabled'].includes(
        (process.env['FLORINA_METHOD_ENABLED'] ?? '').toLowerCase().trim(),
      ),
      ...(this.secretsVault !== undefined ? { secretsVault: this.secretsVault } : {}),
      ...(this.secretsCredentialBackend !== undefined
        ? { secretsCredentialBackend: this.secretsCredentialBackend }
        : {}),
    });
    await this.daemon.start();
    this.writePid(process.pid);
    return process.pid;
  }

  /**
   * Stop the daemon. If an in-process daemon is running, stop it directly.
   * Otherwise, read the PID file and signal that process.
   */
  async stop(): Promise<boolean> {
    if (this.daemon !== null) {
      await this.daemon.stop();
      this.daemon = null;
      this.removePidFile();
      return true;
    }

    const pid = this.readPid();
    if (pid === undefined) {
      return false;
    }
    if (!isPidAlive(pid)) {
      this.removePidFile();
      return false;
    }
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return false;
    }
    this.removePidFile();
    return true;
  }

  /**
   * Check whether the daemon is running. Looks at the PID file and verifies
   * the process is alive, then confirms the port is bound.
   */
  async status(): Promise<DaemonStatus> {
    const pid = this.readPid();
    if (pid !== undefined && isPidAlive(pid)) {
      return { running: true, pid, port: this.port };
    }
    // Stale PID file — clean it up.
    if (pid !== undefined) {
      this.removePidFile();
    }
    // Fall back to a port probe in case the PID file is missing.
    const portBound = await isPortInUse(this.port);
    return { running: portBound, port: this.port };
  }

  /** The in-process daemon, if started in this process (for tests). */
  get inProcessDaemon(): FlorinaDaemon | null {
    return this.daemon;
  }

  /* ---------------------------------------------------------------- *
   * PID file management
   * ---------------------------------------------------------------- */

  /** Write the PID to the PID file. */
  private writePid(pid: number): void {
    const dir = path.dirname(this.pidFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.pidFile, String(pid), 'utf8');
  }

  /** Read the PID from the PID file, or `undefined` if missing/invalid. */
  readPid(): number | undefined {
    try {
      const content = fs.readFileSync(this.pidFile, 'utf8');
      const pid = Number.parseInt(content.trim(), 10);
      if (Number.isNaN(pid)) return undefined;
      return pid;
    } catch {
      return undefined;
    }
  }

  /** Remove the PID file if it exists. */
  private removePidFile(): void {
    try {
      fs.unlinkSync(this.pidFile);
    } catch {
      /* ignore — file may not exist */
    }
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
