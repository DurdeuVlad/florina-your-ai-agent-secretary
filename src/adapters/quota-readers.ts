/**
 * Provider quota readers — normalize each subscription's quota surface into
 * {@link QuotaWindow} observations for the QuotaLedger (DEC-029, issue #71).
 *
 * Readers stay pure: transports (JSON-RPC calls, statusline JSON, process
 * output) are injected, so the modules are unit-testable without live
 * providers. Poll scheduling is owned by the daemon — readers just produce
 * windows stamped with `observedAt`.
 *
 * | Provider | Surface |
 * |---|---|
 * | Codex | `codex app-server` JSON-RPC `account/rateLimits/read` |
 * | Claude Code | `rate_limits` object in statusline JSON |
 * | Devin / Gemini / agy | {@link ReactiveQuotaDetector} — no quota API |
 */
import type { ISODateString } from '../domain/types.js';
import type { QuotaLedger } from '../daemon/quota-ledger.js';
import type { QuotaWindow, QuotaWindowStatus } from '../daemon/quota-ledger.js';

/** A quota reader produces normalized windows for one provider. */
export interface QuotaReader {
  /** Provider id matching the adapter id (e.g. `codex`). */
  readonly provider: string;
  /** Read current quota windows. Throws when the surface is unreachable. */
  read(now?: Date): Promise<readonly QuotaWindow[]>;
}

/** Raised when a reader's payload cannot be normalized. */
export class QuotaReaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuotaReaderError';
  }
}

/* ------------------------------------------------------------------ *
 * Shared normalization
 * ------------------------------------------------------------------ */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalize a provider reset value to ISO-8601: accepts ISO strings and
 * epoch numbers (seconds when < 1e12, milliseconds otherwise).
 */
export function normalizeReset(value: unknown): ISODateString | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  return null;
}

/** Normalize a 0..1 usage fraction into a window status. */
export function statusFromUsage(usedPct: number): QuotaWindowStatus {
  if (usedPct >= 1) {
    return 'exhausted';
  }
  if (usedPct >= 0.9) {
    return 'warning';
  }
  return 'allowed';
}

/** Normalize a provider percentage (`0..100` or `0..1`) into a fraction. */
export function normalizeUsedPct(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  const pct = value > 1 ? value / 100 : value;
  return Math.min(1, Math.max(0, pct));
}

function buildWindow(
  provider: string,
  window: string,
  usedPct: number | null,
  resetsAt: ISODateString | null,
  source: QuotaWindow['source'],
  now: Date,
): QuotaWindow | null {
  if (usedPct === null) {
    return null;
  }
  return {
    provider,
    window,
    usedPct,
    resetsAt,
    status: statusFromUsage(usedPct),
    source,
    observedAt: now.toISOString(),
  };
}

/* ------------------------------------------------------------------ *
 * Codex — account/rateLimits/read over the app-server JSON-RPC transport
 * ------------------------------------------------------------------ */

/** JSON-RPC call seam into a running `codex app-server` session. */
export type JsonRpcRequest = (method: string, params?: unknown) => Promise<unknown>;

/** Options for {@link CodexQuotaReader}. */
export interface CodexQuotaReaderOptions {
  /** Issues `account/rateLimits/read` (or another method) against app-server. */
  readonly request: JsonRpcRequest;
}

/**
 * Codex quota reader. `account/rateLimits/read` returns
 * `rateLimits.primary` (five-hour) and `rateLimits.secondary` (weekly),
 * each with `usedPercent` and a `resetsAt` timestamp. Requires ChatGPT
 * auth (not API-key auth).
 */
export class CodexQuotaReader implements QuotaReader {
  readonly provider = 'codex';
  private readonly request: JsonRpcRequest;

  constructor(options: CodexQuotaReaderOptions) {
    this.request = options.request;
  }

  async read(now: Date = new Date()): Promise<readonly QuotaWindow[]> {
    const response: unknown = await this.request('account/rateLimits/read');
    const limits = isObject(response) && isObject(response['rateLimits'])
      ? (response['rateLimits'] as Record<string, unknown>)
      : isObject(response)
        ? response
        : {};
    const windows: QuotaWindow[] = [];
    const add = (window: string, raw: unknown): void => {
      if (!isObject(raw)) {
        return;
      }
      const w = buildWindow(
        this.provider,
        window,
        normalizeUsedPct(raw['usedPercent'] ?? raw['used_percentage']),
        normalizeReset(raw['resetsAt'] ?? raw['resets_at']),
        'polled',
        now,
      );
      if (w !== null) {
        windows.push(w);
      }
    };
    add('five_hour', limits['primary']);
    add('seven_day', limits['secondary']);
    if (windows.length === 0) {
      throw new QuotaReaderError('codex rateLimits response contained no usable windows');
    }
    return windows;
  }
}

/* ------------------------------------------------------------------ *
 * Claude Code — rate_limits in statusline JSON
 * ------------------------------------------------------------------ */

/** Seam producing Claude's statusline JSON payload. */
export type StatuslineSource = () => Promise<unknown>;

/** Options for {@link ClaudeQuotaReader}. */
export interface ClaudeQuotaReaderOptions {
  /** Returns the statusline JSON object (or its raw text). */
  readonly readStatusline: StatuslineSource;
}

/**
 * Claude Code quota reader. The statusline input JSON carries a
 * `rate_limits` object with `five_hour` and `seven_day` windows exposing
 * `used_percentage` and `resets_at`.
 */
export class ClaudeQuotaReader implements QuotaReader {
  readonly provider = 'claude-code';
  private readonly readStatusline: StatuslineSource;

  constructor(options: ClaudeQuotaReaderOptions) {
    this.readStatusline = options.readStatusline;
  }

  async read(now: Date = new Date()): Promise<readonly QuotaWindow[]> {
    let payload: unknown = await this.readStatusline();
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch {
        throw new QuotaReaderError('claude statusline was not valid JSON');
      }
    }
    if (!isObject(payload) || !isObject(payload['rate_limits'])) {
      throw new QuotaReaderError('claude statusline contained no rate_limits object');
    }
    const limits = payload['rate_limits'] as Record<string, unknown>;
    const windows: QuotaWindow[] = [];
    for (const [name, raw] of Object.entries(limits)) {
      if (!isObject(raw)) {
        continue;
      }
      const w = buildWindow(
        this.provider,
        name,
        normalizeUsedPct(raw['used_percentage'] ?? raw['usedPercent']),
        normalizeReset(raw['resets_at'] ?? raw['resetsAt']),
        'polled',
        now,
      );
      if (w !== null) {
        windows.push(w);
      }
    }
    if (windows.length === 0) {
      throw new QuotaReaderError('claude rate_limits contained no usable windows');
    }
    return windows;
  }
}

/* ------------------------------------------------------------------ *
 * Reactive detector — Devin / Gemini / agy have no quota API
 * ------------------------------------------------------------------ */

/** Patterns that indicate quota/rate exhaustion in provider errors. */
const EXHAUSTION_PATTERNS: readonly RegExp[] = [
  /\b429\b/,
  /rate[ -]?limit/i,
  /quota (exceeded|exhausted|limit)/i,
  /usage (limit|cap) (reached|exceeded)/i,
  /too many requests/i,
  /insufficient (quota|credits)/i,
  /billing/i,
];

/** Classifier: is this error (or output line) a quota-exhaustion signal? */
export function isQuotaExhaustion(error: unknown): boolean {
  const text =
    error instanceof Error
      ? `${error.message} ${error.stack ?? ''}`
      : typeof error === 'string'
        ? error
        : JSON.stringify(error);
  return EXHAUSTION_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Reactive quota path (issue #71): when a run fails with an exhaustion
 * error, record it into the ledger so the router fails over.
 *
 * Returns true when the error was recognized as exhaustion (and recorded).
 */
export function reportExhaustion(
  ledger: QuotaLedger,
  provider: string,
  error: unknown,
  options: { window?: string; resetsAt?: ISODateString } = {},
): boolean {
  if (!isQuotaExhaustion(error)) {
    return false;
  }
  ledger.markExhausted(provider, options);
  return true;
}
