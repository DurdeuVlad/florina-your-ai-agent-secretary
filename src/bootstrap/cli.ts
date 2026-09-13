/**
 * CLI composition root (DEC-026, DEC-037, issue #93).
 *
 * Wires the inbound CLI adapter ({@link runCli}) to the concrete services
 * it drives: the {@link DaemonClient} WebSocket transport, the
 * {@link DaemonRunner} process manager, and the voice session factory.
 * This is the only place those combinations are made — the CLI adapter
 * itself only sees its injected dependency seams.
 */
import { DaemonClient } from '../adapters/inbound/cli/client.js';
import { runCli } from '../adapters/inbound/cli/cli.js';
import { DaemonRunner } from './daemon-runner.js';
import { createStdinVoiceSession } from './voice-session.js';

/**
 * CLI entry point. Parses argv, dispatches to a subcommand, and returns the
 * process exit code. Called by the `secretary` / `asec` binary shim at
 * `src/cli/index.ts`.
 */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
): Promise<number> {
  return runCli(argv, {
    client: new DaemonClient(),
    runner: new DaemonRunner(),
    createVoiceSession: createStdinVoiceSession,
  });
}
