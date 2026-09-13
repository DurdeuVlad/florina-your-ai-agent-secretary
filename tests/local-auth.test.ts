/**
 * Local control-plane auth (issue #118): the daemon provisions a token at
 * `~/.florina/auth-token`, the control plane rejects unauthenticated
 * commands, and the CLI/desktop surfaces authenticate via the handshake.
 */
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';

import {
  ensureLocalAuthToken,
  readLocalAuthToken,
  localAuthTokenPath,
} from '../src/adapters/outbound/credentials/local-auth-token.js';
import { DaemonClient, DaemonConnectionError } from '../src/adapters/inbound/cli/client.js';
import { FlorinaDaemon } from '../src/bootstrap/daemon.js';

const dirs: string[] = [];
const daemons: FlorinaDaemon[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'florina-auth-'));
  dirs.push(dir);
  return dir;
}

async function startDaemon(authToken?: string): Promise<FlorinaDaemon> {
  const daemon = new FlorinaDaemon({
    port: 0,
    mcpPort: 0,
    lockfile: join(tmpDir(), 'florina.lock'),
    dbPath: ':memory:',
    installSignalHandlers: false,
    ...(authToken !== undefined ? { authToken } : {}),
  });
  await daemon.start();
  daemons.push(daemon);
  return daemon;
}

afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('local auth token store', () => {
  it('generates a 64-hex token in an owner-only file', () => {
    const dir = tmpDir();
    const token = ensureLocalAuthToken(dir);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const file = localAuthTokenPath(dir);
    expect(existsSync(file)).toBe(true);
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it('returns the same token on repeat calls and via read', () => {
    const dir = tmpDir();
    const token = ensureLocalAuthToken(dir);
    expect(ensureLocalAuthToken(dir)).toBe(token);
    expect(readLocalAuthToken(dir)).toBe(token);
    expect(readFileSync(localAuthTokenPath(dir), 'utf8')).toBe(token);
  });

  it('read returns undefined when no token exists', () => {
    expect(readLocalAuthToken(tmpDir())).toBeUndefined();
  });
});

describe('control-plane auth handshake', () => {
  it('client with token can send commands to a token-requiring daemon', async () => {
    const daemon = await startDaemon('test-tok');
    const client = new DaemonClient({ port: daemon.port, authToken: 'test-tok' });
    const res = await client.send({ kind: 'query-inbox' });
    expect(res).not.toMatchObject({ ok: false, error: 'authentication required' });
  });

  it('client without token is rejected by a token-requiring daemon', async () => {
    const daemon = await startDaemon('test-tok');
    const client = new DaemonClient({ port: daemon.port });
    const res = await client.send({ kind: 'query-inbox' });
    expect(res).toMatchObject({ ok: false, error: 'authentication required' });
  });

  it('client with wrong token fails the handshake', async () => {
    const daemon = await startDaemon('test-tok');
    const client = new DaemonClient({ port: daemon.port, authToken: 'wrong' });
    await expect(client.send({ kind: 'query-inbox' })).rejects.toThrow(DaemonConnectionError);
  });

  it('token-bearing client still works against a daemon without auth', async () => {
    const daemon = await startDaemon();
    const client = new DaemonClient({ port: daemon.port, authToken: 'test-tok' });
    const res = await client.send({ kind: 'query-inbox' });
    expect(res).not.toMatchObject({ ok: false, error: 'authentication required' });
  });
});
