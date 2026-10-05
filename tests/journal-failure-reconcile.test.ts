import { describe, it, expect } from 'vitest';

import { AttentionInbox } from '../src/attention/attention-inbox.js';
import { reconcileJournalFailureItems } from '../src/attention/journal-failure-reconcile.js';
import { createAttentionItem, type AttentionItemStatus } from '../src/attention/attention-item.js';
import type { EventJournalPort } from '../src/core/application/ports/outbound/repositories.js';
import type { Event } from '../src/domain/types.js';

/** Minimal in-memory EventJournalPort for reconciliation tests. */
function fakeJournal(ids: string[] = []): EventJournalPort & {
  readonly present: Set<string>;
} {
  const present = new Set(ids);
  return {
    present,
    insert: (e: Event) => void present.add(e.id),
    getById: (id: string) => (present.has(id) ? ({ id } as Event) : null),
    listByTask: () => [],
    listBySession: () => [],
    listByTimestampRange: () => [],
  };
}

/** A JournalFailure card retaining the given journal row ids. */
function failureCard(id: string, writes: unknown[], status: AttentionItemStatus = 'Pending') {
  return createAttentionItem({
    id,
    taskId: 'task-1',
    kind: 'JournalFailure',
    priority: 'Critical',
    createdAt: '2026-01-01T00:00:00.000Z',
    status,
    payload: { writes, source: 'event-journal' },
  });
}

describe('reconcileJournalFailureItems (issue #272)', () => {
  it('resolves a card whose retained rows all landed during downtime', () => {
    const inbox = new AttentionInbox();
    inbox.add(failureCard('jf-1', [{ id: 'ev-1' }, { id: 'ev-2' }]));
    const journal = fakeJournal(['ev-1', 'ev-2']);
    const result = reconcileJournalFailureItems(inbox, journal);
    expect(result).toEqual({ landed: 2, resolved: 1, surviving: 0 });
    const item = inbox.list()[0]!;
    expect(item.status).toBe('Resolved');
    expect(item.payload['writes']).toEqual([]);
    expect(String(item.payload['message'])).toContain('landed');
  });

  it('trims landed rows and keeps the still-missing survivors', () => {
    const inbox = new AttentionInbox();
    inbox.add(failureCard('jf-1', [{ id: 'ev-1' }, { id: 'ev-2' }, { id: 'ev-3' }]));
    const journal = fakeJournal(['ev-2']);
    const result = reconcileJournalFailureItems(inbox, journal);
    expect(result).toEqual({ landed: 1, resolved: 0, surviving: 1 });
    const item = inbox.list()[0]!;
    expect(item.status).toBe('Pending');
    expect(item.payload['writes']).toEqual([{ id: 'ev-1' }, { id: 'ev-3' }]);
  });

  it('leaves a card alone when nothing landed', () => {
    const inbox = new AttentionInbox();
    inbox.add(failureCard('jf-1', [{ id: 'ev-1' }]));
    const result = reconcileJournalFailureItems(inbox, fakeJournal());
    expect(result).toEqual({ landed: 0, resolved: 0, surviving: 1 });
    expect(inbox.list()[0]!.payload['writes']).toEqual([{ id: 'ev-1' }]);
  });

  it('keeps malformed rows and rows the probe cannot check', () => {
    const inbox = new AttentionInbox();
    inbox.add(failureCard('jf-1', [{ noId: true }, { id: 'ev-1' }, { id: 'ev-2' }]));
    const journal = fakeJournal(['ev-1']);
    // getById throws on the second id — a failed probe must not count as landed.
    const throwing: EventJournalPort = {
      ...journal,
      getById: (id: string) => {
        if (id === 'ev-2') throw new Error('db closed');
        return journal.getById(id);
      },
    };
    const result = reconcileJournalFailureItems(inbox, throwing);
    expect(result).toEqual({ landed: 1, resolved: 0, surviving: 1 });
    expect(inbox.list()[0]!.payload['writes']).toEqual([{ noId: true }, { id: 'ev-2' }]);
  });

  it('ignores resolved cards, other kinds, and cards with empty writes', () => {
    const inbox = new AttentionInbox();
    inbox.add(failureCard('jf-resolved', [{ id: 'ev-x' }], 'Resolved'));
    inbox.add(failureCard('jf-empty', []));
    inbox.add(
      createAttentionItem({
        id: 'other',
        taskId: 'task-1',
        kind: 'ApprovalRequest',
        priority: 'High',
        createdAt: '2026-01-01T00:00:00.000Z',
        payload: { writes: [{ id: 'ev-9' }] },
      }),
    );
    const result = reconcileJournalFailureItems(inbox, fakeJournal(['ev-x', 'ev-9']));
    expect(result).toEqual({ landed: 0, resolved: 0, surviving: 0 });
    const items = inbox.list();
    expect(items.length).toBe(3);
    // A resolved card's retained rows are dead weight — retry refuses
    // resolved items — so reconciliation trims them out of the snapshot.
    expect(items.find((i) => i.id === 'jf-resolved')!.payload['writes']).toEqual([]);
    // Non-JournalFailure items are never touched.
    expect(items.find((i) => i.id === 'other')!.payload['writes']).toEqual([{ id: 'ev-9' }]);
  });
});
