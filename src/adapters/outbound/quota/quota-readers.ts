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
import type { ISODateString } from '../../../core/domain/types.js';
import type {
  QuotaReaderPort,
  QuotaWindow,
  QuotaWindowStatus,
} from '../../../core/application/ports/outbound/quota-reader.js';

/**
 * Re-export the reactive-exhaustion coordination API so quota-reader
 * consumers keep importing it from this module. The source of truth is the
 * core routing use case (`quota-exhaustion.ts`, DEC-037, issue #92).
 */
export {
  isQuotaExhaustion,
  reportExhaustion,
} from '../../../core/application/use-cases/routing/quota-exhaustion.js';
export type { QuotaExhaustionRecorder } from '../../../core/application/use-cases/routing/quota-exhaustion.js';

/** A quota reader produces normalized windows for one provider. */
export type QuotaReader = QuotaReaderPort;

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
export class CodexQuotaReader implements QuotaReaderPort {
  readonly provider = 'codex';
  private readonly request: JsonRpcRequest;

  constructor(options: CodexQuotaReaderOptions) {
    this.request = options.request;
  }

  async read(now: Date = new Date()): Promise<readonly QuotaWindow[]> {
    const response: unknown = await this.request('account/rateLimits/read');
    const limits =
      isObject(response) && isObject(response['rateLimits'])
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
export class ClaudeQuotaReader implements QuotaReaderPort {
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
 * ------------------------------------------------------------------ *
 * The exhaustion classifier and {@link reportExhaustion} coordination live
 * in the core routing use case and are re-exported above; this module only
 * owns provider-surface normalization.
 */
