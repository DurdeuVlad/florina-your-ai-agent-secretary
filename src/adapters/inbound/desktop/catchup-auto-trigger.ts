/**
 * Idle-threshold auto-catch-up trigger for the Florina/home view (DEC-042,
 * issue #195/#218). See `docs/RULES_MEMORY_AND_SUPERVISION.md` § 9.
 *
 * Pure decision logic, deliberately decoupled from the actual view/IPC
 * wiring (which view fires it, how the digest gets rendered) — the same
 * scope split #217 drew between the daemon commands and their adapter
 * persistence. A future issue wires `onViewOpened()` into the desktop
 * app's actual focus/mount event and calls `florina catchup` (or the
 * `get-catchup`/`confirm-catchup` commands directly) when it returns
 * `true`.
 */

/** Default idle threshold: 30 minutes. Configurable per §9's reconsideration trigger (DEC-042). */
export const DEFAULT_IDLE_THRESHOLD_MS = 30 * 60 * 1000;

export interface CatchUpAutoTriggerConfig {
  /** Minimum idle gap, in ms, before an auto-catch-up fires again. */
  readonly idleThresholdMs?: number;
  /** Time provider (ms since epoch) for deterministic testing. */
  readonly now?: () => number;
}

/**
 * Decides whether the Florina/home view opening (or regaining focus)
 * should trigger an automatic catch-up. Fires on the very first call
 * (nothing to compare against yet — a fresh app start is itself a
 * meaningful "return") and thereafter only when at least
 * `idleThresholdMs` has elapsed since it last fired, so reopening the
 * view repeatedly in a short session never re-triggers it.
 */
export class CatchUpAutoTrigger {
  private readonly thresholdMs: number;
  private readonly now: () => number;
  private lastFiredAt: number | null = null;

  constructor(config: CatchUpAutoTriggerConfig = {}) {
    this.thresholdMs = config.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;
    this.now = config.now ?? (() => Date.now());
  }

  /** The configured idle threshold in milliseconds. */
  get idleThresholdMs(): number {
    return this.thresholdMs;
  }

  /**
   * Call whenever the Florina/home view opens or regains focus. Returns
   * `true` exactly when auto-catch-up should fire for this occasion.
   */
  onViewOpened(): boolean {
    const now = this.now();
    if (this.lastFiredAt !== null && now - this.lastFiredAt < this.thresholdMs) {
      return false;
    }
    this.lastFiredAt = now;
    return true;
  }

  /** Time remaining, in ms, before the next open would fire — 0 if it would fire now. */
  msUntilNextFire(): number {
    if (this.lastFiredAt === null) return 0;
    const elapsed = this.now() - this.lastFiredAt;
    return Math.max(0, this.thresholdMs - elapsed);
  }
}
