#!/usr/bin/env node
/**
 * CLI entrypoint shim for the `secretary` / `asec` binary (DEC-026,
 * issue #20, DEC-037).
 *
 * The package.json `bin` entry stays at `dist/cli/index.js`. This shim
 * re-exports the canonical CLI surface and delegates `main` to the
 * bootstrap composition root — the real implementation lives in
 * `src/adapters/inbound/cli/` and `src/bootstrap/cli.ts`.
 */
import { main } from '../bootstrap/cli.js';

export { main } from '../bootstrap/cli.js';
export { parseArgs, runCli, VERSION } from '../adapters/inbound/cli/cli.js';
export { DaemonClient } from '../adapters/inbound/cli/client.js';
export { DaemonRunner } from '../bootstrap/daemon-runner.js';
export {
  formatInbox,
  formatTask,
  formatTaskList,
  formatDigest,
  formatMetrics,
} from '../adapters/inbound/cli/formatters.js';
export type { CompletionDigest } from '../core/application/use-cases/attention/completion-digest.js';

// When run as a script, execute main and set the exit code.
if (process.argv[1] !== undefined && import.meta.url.endsWith('cli/index.js')) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
