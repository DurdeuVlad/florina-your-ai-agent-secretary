import { describe, it, expect } from 'vitest';
import { searchJournalEvents } from '../src/core/application/use-cases/journal/journal-search.js';
import type { Event } from '../src/core/domain/types.js';

function event(overrides: Partial<Event> & Pick<Event, 'id' | 'timestamp'>): Event {
  return {
    sessionId: 'sess-1',
    taskId: 'task-1',
    kind: 'AgentStarted',
    payload: {},
    ...overrides,
  };
}

describe('searchJournalEvents', () => {
  const events: Event[] = [
    event({ id: 'e1', timestamp: '2026-09-19T00:00:00.000Z', kind: 'AgentStarted', payload: { objective: 'fix bug' } }),
    event({ id: 'e2', timestamp: '2026-09-20T00:00:00.000Z', kind: 'TestFinished', payload: { passed: 5, failed: 0 } }),
    event({ id: 'e3', timestamp: '2026-09-21T00:00:00.000Z', kind: 'AgentCompleted', payload: { summary: 'fixed the bug' } }),
  ];

  it('returns everything, most-recent-first, with no query', () => {
    const result = searchJournalEvents(events, {});
    expect(result.map((e) => e.id)).toEqual(['e3', 'e2', 'e1']);
  });

  it('filters by text matching the event kind (case-insensitive)', () => {
    const result = searchJournalEvents(events, { text: 'testfinished' });
    expect(result.map((e) => e.id)).toEqual(['e2']);
  });

  it('filters by text matching the payload JSON (case-insensitive)', () => {
    const result = searchJournalEvents(events, { text: 'FIX' });
    expect(result.map((e) => e.id).sort()).toEqual(['e1', 'e3']);
  });

  it('an empty text query matches everything (not zero results)', () => {
    const result = searchJournalEvents(events, { text: '' });
    expect(result).toHaveLength(3);
  });

  it('filters by inclusive since bound', () => {
    const result = searchJournalEvents(events, { since: '2026-09-20T00:00:00.000Z' });
    expect(result.map((e) => e.id).sort()).toEqual(['e2', 'e3']);
  });

  it('filters by inclusive until bound', () => {
    const result = searchJournalEvents(events, { until: '2026-09-20T00:00:00.000Z' });
    expect(result.map((e) => e.id).sort()).toEqual(['e1', 'e2']);
  });

  it('combines text and date-range filters', () => {
    const result = searchJournalEvents(events, { text: 'bug', since: '2026-09-20T00:00:00.000Z' });
    expect(result.map((e) => e.id)).toEqual(['e3']);
  });

  it('caps results at the given limit, keeping the most recent', () => {
    const result = searchJournalEvents(events, {}, 2);
    expect(result.map((e) => e.id)).toEqual(['e3', 'e2']);
  });

  it('returns an empty array when nothing matches', () => {
    const result = searchJournalEvents(events, { text: 'nonexistent-xyz' });
    expect(result).toEqual([]);
  });
});
