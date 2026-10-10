/**
 * ProcessCommandRunner — {@link CommandRunnerPort} over Node's
 * `child_process.exec` (issue #339).
 *
 * Declared verification commands run through the platform shell (cmd.exe
 * on Windows, /bin/sh elsewhere — the same convention `npm test`-style
 * commands assume). `exec`'s own timeout kills the child; a killed child
 * surfaces as `timedOut` so the journal records "ran out of time" rather
 * than a misleading non-zero exit code. Every outcome resolves — spawn
 * failures included — so the verification pipeline journals one honest
 * result per declared check.
 */
import { exec } from 'node:child_process';

import type {
  CommandResult,
  CommandRunnerPort,
} from '../../../core/application/ports/outbound/command-runner.js';

/** Output cap per stream — bounded so a runaway command cannot grow
 * daemon memory without limit. */
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;

export class ProcessCommandRunner implements CommandRunnerPort {
  run(command: string, cwd: string, timeoutMs: number): Promise<CommandResult> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: CommandResult): void => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };
      exec(
        command,
        { cwd, timeout: timeoutMs, maxBuffer: MAX_BUFFER_BYTES, windowsHide: true },
        (error, stdout, stderr) => {
          if (error === null) {
            finish({
              exitCode: 0,
              signal: null,
              stdout,
              stderr,
              timedOut: false,
              spawnFailed: false,
            });
            return;
          }
          // `killed` is set when exec itself terminated the child — for us
          // that only happens via the timeout option. A string `code`
          // (ENOENT, EACCES) means the process never really ran.
          const spawnFailed = typeof error.code === 'string';
          finish({
            exitCode: typeof error.code === 'number' ? error.code : null,
            signal: typeof error.signal === 'string' ? error.signal : null,
            stdout,
            stderr: spawnFailed && stderr === '' ? String(error.message) : stderr,
            timedOut: error.killed === true,
            spawnFailed,
          });
        },
      ).on('error', (err) => {
        // Spawn-level failure emitted on the ChildProcess — must be
        // consumed (unhandled 'error' throws) and reported as a result.
        finish({
          exitCode: null,
          signal: null,
          stdout: '',
          stderr: String(err),
          timedOut: false,
          spawnFailed: true,
        });
      });
    });
  }
}
