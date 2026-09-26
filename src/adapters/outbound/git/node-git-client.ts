/**
 * NodeGitClient — Node.js {@link GitClientPort} implementation (issue #92).
 *
 * Runs `git` synchronously via `child_process.execSync` (`git` must be on
 * the PATH), mirroring the convention used across the worktree/diff
 * adapters. Shell quoting is owned here so no core or use-case code builds
 * shell strings.
 */
import { execSync } from 'node:child_process';

import type { GitClientPort } from '../../../core/application/ports/outbound/git-client.js';

/** Synchronous git plumbing via `execSync`. */
export class NodeGitClient implements GitClientPort {
  /**
   * Run `git <args>` in `cwd` and return stdout.
   *
   * @throws When git exits with a non-zero status. The stderr is included in
   *         the error message for diagnostics.
   */
  run(args: readonly string[], cwd: string): string {
    const result = execSync(`git ${args.map(shellQuote).join(' ')}`, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return result;
  }
}

/**
 * Quote a single argument for the POSIX/Windows shell so paths and branch
 * names with spaces or special characters are passed verbatim to git.
 */
export function shellQuote(arg: string): string {
  // Wrap in double quotes and escape any embedded double quotes and
  // backslashes. This is sufficient for both cmd.exe and POSIX shells for
  // the argument shapes git accepts here.
  return `"${arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
