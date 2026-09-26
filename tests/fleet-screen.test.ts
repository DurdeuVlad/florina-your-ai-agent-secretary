/**
 * Fleet screen tests (issue #127): the `query-fleet` response rendered
 * as the mockup's provider cards, parked rows, and routing decisions.
 */
import { describe, it, expect } from 'vitest';

import { renderFleetScreen } from '../src/adapters/inbound/desktop/views/fleet-screen.js';
import type { RenderTree } from '../src/adapters/inbound/desktop/views/view-types.js';
import type {
  FleetProviderView,
  FleetResponse,
} from '../src/core/application/use-cases/tasks/command-api.js';

function provider(partial: Partial<FleetProviderView> = {}): FleetProviderView {
  return {
    provider: 'codex',
    available: true,
    exhaustedUntil: null,
    usedPct: 0.62,
    resetsAt: '2026-01-01T18:00:00Z',
    lastObservedAt: '2026-01-01T14:00:00Z',
    ...partial,
  };
}

function fleet(partial: Partial<FleetResponse> = {}): FleetResponse {
  return {
    ok: true,
    providers: [provider()],
    parked: [],
    routingDecisions: [],
    ...partial,
  };
}

function findAll(tree: RenderTree, tag: string): RenderTree[] {
  const out: RenderTree[] = [];
  const walk = (n: RenderTree | string): void => {
    if (typeof n === 'string') return;
    if (n.tag === tag) out.push(n);
    for (const c of n.children ?? []) walk(c);
  };
  walk(tree);
  return out;
}

describe('renderFleetScreen', () => {
  it('renders provider cards with utilization bars and available chips', () => {
    const tree = renderFleetScreen(fleet());
    const cards = findAll(tree, 'FleetCard');
    expect(cards).toHaveLength(1);
    const bar = findAll(cards[0], 'Bar')[0];
    expect(bar.props?.['pct']).toBe(62);
    expect(bar.props?.['dry']).toBe(false);
    const chips = findAll(cards[0], 'Chip');
    expect(chips[0].children?.[0]).toBe('available');
    expect(chips[0].props?.['variant']).toBe('green');
  });

  it('renders exhausted providers with a red chip, dry bar, and reset time', () => {
    const tree = renderFleetScreen(
      fleet({
        providers: [
          provider({
            provider: 'gemini',
            available: false,
            usedPct: 0.97,
            exhaustedUntil: '2026-01-01T14:32:00Z',
          }),
        ],
      }),
    );
    const card = findAll(tree, 'FleetCard')[0];
    const chip = findAll(card, 'Chip')[0];
    expect(chip.children?.[0]).toBe('exhausted');
    expect(chip.props?.['variant']).toBe('red');
    expect(findAll(card, 'Bar')[0].props?.['dry']).toBe(true);
    const summary = String(findAll(card, 'FleetSummary')[0].children?.[0]);
    expect(summary).toContain('quota dry');
    expect(summary).toContain('14:32');
  });

  it('shows providers without observations as available with no bar pressure', () => {
    const tree = renderFleetScreen(
      fleet({ providers: [provider({ lastObservedAt: null, usedPct: 0, resetsAt: null })] }),
    );
    const summary = String(findAll(tree, 'FleetSummary')[0].children?.[0]);
    expect(summary).toContain('no quota observations');
  });

  it('renders parked tasks with resume times', () => {
    const tree = renderFleetScreen(
      fleet({
        parked: [
          {
            taskId: 'task_1',
            objective: 'image-pipeline',
            reason: 'all candidate providers exhausted',
            resumeAt: '2026-01-01T14:32:00Z',
          },
        ],
      }),
    );
    const headers = findAll(tree, 'SectionHeader').map((h) => h.props?.['label']);
    expect(headers).toContain('Parked');
    const subs = findAll(tree, 'InspRowSub').map((s) => String(s.children?.[0]));
    expect(subs.some((s) => s.includes('resumes 14:32'))).toBe(true);
  });

  it('renders routing decision rows', () => {
    const tree = renderFleetScreen(
      fleet({
        routingDecisions: [
          {
            taskId: 'task_1',
            objective: 'image-pipeline',
            kind: 'TaskFailedOver',
            summary: 'image-pipeline → codex: gemini exhausted',
            timestamp: '2026-01-01T13:58:00Z',
          },
        ],
      }),
    );
    const titles = findAll(tree, 'InspRowTitle').map((t) => String(t.children?.[0]));
    expect(titles).toContain('image-pipeline → codex: gemini exhausted');
  });

  it('renders empty states when there is nothing to show', () => {
    const tree = renderFleetScreen(fleet({ providers: [], routingDecisions: [] }));
    const hints = findAll(tree, 'EmptyHint').map((h) => String(h.children?.[0]));
    expect(hints).toContain('no providers registered');
    expect(hints).toContain('no routing decisions journaled in the last 24h');
  });

  it('emits a JSON-serializable tree', () => {
    expect(() => JSON.stringify(renderFleetScreen(fleet()))).not.toThrow();
  });
});
