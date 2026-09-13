/**
 * Security hardening utilities.
 *
 * Small, dependency-free helpers that enforce the security invariants the
 * auditors check for. These are intended to be used throughout the codebase
 * (and by the auditors themselves) so that the "safe" path is also the easy
 * path.
 *
 * Related decisions:
 * - DEC-010: Approve the underlying capability, never an LLM summary.
 * - DEC-011: The secretary narrows permissions, never silently widens them.
 * - DEC-022: Credential/secret brokering model — workers never receive raw
 *   credentials.
 */

/**
 * Determine whether a URL or host string binds only to localhost.
 *
 * Accepts either a full URL (e.g. `ws://127.0.0.1:17419`) or a bare host
 * (`127.0.0.1`). Returns `true` only for loopback addresses — anything that
 * would bind to a network interface (`0.0.0.0`, a hostname, a public IP)
 * returns `false`.
 */
export function validateLocalhostOnly(url: string): boolean {
  const trimmed = url.trim();
  if (trimmed === '') return false;

  // Try to parse as a URL first; fall back to treating the input as a bare
  // host (with an optional port).
  let host = '';
  let parsedHost = '';
  try {
    const parsed = new URL(trimmed);
    parsedHost = parsed.hostname;
  } catch {
    parsedHost = '';
  }
  if (parsedHost) {
    // WHATWG URL keeps the brackets for IPv6 hosts under some schemes
    // (e.g. `ws://[::1]:8080` → hostname `[::1]`); strip them so the
    // loopback comparison sees the bare address.
    host = parsedHost.replace(/^\[/, '').replace(/\]$/, '');
  } else {
    // Not a usable URL — strip an optional trailing `:port` suffix and use
    // the remainder as the host. Only strip when the prefix contains no colon
    // (otherwise a bare IPv6 address like `::1` would be mis-parsed).
    const colon = trimmed.lastIndexOf(':');
    if (
      colon > 0 &&
      !trimmed.slice(0, colon).includes(':') &&
      /^\d+$/.test(trimmed.slice(colon + 1))
    ) {
      host = trimmed.slice(0, colon);
    } else {
      host = trimmed;
    }
  }

  const lower = host.toLowerCase();
  // Loopback set: IPv4 loopback, IPv6 loopback (both shorthand and full),
  // and the `localhost` name. Everything else is considered exposed.
  return (
    lower === '127.0.0.1' || lower === '::1' || lower === 'localhost' || lower === '0:0:0:0:0:0:0:1'
  );
}

/**
 * Escape shell metacharacters in a string so it can be safely interpolated
 * into a shell command as a single quoted argument.
 *
 * This wraps the input in single quotes and escapes any embedded single
 * quotes using the standard `'\''` sequence. It is the safest portable
 * quoting strategy for POSIX shells.
 *
 * Note: the preferred defense is to avoid the shell entirely (pass arguments
 * as an array with `shell: false`). This helper exists for the cases where a
 * shell string is unavoidable.
 */
export function sanitizeProcessInput(input: string): string {
  // Wrap in single quotes and escape embedded single quotes.
  return `'${input.replace(/'/g, "'\\''")}'`;
}

/**
 * Mask a secret value for safe logging.
 *
 * Returns the first 4 characters followed by `***`, so a value can be
 * identified in logs without revealing it in full. Very short values (<= 4
 * chars) are fully masked to avoid leaking the entire secret.
 */
export function redactSecret(value: string): string {
  if (typeof value !== 'string' || value.length === 0) return '***';
  if (value.length <= 4) return '***';
  return `${value.slice(0, 4)}***`;
}

/**
 * Validate that a string looks like an OpenAI API key.
 *
 * OpenAI keys start with `sk-` and are followed by at least 20 alphanumeric
 * characters (the exact length has grown over time; this check is deliberately
 * permissive on length but strict on the prefix and character set).
 */
export function validateApiKeyFormat(key: string): boolean {
  if (typeof key !== 'string') return false;
  return /^sk-[A-Za-z0-9_-]{20,}$/.test(key);
}

/**
 * Pattern that matches common secret shapes: OpenAI keys (`sk-...`), generic
 * long hex/base64 tokens, and `Bearer` tokens. Used by
 * {@link assertNoSecretsInLogs} to detect accidental secret leakage into log
 * text.
 */
export const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{20,}/, // OpenAI API key
  /Bearer\s+[A-Za-z0-9._-]{20,}/i, // HTTP Bearer token
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM private key
  /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/, // GitHub tokens
];

/**
 * Throw a {@link SecretsInLogsError} if the given text contains any pattern
 * that looks like a secret. Used as a guard before writing text to logs.
 */
export function assertNoSecretsInLogs(text: string): void {
  for (const pattern of SECRET_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      throw new SecretsInLogsError(
        `Refusing to log text that appears to contain a secret (matched ${match[0].slice(0, 6)}***).`,
      );
    }
  }
}

/**
 * Error thrown by {@link assertNoSecretsInLogs} when a secret-like pattern is
 * detected in text that was about to be logged.
 */
export class SecretsInLogsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretsInLogsError';
  }
}
