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
import type {
  ProviderQuotaState,
  QuotaWindow,
} from '../../ports/outbound/quota-reader.js';

/**
 * Re-export the observation contract so ledger consumers keep importing it
 * from this module. The source of truth is the quota-reader port
 * (DEC-037, issue #92).
 */
export type {
  ProviderQuotaState,
  QuotaSource,
  QuotaWindow,
  QuotaWindowStatus,
} from '../../ports/outbound/quota-reader.js';

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
