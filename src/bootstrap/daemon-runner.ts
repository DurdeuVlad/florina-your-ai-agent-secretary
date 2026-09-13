/**
 * DaemonRunner — manages the Secretary daemon process lifecycle (#20,
 * DEC-037).
 *
 * The CLI uses this to start, stop, and inspect the daemon. For MVP the
 * daemon runs in-process (the CLI process becomes the daemon) when `start`
 * is invoked; a PID file is written so subsequent `status` / `stop` calls
 * can locate and manage it. The design is forward-compatible with forking
 * a child process — the {@link DaemonRunner.start} method accepts a `fork`
 * flag, but defaults to in-process for simplicity.
 *
 * This is a bootstrap module: it composes the {@link SecretaryDaemon}
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

import { SecretaryDaemon, isPortInUse, DEFAULT_DAEMON_PORT } from './daemon.js';

/** Default PID file location (per-user OS temp dir). */
export const DEFAULT_PID_FILE = path.join(os.tmpdir(), 'agent-secretary.pid');

/** Default SQLite database path. */
export const DEFAULT_DB_PATH = path.join(os.homedir(), '.agent-secretary', 'secretary.db');

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
 * Manages the Secretary daemon lifecycle from the CLI.
 *
 * The runner holds an optional in-process {@link SecretaryDaemon} reference
 * so `stop` can shut down a daemon started in the same process. For daemons
 * started in a separate process (future), `stop` signals the PID directly.
 */
export class DaemonRunner {
  private readonly pidFile: string;
  private readonly port: number;
  private readonly dbPath: string;
  private readonly lockfile: string;
  private daemon: SecretaryDaemon | null = null;

  constructor(options: DaemonRunnerOptions = {}) {
    this.pidFile = options.pidFile ?? DEFAULT_PID_FILE;
    this.port = options.port ?? DEFAULT_DAEMON_PORT;
    this.dbPath = options.dbPath ?? DEFAULT_DB_PATH;
    this.lockfile = options.lockfile ?? path.join(os.tmpdir(), 'agent-secretary.lock');
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

    this.daemon = new SecretaryDaemon({
      port: this.port,
      dbPath: this.dbPath,
      lockfile: this.lockfile,
      installSignalHandlers: true,
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
  get inProcessDaemon(): SecretaryDaemon | null {
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
