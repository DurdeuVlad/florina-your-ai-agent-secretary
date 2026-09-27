import { describe, it, expect } from 'vitest';
import { formatCatchUpMessage } from '../src/adapters/inbound/desktop/catchup-message.js';
import type { CatchUpDigest } from '../src/core/application/use-cases/resumption/catchup-digest.js';

function digest(overrides: Partial<CatchUpDigest> = {}): CatchUpDigest {
  return {
    since: '2026-09-27T08:00:00.000Z',
    until: '2026-09-27T11:00:00.000Z',
    notable: [],
    stillRunning: [],
    pendingAttention: [],
    failovers: [],
    isEmpty: true,
    ...overrides,
  };
}

describe('formatCatchUpMessage', () => {
  it('closes quietly for an empty window', () => {
    const text = formatCatchUpMessage(digest());
    expect(text).toContain('catch-up · after 3h away');
    expect(text).toContain('nothing needs you');
  });

  it('lists notable, running, pending, and failover sections', () => {
    const text = formatCatchUpMessage(
      digest({
        isEmpty: false,
        notable: [
          {
            taskId: 'task_1',
            objective: 'refactor auth router',
            state: 'Completed',
            updatedAt: '2026-09-27T09:00:00.000Z',
          },
        ],
        stillRunning: [
          {
            taskId: 'task_2',
            objective: 'sync provider dirs',
            state: 'Running',
            updatedAt: '2026-09-27T10:00:00.000Z',
          },
        ],
        pendingAttention: [
          {
            id: 'attn_1',
            taskId: 'task_9',
            kind: 'ApprovalRequest',
            priority: 'High',
            status: 'Pending',
            createdAt: '2026-09-27T10:30:00.000Z',
            payload: {},
          } as CatchUpDigest['pendingAttention'][number],
        ],
        failovers: [
          {
            taskId: 'task_3',
            fromProvider: 'claude',
            toProvider: 'codex',
            reason: 'rate-limited',
            timestamp: '2026-09-27T10:45:00.000Z',
          },
        ],
      }),
    );
    expect(text).toContain('1 notable · 1 still running · 1 need your attention');
    expect(text).toContain('[Completed] refactor auth router');
    expect(text).toContain('sync provider dirs');
    expect(text).toContain('[High] ApprovalRequest');
    expect(text).toContain('claude → codex (rate-limited)');
    expect(text).toContain('nothing else needs you');
  });

  it('omits the away qualifier for a first-ever (epoch-watermark) catch-up', () => {
    const text = formatCatchUpMessage(digest({ since: new Date(0).toISOString() }));
    expect(text.startsWith('catch-up')).toBe(true);
    expect(text).not.toContain('after ');
  });

  it('omits the away qualifier for an unparseable window', () => {
    const text = formatCatchUpMessage(digest({ since: 'not-a-date' }));
    expect(text).not.toContain('after ');
  });
});
