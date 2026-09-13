/**
 * Local control-plane auth token (issue #118).
 *
 * The daemon's WebSocket control plane supports an `auth` handshake, but
 * nothing ever provisioned a token — so any local process could send any
 * command. The daemon now generates (or reuses) a random token persisted
 * next to its database (`~/.florina/auth-token`, mode 0600), and every
 * local surface — CLI, desktop, voice — reads the same file to
 * authenticate. Remote/federated connections keep their own configured
 * tokens (#78); this file is the local surface's credential.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const TOKEN_BYTES = 32;

/**
 * Path of the local auth token inside `dir` (default `~/.florina`). The
 * daemon derives `dir` from its `dbPath`, so tests that point the database
 * at a temp dir get an isolated token file automatically.
 */
export function localAuthTokenPath(dir: string = join(homedir(), '.florina')): string {
  return join(dir, 'auth-token');
}

/**
 * Read the local auth token, generating and persisting one if missing.
 * Creates `dir` if needed; the file is written owner-only (0600).
 */
export function ensureLocalAuthToken(dir?: string): string {
  const file = localAuthTokenPath(dir);
  const existing = readLocalAuthToken(dir);
  if (existing !== undefined) return existing;
  mkdirSync(dirname(file), { recursive: true });
  const token = randomBytes(TOKEN_BYTES).toString('hex');
  writeFileSync(file, token, { mode: 0o600 });
  return token;
}

/**
 * Read the local auth token if the file exists, else `undefined`.
 * Callers that only *consume* the token (clients) use this — only the
 * daemon provisions.
 */
export function readLocalAuthToken(dir?: string): string | undefined {
  const file = localAuthTokenPath(dir);
  if (!existsSync(file)) return undefined;
  const token = readFileSync(file, 'utf8').trim();
  return token === '' ? undefined : token;
}
