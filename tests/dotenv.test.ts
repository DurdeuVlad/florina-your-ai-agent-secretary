/**
 * `.env` loader (issue #116): the CLI/desktop composition roots call
 * `loadEnvFile` so OPENAI_API_KEY / FLORINA_* resolve from the project
 * file without `source .env`. Real environment variables must win.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';

import { loadEnvFile } from '../src/adapters/outbound/credentials/dotenv.js';

let dir: string | null = null;

async function envFile(contents: string): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'dotenv-test-'));
  const file = join(dir, '.env');
  await writeFile(file, contents);
  return file;
}

afterEach(async () => {
  if (dir !== null) await rm(dir, { recursive: true, force: true });
  dir = null;
});

describe('loadEnvFile', () => {
  it('loads KEY=VALUE pairs into the env', async () => {
    const file = await envFile('OPENAI_API_KEY=sk-test\nFLORINA_MODEL=gpt-5\n');
    const env: Record<string, string | undefined> = {};
    expect(loadEnvFile(file, env).sort()).toEqual(['FLORINA_MODEL', 'OPENAI_API_KEY']);
    expect(env['OPENAI_API_KEY']).toBe('sk-test');
    expect(env['FLORINA_MODEL']).toBe('gpt-5');
  });

  it('skips comments, blank lines, and malformed lines', async () => {
    const file = await envFile('# comment\n\n  \nNO_EQUALS_SIGN\nOK=1\n');
    const env: Record<string, string | undefined> = {};
    expect(loadEnvFile(file, env)).toEqual(['OK']);
    expect(env['OK']).toBe('1');
  });

  it('supports export prefix and quoted values', async () => {
    const file = await envFile(
      'export A=one\nB="two words"\nC=\'three\'\n',
    );
    const env: Record<string, string | undefined> = {};
    loadEnvFile(file, env);
    expect(env['A']).toBe('one');
    expect(env['B']).toBe('two words');
    expect(env['C']).toBe('three');
  });

  it('never overrides an existing environment variable', async () => {
    const file = await envFile('KEY=file-value\n');
    const env: Record<string, string | undefined> = { KEY: 'real-value' };
    expect(loadEnvFile(file, env)).toEqual([]);
    expect(env['KEY']).toBe('real-value');
  });

  it('returns [] when the file does not exist', () => {
    const env: Record<string, string | undefined> = {};
    expect(loadEnvFile('/nonexistent/.env', env)).toEqual([]);
  });
});
