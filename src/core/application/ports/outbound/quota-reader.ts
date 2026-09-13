/**
 * QuotaReaderPort — outbound boundary for provider quota observation
 * (DEC-029, issue #92).
 *
 * Provider-specific readers (Codex `account/rateLimits/read`, Claude
 * statusline `rate_limits`) are outbound adapters the application invokes
 * on its own schedule; each {@link QuotaReaderPort.read} call *returns*
 * normalized {@link QuotaWindow} observations, which the application then
 * records into the `QuotaLedger`. No adapter writes into the core — the
 * dependency points inward on this port.
 */
import type { ISODateString } from '../../../domain/types.js';

/** How a quota observation reached the ledger. */
export type QuotaSource =
  /** Proactive poll of a provider quota API (Codex rateLimits/read, Claude rate_limits). */
  | 'polled'
  /** Token/cost data reported inline by an adapter (e.g. ACP UsageUpdate). */
  | 'event'
  /** An exhaustion error observed mid-run (HTTP 429, CLI quota message). */
  | 'reactive';

/** Status of a single quota window, mirroring provider vocabularies. */
export type QuotaWindowStatus = 'allowed' | 'warning' | 'exhausted';

/**
 * One quota window for one provider. Providers expose differently shaped
 * windows (Codex: 5h + weekly; Claude: 5h + 7d + 7d_sonnet; Gemini: daily) —
 * `window` is a free-form label rather than an enum so readers do not have
 * to map provider vocabularies onto a fixed set.
 */
export interface QuotaWindow {
  /** Provider identifier, matching the adapter id (e.g. `codex`). */
  readonly provider: string;
  /** Provider-specific window label (e.g. `five_hour`, `seven_day`, `primary`). */
  readonly window: string;
  /** Fraction of the window consumed, 0..1. */
  readonly usedPct: number;
  /** When the window resets, or null when the provider does not report it. */
  readonly resetsAt: ISODateString | null;
  readonly status: QuotaWindowStatus;
  readonly source: QuotaSource;
  /** When this observation was made. */
  readonly observedAt: ISODateString;
}

/** Aggregated availability view of one provider. */
export interface ProviderQuotaState {
  readonly provider: string;
  /** False while any known window is exhausted and not yet reset. */
  readonly available: boolean;
  /**
   * Earliest future `resetsAt` among currently-exhausted windows — when this
   * provider becomes usable again. Null when nothing is exhausted, or when
   * exhaustion was detected without a reported reset time.
   */
  readonly exhaustedUntil: ISODateString | null;
  readonly windows: readonly QuotaWindow[];
  /** Most recent observation across all windows, or null if never observed. */
  readonly lastObservedAt: ISODateString | null;
}

/** A quota reader produces normalized windows for one provider. */
export interface QuotaReaderPort {
  /** Provider id matching the adapter id (e.g. `codex`). */
  readonly provider: string;
  /** Read current quota windows. Throws when the surface is unreachable. */
  read(now?: Date): Promise<readonly QuotaWindow[]>;
}
