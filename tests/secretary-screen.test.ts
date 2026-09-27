/**
 * Secretary screen view tests (issue #130, mockup docs/mockups/secretary.html).
 */
import { describe, expect, it } from 'vitest';

import { renderSecretaryScreen } from '../src/adapters/inbound/desktop/views/secretary-screen.js';
import type { SecretaryResponse } from '../src/core/application/use-cases/tasks/command-api.js';
import type { RenderTree } from '../src/adapters/inbound/desktop/views/view-types.js';

function findAll(node: RenderTree | string, tag: string, out: RenderTree[] = []): RenderTree[] {
  if (typeof node === 'string') return out;
  if (node.tag === tag) out.push(node);
  for (const c of node.children ?? []) findAll(c, tag, out);
  return out;
}

function texts(node: RenderTree | string, out: string[] = []): string[] {
  if (typeof node === 'string') {
    out.push(node);
    return out;
  }
  for (const c of node.children ?? []) texts(c, out);
  return out;
}

function commands(node: RenderTree | string, out: string[] = []): string[] {
  if (typeof node === 'string') return out;
  if (node.props?.['command'] !== undefined) out.push(String(node.props['command']));
  for (const c of node.children ?? []) commands(c, out);
  return out;
}

const RESPONSE: SecretaryResponse = {
  ok: true,
  plan: [
    { id: 'todo-1', content: 'Watch the payments-api migration run', status: 'in_progress' },
    { id: 'todo-2', content: 'Draft the onboarding brief', status: 'pending' },
    { id: 'todo-3', content: 'Confirm devin routing rule', status: 'completed' },
  ],
  research: [
    {
      id: 'r1',
      query: 'cross-project capsule interfaces',
      startedAt: '2026-09-15T14:11:00Z',
      ideaId: 'idea_258i',
    },
  ],
  memoryWrites: [
    {
      id: 'mw-1',
      summary: 'Vlad prefers provider outages parked, not failed over silently',
      scope: 'user',
      proposedAt: '2026-09-15T14:09:00Z',
      source: 'voice',
    },
  ],
  health: [
    {
      agentId: 'secretary',
      windowFillPct: 0.42,
      eventsSinceCondensation: 173,
      condensationCount: 2,
      lastCondensationAt: '2026-09-15T09:41:00Z',
      status: 'ok',
    },
    {
      agentId: 'manager:agent-secretary',
      windowFillPct: 0.81,
      eventsSinceCondensation: 301,
      condensationCount: 1,
      status: 'degraded',
    },
  ],
};

describe('renderSecretaryScreen', () => {
  it('renders context health as first-class cards with fill bars and status chips', () => {
    const tree = renderSecretaryScreen(RESPONSE);
    const bars = findAll(tree, 'Bar');
    expect(bars).toHaveLength(2);
    expect(bars[0]!.props?.['pct']).toBe(42);
    expect(bars[1]!.props?.['warm']).toBe(true);
    const all = texts(tree).join(' ');
    expect(all).toContain('secretary');
    expect(all).toContain('manager:agent-secretary');
    expect(all).toContain('42% of context window used · 173 events since condensation');
    expect(all).toContain('last condensation Sep 15 09:41 · 2 total');
    const chips = findAll(tree, 'Chip');
    expect(chips.some((c) => texts(c).join('') === 'healthy')).toBe(true);
    expect(chips.some((c) => texts(c).join('') === 'degraded')).toBe(true);
  });

  it('renders the plan with status marks', () => {
    const tree = renderSecretaryScreen(RESPONSE);
    const all = texts(tree).join(' ');
    expect(all).toContain('● Watch the payments-api migration run');
    expect(all).toContain('○ Draft the onboarding brief');
    expect(all).toContain('✓ Confirm devin routing rule');
  });

  it('renders in-flight research with provenance', () => {
    const tree = renderSecretaryScreen(RESPONSE);
    const all = texts(tree).join(' ');
    expect(all).toContain('cross-project capsule interfaces');
    expect(all).toContain('started Sep 15 14:11');
    expect(all).toContain('appends to idea_258i');
  });

  it('renders pending memory writes with Confirm/Reject gate verbs', () => {
    const tree = renderSecretaryScreen(RESPONSE);
    const all = texts(tree).join(' ');
    expect(all).toContain('"Vlad prefers provider outages parked, not failed over silently"');
    expect(all).toContain('user-scope memory');
    expect(all).toContain('from voice');
    const cmds = commands(tree);
    expect(cmds).toContain('memwrite:confirm:mw-1');
    expect(cmds).toContain('memwrite:reject:mw-1');
  });

  it('marks memory-write cards selectable so j/k + Enter reach Confirm', () => {
    /* #262: the lens is keyboard-navigable — data-selectable lands on the
     * card and Enter activates its primary (non-danger) button. */
    const tree = renderSecretaryScreen(RESPONSE);
    const card = findAll(tree, 'PrefCard').find((c) =>
      commands(c).includes('memwrite:confirm:mw-1'),
    );
    expect(card?.props?.['selectable']).toBe(true);
    /* read-only sections stay unselectable — selection noise would land
     * Enter on cards with no actionable primary button */
    const health = findAll(tree, 'PrefCard').find((c) =>
      texts(c).join(' ').includes('42% of context window'),
    );
    expect(health?.props?.['selectable']).toBeUndefined();
  });

  it('renders honest empty states when the surface is empty', () => {
    const tree = renderSecretaryScreen({
      ok: true,
      plan: [],
      research: [],
      memoryWrites: [],
      health: [],
    });
    const all = texts(tree).join(' ');
    expect(all).toContain('no continuous agents reporting context health');
    expect(all).toContain('no plan items');
    expect(all).toContain('no research running');
    expect(all).toContain('no memory writes awaiting confirmation');
  });
});
