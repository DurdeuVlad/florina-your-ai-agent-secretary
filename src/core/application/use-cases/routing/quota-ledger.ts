/**
 * QuotaLedger — normalized per-provider quota state (DEC-029, issue #60).
 *
 * The ledger is the single record of how much capacity each provider
 * subscription has left. Provider-specific readers (Codex
 * `account/rateLimits/read`, Claude statusline `rate_limits`, reactive
 * 429/exhaustion detection for Devin and Gemini/agy) all normalize into the
 * same {@link QuotaWindow} shape and write here; the `CapacityRouter` reads
 * from here and never talks to providers directly.
 *
 * Semantics:
 * - A provider has capacity unless a *known* window is exhausted. Providers
 *   with no recorded windows are optimistically available — exhaustion is
 *   learned, not assumed (reactive-only providers start available).
 * - An exhausted window stops blocking once its `resetsAt` passes; the clock
 *   is injectable so tests control time.
 * - The ledger is deterministic and pure: no provider I/O, no timers. The
 *   daemon polls readers and calls {@link QuotaLedger.recordWindow}; adapter
 *   error paths call {@link QuotaLedger.markExhausted}.
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

/** Options for {@link QuotaLedger}. */
export interface QuotaLedgerOptions {
  /** Injectable clock (defaults to wall time) for deterministic tests. */
  readonly now?: () => Date;
}

/**
 * In-memory store of normalized quota windows.
 *
 * Persistence into the event journal is intentionally left to the daemon
 * wiring layer: quota observations are journaled like any other meaningful
 * state transition (DEC-012), but the ledger itself stays pure and testable.
 */
export class QuotaLedger {
  private readonly now: () => Date;
  /** Keyed by `${provider}${window}`. */
  private readonly windows = new Map<string, QuotaWindow>();

  constructor(options: QuotaLedgerOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Record a quota observation. Supersedes any earlier observation for the
   * same `(provider, window)`; stale observations (older `observedAt`) are
   * ignored so out-of-order reader writes cannot regress the ledger.
   */
  recordWindow(window: QuotaWindow): void {
    const key = quotaKey(window.provider, window.window);
    const existing = this.windows.get(key);
    if (existing !== undefined && existing.observedAt > window.observedAt) {
      return;
    }
    this.windows.set(key, window);
  }

  /**
   * Reactive path: mark a provider (optionally one window) as exhausted.
   * Used when a run fails with a quota error and the provider could not be
   * polled — the ledger records the exhaustion so the router fails over.
   */
  markExhausted(
    provider: string,
    options: { window?: string; resetsAt?: ISODateString } = {},
  ): void {
    this.recordWindow({
      provider,
      window: options.window ?? 'reactive',
      usedPct: 1,
      resetsAt: options.resetsAt ?? null,
      status: 'exhausted',
      source: 'reactive',
      observedAt: this.now().toISOString(),
    });
  }

  /**
   * Aggregated availability for one provider. A provider with no recorded
   * windows is available (optimistic — see module doc).
   */
  providerState(provider: string): ProviderQuotaState {
    const windows = [...this.windows.values()].filter((w) => w.provider === provider);
    const exhaustedUntil = this.earliestResetOf(windows);
    return {
      provider,
      available: exhaustedUntil === null && !windows.some((w) => this.isExhaustedNow(w)),
      exhaustedUntil,
      windows,
      lastObservedAt:
        windows.length === 0
          ? null
          : windows.reduce((a, b) => (a.observedAt > b.observedAt ? a : b)).observedAt,
    };
  }

  /** Whether the provider currently has capacity (see {@link providerState}). */
  hasCapacity(provider: string): boolean {
    return this.providerState(provider).available;
  }

  /**
   * Earliest future reset across exhausted windows — the moment the given
   * providers (or all known providers) next regain capacity. Used to
   * schedule park/resume when the whole fleet is dry (DEC-029).
   */
  earliestReset(providers?: readonly string[]): ISODateString | null {
    const windows = [...this.windows.values()].filter(
      (w) => providers === undefined || providers.includes(w.provider),
    );
    return this.earliestResetOf(windows);
  }

  /** Providers with at least one recorded window. */
  providers(): readonly string[] {
    return [...new Set([...this.windows.values()].map((w) => w.provider))];
  }

  /** When a provider next regains capacity, or null if it is not exhausted. */
  nextResetFor(provider: string): ISODateString | null {
    return this.providerState(provider).exhaustedUntil;
  }

  /** True when a window is exhausted and its reset has not yet passed. */
  private isExhaustedNow(window: QuotaWindow): boolean {
    const exhausted = window.status === 'exhausted' || window.usedPct >= 1;
    if (!exhausted) {
      return false;
    }
    // A reset in the past means the window has rolled over — no longer blocking.
    return window.resetsAt === null || window.resetsAt > this.now().toISOString();
  }

  /** Earliest future `resetsAt` among currently-exhausted windows. */
  private earliestResetOf(windows: readonly QuotaWindow[]): ISODateString | null {
    const resets = windows
      .filter((w) => this.isExhaustedNow(w) && w.resetsAt !== null)
      .map((w) => w.resetsAt as string)
      .sort();
    return resets[0] ?? null;
  }
}

function quotaKey(provider: string, window: string): string {
  return `${provider}${window}`;
}
