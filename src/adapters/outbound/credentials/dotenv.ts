/**
 * Minimal `.env` loader (issue #116).
 *
 * The CLI reads configuration from `process.env` (OPENAI_API_KEY,
 * FLORINA_LITELLM_*, FLORINA_DAEMON_URL) but nothing ever loaded the
 * project's `.env` file — users had to `source` it by hand. This loader
 * runs once at each composition root and populates `process.env` with any
 * KEY=VALUE pairs found in `.env`, without ever overriding variables the
 * caller already set (real environment wins over file).
 *
 * Deliberately a ~40-line parser rather than a `dotenv` dependency: the
 * syntax subset we need (comments, blank lines, `export ` prefix, optional
 * matching quotes) is small and the project avoids extra deps.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/;

function unquote(value: string): string {
  if (value.length >= 2) {
    const q = value[0];
    if ((q === '"' || q === "'") && value[value.length - 1] === q) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * Load `file` (default `<cwd>/.env`) into `process.env`. Missing file is
 * fine — this is a convenience, not a requirement. Existing environment
 * variables are never overridden. Returns the keys that were set.
 */
export function loadEnvFile(
  file: string = resolve(process.cwd(), '.env'),
  env: Record<string, string | undefined> = process.env,
): string[] {
  if (!existsSync(file)) return [];
  const applied: string[] = [];
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = LINE.exec(line);
    if (m === null) continue;
    const key = m[1] as string;
    if (env[key] !== undefined) continue;
    env[key] = unquote((m[2] as string).trim());
    applied.push(key);
  }
  return applied;
}
