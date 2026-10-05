/**
 * Boot-time reconciliation of restored `JournalFailure` attention items
 * (issue #272).
 *
 * A `JournalFailure` card retains the journal rows that never landed in
 * its `payload.writes` list. While the daemon was down those rows may
 * have been retried and landed by other means — or a previous boot may
 * have landed some and crashed before persisting the trimmed card. On
 * restore, each retained row is checked against the journal by id:
 *
 * - a row already in the journal drops out of `writes` (never re-offered
 *   for retry, never duplicated);
 * - a card whose retained rows all landed is resolved — re-offering a
 *   Retry with nothing to do would be a false alarm;
 * - a card with survivors keeps exactly the still-missing rows.
 *
 * Rows that can't be checked (malformed, or the probe itself failed) are
 * kept — "couldn't verify it landed" is not "landed".
 */
import type { EventJournalPort } from '../../ports/outbound/repositories.js';
import type { AttentionInbox } from './attention-inbox.js';

/** Result of {@link reconcileJournalFailureItems}. */
export interface JournalFailureReconcileResult {
  /** Retained rows found already present in the journal. */
  readonly landed: number;
  /** Cards resolved because every retained row had landed. */
  readonly resolved: number;
  /** Cards that still retain missing rows after reconciliation. */
  readonly surviving: number;
}

/**
 * Reconcile restored `JournalFailure` items against the journal.
 *
 * Mutates `inbox` in place (`mergePayload` / `resolve`), which notifies
 * the persistence observer so the reconciled state is saved immediately.
 */
export function reconcileJournalFailureItems(
  inbox: AttentionInbox,
  events: EventJournalPort,
): JournalFailureReconcileResult {
  let landed = 0;
  let resolved = 0;
  let surviving = 0;
  for (const item of inbox.list({ kind: 'JournalFailure' })) {
    const writes = item.payload['writes'];
    // A resolved card's retained rows are dead weight — retry refuses
    // resolved items, so the rows can never land. Trim them out of the
    // persisted snapshot.
    if (item.status === 'Resolved') {
      if (Array.isArray(writes) && writes.length > 0) {
        inbox.mergePayload(item.id, { writes: [] });
      }
      continue;
    }
    if (!Array.isArray(writes) || writes.length === 0) {
      // A pending card with nothing retained can never complete a
      // Retry — leave it for the human to acknowledge, but don't treat
      // it as a surviving failure.
      continue;
    }

    const missing = writes.filter((w) => {
      const row = w as { readonly id?: unknown };
      if (typeof row?.id !== 'string') return true;
      try {
        return events.getById(row.id) === null;
      } catch {
        return true; // probe failed — keep the row rather than claim it landed
      }
    });
    landed += writes.length - missing.length;

    if (missing.length === 0) {
      inbox.mergePayload(item.id, {
        writes: [],
        message: `all ${writes.length} retained writes landed while the daemon was down`,
      });
      inbox.resolve(item.id);
      resolved++;
    } else if (missing.length !== writes.length) {
      inbox.mergePayload(item.id, {
        writes: missing,
        message: `${missing.length} of ${writes.length} retained writes still missing after restart`,
      });
      surviving++;
    } else {
      surviving++;
    }
  }
  return { landed, resolved, surviving };
}
