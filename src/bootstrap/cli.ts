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
import { loadEnvFile } from '../adapters/outbound/credentials/dotenv.js';
import { readLocalAuthToken } from '../adapters/outbound/credentials/local-auth-token.js';
import { DaemonRunner } from './daemon-runner.js';
import { createStdinVoiceSession } from './voice-session.js';

/**
 * CLI entry point. Parses argv, dispatches to a subcommand, and returns the
 * process exit code. Called by the `florina` / `flor` binary shim at
 * `src/cli/index.ts`.
 */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  // `.env` convenience: populate OPENAI_API_KEY / FLORINA_* from the project
  // file before the CLI reads process.env. Real env vars always win.
  loadEnvFile();
  return runCli(argv, {
    // #118: authenticate to the daemon's control plane with the local
    // token the daemon provisioned at start (~/.florina/auth-token).
    client: new DaemonClient({ authToken: readLocalAuthToken() }),
    runner: new DaemonRunner(),
    createVoiceSession: createStdinVoiceSession,
  });
}
