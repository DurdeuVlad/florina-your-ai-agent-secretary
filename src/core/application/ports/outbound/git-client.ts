/**
 * GitClientPort — synchronous git plumbing boundary (DEC-037, issue #92).
 *
 * Core use cases that need git output (diff digests, worktree status)
 * describe the plumbing invocation; the concrete adapter owns subprocess
 * execution and shell quoting. Implementations are synchronous because
 * the application contract requires immediate results — the port does not
 * prescribe how `git` is reached.
 */
export interface GitClientPort {
  /**
   * Run `git <args>` in `cwd` and return stdout.
   *
   * @throws When git exits with a non-zero status; the adapter includes
   *         stderr in the error message for diagnostics.
   */
  run(args: readonly string[], cwd: string): string;
}
