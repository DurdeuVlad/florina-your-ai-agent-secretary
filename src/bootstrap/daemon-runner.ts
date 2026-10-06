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
import { spawn } from 'node:child_process';

import { FlorinaDaemon, isPortInUse, DEFAULT_DAEMON_PORT, DEFAULT_MCP_PORT } from './daemon.js';
import { ensureLocalAuthToken } from '../adapters/outbound/credentials/local-auth-token.js';
import type { CredentialBackend } from '../adapters/outbound/credentials/os-credential-vault.js';
import type { SecretsVaultPort } from '../core/application/ports/outbound/secrets-vault.js';

/** Default PID file location (per-user OS temp dir). */
export const DEFAULT_PID_FILE = path.join(os.tmpdir(), 'florina.pid');

/** Default SQLite database path. */
export const DEFAULT_DB_PATH = path.join(os.homedir(), '.florina', 'florina.db');

/** How long `startDetached` waits for the child's port to bind. */
const DETACHED_START_TIMEOUT_MS = 15_000;
/** Readiness poll interval for `startDetached`. */
const DETACHED_POLL_MS = 200;
/** How long `stop` waits for the signaled process to actually exit. */
const STOP_DEATH_WAIT_MS = 5_000;

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
    // If a daemon is already running, refuse. A live pid only counts when
    // the port is bound too — otherwise it's a recycled pid on a stale
    // file, which we clean up and proceed past.
    const existing = this.readPid();
    if (existing !== undefined && isPidAlive(existing)) {
      // Port 0 is OS-assigned and unprobeable — the live pid is the only
      // evidence; a nonzero port must be bound to count as running.
      if (this.port === 0 || (await isPortInUse(this.port))) {
        throw new Error(`Daemon is already running (pid ${existing})`);
      }
      this.removePidFile();
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
   * Start the daemon as a detached child process and return once its
   * port is bound (issue #323). Used by `florina start --detach` so an
   * external agent or script can bring Florina up without keeping a
   * foreground process alive.
   *
   * The child re-invokes this CLI (`start`, foreground) so the whole
   * startup path is identical to an interactive start — it writes the
   * PID file with its own pid and installs signal handlers, so `stop`
   * and `status` work unchanged.
   *
   * Startup output is appended to `<dbDir>/daemon.log`; early child
   * exits and readiness timeouts surface as thrown errors naming the
   * log, never as silent success.
   *
   * Limitation: the child re-invokes this CLI with no argument plumbing,
   * so it always composes the *default* runner options. Callers using a
   * non-default port/dbPath/pidFile must pass an entrypoint that reads
   * those values itself (tests do via env vars).
   *
   * @param entrypoint script the child runs (defaults to this CLI's own
   *   argv[1]); tests pass a fixture path.
   * @returns the spawned pid and the log file startup output lands in.
   */
  async startDetached(
    entrypoint?: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<{ pid: number; logFile: string }> {
    if (await this.daemonAlreadyRunning()) {
      throw new Error('Daemon is already running — see `florina status`.');
    }

    const script = entrypoint ?? process.argv[1];
    if (script === undefined) {
      throw new Error('Cannot locate the CLI entrypoint to spawn a detached daemon.');
    }
    const logDir = path.dirname(this.dbPath);
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, 'daemon.log');
    // A stale pidfile must never satisfy readiness: record its mtime so
    // the loop below only accepts a file written after this spawn. (A
    // stale file can coincidentally name the new child's pid when the OS
    // recycles pids.)
    let stalePidfileMtime: number | undefined;
    try {
      stalePidfileMtime = fs.statSync(this.pidFile).mtimeMs;
    } catch {
      /* no existing pidfile */
    }
    const out = fs.openSync(logFile, 'a');
    const child = spawn(process.execPath, [script, 'start'], {
      detached: true,
      stdio: ['ignore', out, out],
      windowsHide: true,
      env: process.env,
    });
    fs.closeSync(out);
    child.unref();
    // Attach 'error' before checking pid — an async spawn failure emits
    // it later and an unhandled 'error' would crash this process.
    let spawnError: Error | undefined;
    child.on('error', (e) => {
      spawnError = e;
    });
    if (child.pid === undefined) {
      throw new Error(`Failed to spawn the daemon process — see ${logFile}`);
    }

    // Readiness = the pid file naming THIS child's pid. The child writes
    // it only after its daemon binds the port, so a foreign process or a
    // racing sibling can't satisfy it — and a stale file never carries
    // this pid. Death is re-checked at the moment of success because a
    // signal-killed child keeps exitCode null.
    const dead = () =>
      child.exitCode !== null || child.signalCode !== null || spawnError !== undefined;
    const timeoutMs = opts.timeoutMs ?? DETACHED_START_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (dead()) {
        throw new Error(
          spawnError !== undefined
            ? `Daemon spawn failed: ${spawnError.message}`
            : `Daemon exited during startup ` +
                `(code ${child.exitCode ?? `signal ${child.signalCode}`}) — see ${logFile}`,
        );
      }
      // The pidfile must name this child AND be a fresh write — a stale
      // file recycled onto this pid has the old mtime.
      if (this.readPid() === child.pid && !dead()) {
        const stale = stalePidfileMtime;
        let fresh = stale === undefined;
        if (!fresh) {
          try {
            fresh = fs.statSync(this.pidFile).mtimeMs > (stale as number);
          } catch {
            fresh = false;
          }
        }
        if (fresh) {
          return { pid: child.pid, logFile };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, DETACHED_POLL_MS));
    }
    // Don't orphan a wedged or merely-slow child — kill it so the caller
    // isn't left with an invisible half-started daemon.
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    throw new Error(
      `Daemon did not write its PID file within ${(timeoutMs / 1000).toFixed(1)}s ` +
        `(a slow daemon may still finish starting — check \`florina status\`) — see ${logFile}`,
    );
  }

  /**
   * Whether a daemon is running per the pid file, disambiguating a
   * recycled pid by requiring the port to be bound too. A live pid with
   * a free port is a stale file, not a running daemon.
   */
  private async daemonAlreadyRunning(): Promise<boolean> {
    const existing = this.readPid();
    if (existing !== undefined && isPidAlive(existing)) {
      // Port 0 is unprobeable — a live pidfile pid is the only evidence.
      if (this.port === 0 || (await isPortInUse(this.port))) {
        return true;
      }
      // Pid alive but port free: a recycled pid on a stale file, not a
      // daemon. Leave the file — the daemon's own start() removes stale
      // pid files before writing its own.
      return false;
    }
    return this.port !== 0 && (await isPortInUse(this.port));
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
    // Only signal the pid when the port is bound too — a live pid on a
    // stale file is likely a recycled pid owned by an unrelated process,
    // and we must never SIGTERM a stranger. Port 0 means OS-assigned:
    // unprobeable, so the pid is the only evidence available.
    if (this.port !== 0 && !(await isPortInUse(this.port))) {
      this.removePidFile();
      return false;
    }
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return false;
    }
    // Wait for actual death before unlinking — if the daemon's graceful
    // shutdown lingers, the file stays so a later `stop` can retry.
    const deadline = Date.now() + STOP_DEATH_WAIT_MS;
    while (Date.now() < deadline && isPidAlive(pid)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!isPidAlive(pid)) {
      this.removePidFile();
    }
    return true;
  }

  /**
   * Check whether the daemon is running. A live pidfile pid only counts
   * when the port is bound too — a live-but-unbound pid is a recycled
   * pid on a stale file, not this daemon.
   */
  async status(): Promise<DaemonStatus> {
    const pid = this.readPid();
    if (this.port === 0) {
      // OS-assigned port is unprobeable — the pidfile is the only
      // evidence, and a recycled pid can't be cross-checked away.
      if (pid !== undefined && isPidAlive(pid)) {
        return { running: true, pid, port: this.port };
      }
      if (pid !== undefined) {
        this.removePidFile();
      }
      return { running: false, port: this.port };
    }
    const portBound = await isPortInUse(this.port);
    if (pid !== undefined && isPidAlive(pid)) {
      if (portBound) {
        return { running: true, pid, port: this.port };
      }
      // Stale file naming a live but unrelated pid — drop it.
      this.removePidFile();
      return { running: false, port: this.port };
    }
    // Stale PID file — clean it up.
    if (pid !== undefined) {
      this.removePidFile();
    }
    // Fall back to the port probe in case the PID file is missing.
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
