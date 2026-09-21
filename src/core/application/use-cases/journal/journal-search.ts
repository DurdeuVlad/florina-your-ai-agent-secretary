/**
 * Journal search (DEC-012, issue #199/#222): text/date-range search over
 * journaled events, for History's search surface. Pure filter — no new
 * data model, the journal itself is the only source of truth.
 */
import type { Event, ISODateString } from '../../../domain/types.js';

export interface JournalSearchQuery {
  /** Case-insensitive substring match against the event kind and payload JSON. */
  readonly text?: string;
  /** Inclusive lower bound on `timestamp`. */
  readonly since?: ISODateString;
  /** Inclusive upper bound on `timestamp`. */
  readonly until?: ISODateString;
}

/** Default cap on returned events — a search result is a scan aid, not a full export. */
export const DEFAULT_JOURNAL_SEARCH_LIMIT = 200;

function matchesText(event: Event, text: string): boolean {
  const needle = text.toLowerCase();
  if (event.kind.toLowerCase().includes(needle)) return true;
  return JSON.stringify(event.payload).toLowerCase().includes(needle);
}

/**
 * Filter a set of journal events by text and/or date range, most-recent
 * first, capped at `limit`. Callers typically supply events from
 * `EventJournalPort.listByTimestampRange` (or `listByTask`/`listBySession`
 * for a narrower scope) — this function only filters/sorts/caps what it's
 * given, it does not query the journal itself.
 */
export function searchJournalEvents(
  events: readonly Event[],
  query: JournalSearchQuery,
  limit: number = DEFAULT_JOURNAL_SEARCH_LIMIT,
): readonly Event[] {
  return events
    .filter((e) => query.since === undefined || e.timestamp >= query.since)
    .filter((e) => query.until === undefined || e.timestamp <= query.until)
    .filter((e) => query.text === undefined || query.text === '' || matchesText(e, query.text))
    .slice()
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, limit);
}
