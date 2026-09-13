/**
 * Reactive quota-exhaustion coordination (DEC-029, issue #71).
 *
 * Providers without a quota API (Devin, Gemini/agy) can only be observed
 * reactively: when a run fails, the application classifies the error and,
 * when it is an exhaustion signal, records the exhaustion so the router
 * fails over. This is application coordination — the recorder interface
 * below is owned here, not in the outbound ports, because nothing outside
 * the application calls it.
 */
import type { ISODateString } from '../../../domain/types.js';

/**
 * Narrow recorder for the reactive exhaustion path. `QuotaLedger`
 * satisfies it structurally via `markExhausted`.
 */
export interface QuotaExhaustionRecorder {
  markExhausted(provider: string, options?: { window?: string; resetsAt?: ISODateString }): void;
}

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
  recorder: QuotaExhaustionRecorder,
  provider: string,
  error: unknown,
  options: { window?: string; resetsAt?: ISODateString } = {},
): boolean {
  if (!isQuotaExhaustion(error)) {
    return false;
  }
  recorder.markExhausted(provider, options);
  return true;
}
