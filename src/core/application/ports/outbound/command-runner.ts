/**
 * CommandRunnerPort — deterministic shell-command boundary (issue #339).
 *
 * Verification checks declared on a task are objective evidence only when
 * Florina runs them — an agent's claim that "tests pass" is a claim, not a
 * fact (DEC-032). Core use cases describe the command and working
 * directory; the concrete adapter owns process spawning, timeout
 * enforcement, and output capture. Every outcome resolves as a
 * {@link CommandResult} — including spawn failure — so a failing check is
 * journaled as evidence rather than thrown through the caller.
 */
export interface CommandResult {
  /** Process exit code; `null` when killed, or when no process ran. */
  readonly exitCode: number | null;
  /** Signal that terminated the process, when killed (`SIGTERM`, …). */
  readonly signal: string | null;
  /** Captured standard output (truncated at the adapter's buffer cap). */
  readonly stdout: string;
  /** Captured standard error (truncated at the adapter's buffer cap). */
  readonly stderr: string;
  /** `true` when the command exceeded the allowed run time and was killed. */
  readonly timedOut: boolean;
  /**
   * `true` when the process could not be spawned at all (bad cwd, missing
   * shell) — the check never ran; `exitCode` is `null`.
   */
  readonly spawnFailed: boolean;
}

export interface CommandRunnerPort {
  /**
   * Run `command` in `cwd` through the platform shell, killing it after
   * `timeoutMs`. Always resolves — a non-zero exit, timeout, or spawn
   * failure is a check result, not an exception.
   */
  run(command: string, cwd: string, timeoutMs: number): Promise<CommandResult>;
}
