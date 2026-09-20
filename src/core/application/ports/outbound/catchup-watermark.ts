/**
 * Outbound port: the "catch me up" watermark (DEC-042, issue #191/#195/#216).
 *
 * A single global `last_active_at` value per user session — not per task,
 * since resumption reconstructs the *human's* context, not each project's
 * (§9). Advancing it is a separate, deliberate act (#217) gated on
 * confirmed digest delivery — this port only stores/reads the value.
 */
import type { ISODateString } from '../../../domain/types.js';

export interface CatchUpWatermarkPort {
  /** The last confirmed-delivered catch-up timestamp, or `null` before the first ever catch-up. */
  get(): ISODateString | null;
  /** Persist a new watermark value. */
  set(value: ISODateString): void;
}
