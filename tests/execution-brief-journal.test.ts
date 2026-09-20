import { describe, it, expect } from 'vitest';
import { EventBus } from '../src/adapters/outbound/events/in-memory-event-bus.js';
import { EventJournalWriter } from '../src/core/application/use-cases/journal/event-journal-writer.js';
import type { EventJournalPort } from '../src/core/application/ports/outbound/repositories.js';
import type { Event, EntityId } from '../src/core/domain/types.js';
import type { AgentStartedEvent } from '../src/core/domain/events.js';
import type { ExecutionBrief } from '../src/core/domain/execution-brief.js';

class InMemoryEventJournal implements EventJournalPort {
  private readonly rows: Event[] = [];
  insert(event: Event): void {
    this.rows.push(event);
  }
  getById(id: EntityId): Event | null {
    return this.rows.find((r) => r.id === id) ?? null;
  }
  listByTask(taskId: EntityId): Event[] {
    return this.rows.filter((r) => r.taskId === taskId);
  }
  listBySession(sessionId: EntityId): Event[] {
    return this.rows.filter((r) => r.sessionId === sessionId);
  }
  listByTimestampRange(start: string, end: string): Event[] {
    return this.rows.filter((r) => r.timestamp >= start && r.timestamp <= end);
  }
}

function sampleBrief(): ExecutionBrief {
  return {
    objective: 'Fix the pagination bug.',
    relevantContext: ['This project uses hexagonal architecture.'],
    applicableRules: [
      { id: 'r-1', statement: 'Reproduce before fixing.', provenance: 'explicit', scope: { type: 'global' } },
    ],
    constraints: ['Do not touch unrelated files.'],
    requiredVerification: ['npm test', 'npm run typecheck'],
    definitionOfDone: 'Pagination bug no longer reproduces; tests pass.',
    providerRationale: 'Claude Code — best routing preference for TypeScript bug fixes.',
  };
}

describe('Execution Brief journaling on dispatch (DEC-012, issue #208)', () => {
  it('a dispatched Task (AgentStarted) carries its Execution Brief into the journal', () => {
    const journal = new InMemoryEventJournal();
    const bus = new EventBus();
    const writer = new EventJournalWriter({ journal, bus });
    writer.start();

    const brief = sampleBrief();
    const event: AgentStartedEvent = {
      type: 'AgentStarted',
      timestamp: '2026-09-21T00:00:00.000Z',
      taskId: 'task-1',
      sessionId: 'sess-1',
      agentId: 'claude-code',
      adapterFidelityTier: 'A',
      objective: 'Fix the pagination bug.',
      workingDir: '/repo',
      executionBrief: brief,
    };

    bus.publish(event);

    const rows = journal.listByTask('task-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('AgentStarted');
    expect(rows[0]!.payload['executionBrief']).toEqual(brief);
  });

  it('an AgentStarted event with no compiled Brief journals fine without one', () => {
    const journal = new InMemoryEventJournal();
    const bus = new EventBus();
    const writer = new EventJournalWriter({ journal, bus });
    writer.start();

    const event: AgentStartedEvent = {
      type: 'AgentStarted',
      timestamp: '2026-09-21T00:00:00.000Z',
      taskId: 'task-2',
      sessionId: 'sess-2',
      agentId: 'codex',
      adapterFidelityTier: 'B',
      objective: 'Routine mechanical rename.',
      workingDir: '/repo',
    };

    bus.publish(event);

    const rows = journal.listByTask('task-2');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload['executionBrief']).toBeUndefined();
  });
});
