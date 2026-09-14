/**
 * Ideas screen view tests (issue #129).
 *
 * `renderIdeasScreen` turns `idea-list` + `brief-list` responses into the
 * mockup's tree: Open ledger cards (entry counts, project chips, last
 * touched, status), a Compiled→awaiting section for draft Briefs with
 * the DEC-033 confirm gate, and an inline ledger reader.
 */
import { describe, expect, it } from 'vitest';

import {
  encodeIdeaCommand,
  renderIdeasScreen,
} from '../src/adapters/inbound/desktop/views/ideas-screen.js';
import type {
  BriefListResponse,
  IdeaListResponse,
} from '../src/core/application/use-cases/tasks/command-api.js';
import type { Brief } from '../src/core/domain/ideas.js';
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

const IDEAS: IdeaListResponse = {
  ok: true,
  ideas: [
    {
      id: 'idea-1',
      title: 'Multi-repo context sync',
      status: 'open',
      path: '/ideas/idea-1.md',
      createdAt: '2026-09-10T10:00:00Z',
      updatedAt: '2026-09-15T10:00:00Z',
      entryCount: 6,
      preview: 'Let project capsules publish a read-only interface summary',
    },
    {
      id: 'idea-2',
      title: 'Onboarding tour copy',
      status: 'promoted',
      projectId: 'wayfinder',
      path: '/p/idea-2.md',
      createdAt: '2026-09-11T10:00:00Z',
      updatedAt: '2026-09-11T10:00:00Z',
      entryCount: 2,
      preview: 'First-run flow: connect a provider',
    },
    {
      id: 'idea-3',
      title: 'Already compiled',
      status: 'compiled',
      path: '/ideas/idea-3.md',
      createdAt: '2026-09-01T10:00:00Z',
      updatedAt: '2026-09-14T10:00:00Z',
      entryCount: 4,
      preview: 'done',
    },
  ],
};

const DRAFT_BRIEF: Brief = {
  id: 'brief-1',
  ideaId: 'idea-3',
  title: 'Tray notification center',
  spec: 'frozen spec',
  plan: {
    projectId: 'agent-secretary',
    tasks: [
      { objective: 'add tray badge', preferProvider: 'codex' },
      { objective: 'wire notification prefs' },
    ],
  },
  status: 'draft',
  createdAt: '2026-09-15T09:00:00Z',
};

const BRIEFS: BriefListResponse = { ok: true, briefs: [DRAFT_BRIEF] };

describe('renderIdeasScreen', () => {
  it('lists open and promoted ledgers as cards with entry counts', () => {
    const tree = renderIdeasScreen({ ideas: IDEAS, briefs: BRIEFS });
    const cards = findAll(tree, 'PrefCard');
    // 2 open/promoted ledgers + 1 draft brief card (compiled idea hidden).
    expect(cards).toHaveLength(3);
    const all = texts(tree).join(' ');
    expect(all).toContain('Multi-repo context sync');
    expect(all).toContain('6 entries');
    expect(all).toContain('2 entries');
    expect(all).toContain('Onboarding tour copy');
    expect(all).not.toContain('Already compiled');
    expect(all).toContain('status: promoted');
    expect(all).toContain('last touched Sep 15');
  });

  it('tags promoted ledgers with an amber project chip', () => {
    const tree = renderIdeasScreen({ ideas: IDEAS, briefs: BRIEFS });
    const chips = findAll(tree, 'Chip');
    const project = chips.filter((c) => texts(c).join('').startsWith('project:'));
    expect(project).toHaveLength(1);
    expect(project[0]!.props?.['variant']).toBe('amber');
    expect(texts(project[0]!).join('')).toBe('project:wayfinder');
  });

  it('emits idearead and ideacompile verbs on ledger cards', () => {
    const tree = renderIdeasScreen({ ideas: IDEAS, briefs: BRIEFS });
    const cmds = commands(tree);
    expect(cmds).toContain('idearead:idea-1');
    expect(cmds).toContain('ideacompile:idea-1');
    expect(cmds).toContain('ideaadd');
  });

  it('renders draft briefs in the awaiting-decision section with the gate action', () => {
    const tree = renderIdeasScreen({ ideas: IDEAS, briefs: BRIEFS });
    const headers = findAll(tree, 'SectionHeader').map((h) => String(h.props?.['label']));
    expect(headers).toContain('Compiled → awaiting your decision');
    const all = texts(tree).join(' ');
    expect(all).toContain('BRIEF');
    expect(all).toContain('Tray notification center');
    expect(all).toContain('delegation gated on your approval');
    expect(all).toContain('add tray badge → codex');
    expect(all).toContain('project agent-secretary');

    const approve = commands(tree).find((c) => c.startsWith('ideacmd:'));
    expect(approve).toBeDefined();
    const decoded = JSON.parse(decodeURIComponent(approve!.slice('ideacmd:'.length)));
    expect(decoded).toEqual({
      kind: 'brief-confirm',
      briefId: 'brief-1',
      confirmedBy: 'desktop',
    });
  });

  it('hides the awaiting section when no draft briefs exist', () => {
    const tree = renderIdeasScreen({
      ideas: IDEAS,
      briefs: { ok: true, briefs: [{ ...DRAFT_BRIEF, status: 'dispatched' }] },
    });
    expect(texts(tree).join(' ')).not.toContain('awaiting your decision');
  });

  it('renders the reader pane when a ledger is open', () => {
    const tree = renderIdeasScreen({
      ideas: IDEAS,
      briefs: BRIEFS,
      reader: {
        ideaId: 'idea-1',
        title: 'Multi-repo context sync',
        body: '## Research\nnotes here',
      },
    });
    const headers = findAll(tree, 'SectionHeader').map((h) => String(h.props?.['label']));
    expect(headers).toContain('Ledger — Multi-repo context sync');
    const all = texts(tree).join(' ');
    expect(all).toContain('## Research');
    expect(commands(tree)).toContain('ideaclose');
  });

  it('renders empty-state hints with no ledgers and degrades on failure', () => {
    const tree = renderIdeasScreen({
      ideas: { ok: false, ideas: [] },
      briefs: { ok: false, briefs: [] },
    });
    const all = texts(tree).join(' ');
    expect(all).toContain('no open ledgers');
  });
});

describe('encodeIdeaCommand', () => {
  it('round-trips a brief-compile payload through URI encoding', () => {
    const encoded = encodeIdeaCommand({
      kind: 'brief-compile',
      ideaId: 'idea-1',
      plan: { projectId: 'p', tasks: [{ objective: 'x — üñí ✓' }] },
    });
    expect(encoded.startsWith('ideacmd:')).toBe(true);
    expect(JSON.parse(decodeURIComponent(encoded.slice(8)))).toEqual({
      kind: 'brief-compile',
      ideaId: 'idea-1',
      plan: { projectId: 'p', tasks: [{ objective: 'x — üñí ✓' }] },
    });
  });
});
