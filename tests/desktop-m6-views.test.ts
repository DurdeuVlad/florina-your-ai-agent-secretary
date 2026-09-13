/**
 * M6 desktop views (issue #74): fleet/quota, project, session
 * inspector, ideas, preferences, secretary, context health.
 * Each view is a pure transform into RenderTrees — these tests check
 * the data shaping, ordering, and the template output's key props.
 */
import { describe, it, expect } from 'vitest';

import {
  buildFleetView,
  renderFleetView,
  formatCountdown,
} from '../src/adapters/inbound/desktop/views/fleet-view.js';
import {
  buildProjectView,
  renderProjectView,
} from '../src/adapters/inbound/desktop/views/project-view.js';
import {
  buildSessionInspector,
  renderSessionInspector,
} from '../src/adapters/inbound/desktop/views/session-inspector-view.js';
import {
  buildIdeasView,
  renderIdeasView,
} from '../src/adapters/inbound/desktop/views/ideas-view.js';
import {
  buildPreferencesView,
  renderPreferencesView,
} from '../src/adapters/inbound/desktop/views/preferences-view.js';
import {
  buildSecretaryView,
  renderSecretaryView,
} from '../src/adapters/inbound/desktop/views/secretary-view.js';
import {
  buildContextHealthView,
  renderContextHealthView,
} from '../src/adapters/inbound/desktop/views/context-health-view.js';
import type { RenderTree } from '../src/adapters/inbound/desktop/views/view-types.js';
import type { ProviderQuotaState } from '../src/core/application/ports/outbound/quota-reader.js';
import type { TaskSnapshot } from '../src/core/application/use-cases/tasks/command-api.js';
import type { ContextHealthSnapshot } from '../src/core/application/use-cases/context/context-health-monitor.js';
import type { SupervisorEvent } from '../src/core/domain/events.js';

/** Find a node by tag anywhere in the tree. */
function findTag(tree: RenderTree, tag: string): RenderTree | undefined {
  if (tree.tag === tag) return tree;
  for (const child of tree.children ?? []) {
    if (typeof child !== 'string') {
      const found = findTag(child, tag);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function findAll(tree: RenderTree, tag: string): RenderTree[] {
  const out: RenderTree[] = [];
  const walk = (node: RenderTree | string): void => {
    if (typeof node === 'string') return;
    if (node.tag === tag) out.push(node);
    for (const c of node.children ?? []) walk(c);
  };
  walk(tree);
  return out;
}

const task = (id: string, state: string, objective = 'do it'): TaskSnapshot => ({
  id,
  projectId: 'proj-1',
  objective,
  state,
  agentIds: ['codex'],
  sessionIds: ['s1'],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  eventCount: 3,
});

/* ================================================================== *
 * Fleet/quota
 * ================================================================== */

describe('fleet view', () => {
  const provider = (over: Partial<ProviderQuotaState> = {}): ProviderQuotaState => ({
    provider: 'codex',
    available: true,
    exhaustedUntil: null,
    lastObservedAt: '2026-01-01T00:00:00Z',
    windows: [
      {
        provider: 'codex',
        window: 'five_hour',
        usedPct: 0.42,
        resetsAt: '2026-01-01T02:00:00Z',
        status: 'allowed',
        source: 'poll',
        observedAt: '2026-01-01T00:00:00Z',
      },
    ],
    ...over,
  });

  it('renders providers with utilization bars and availability', () => {
    const view = buildFleetView({
      providers: [provider()],
      tasks: [],
      now: '2026-01-01T00:00:00Z',
    });
    expect(view.providers[0]!.available).toBe(true);
    expect(view.providers[0]!.windows[0]!.resetsInMs).toBe(7_200_000);
    const tree = renderFleetView(view);
    expect(tree.tag).toBe('FleetView');
    const bar = findTag(tree, 'UtilizationBar');
    expect(bar?.props?.['pct']).toBe(0.42);
  });

  it('surfaces parked tasks and exhausted providers', () => {
    const view = buildFleetView({
      providers: [provider({ available: false, exhaustedUntil: '2026-01-01T03:00:00Z' })],
      tasks: [task('t1', 'blocked'), task('t2', 'running'), task('t3', 'attention-needed')],
      now: '2026-01-01T00:00:00Z',
    });
    expect(view.parkedTasks.map((t) => t.taskId)).toEqual(['t1', 't3']);
    const tree = renderFleetView(view);
    expect(findAll(tree, 'ParkedTask')).toHaveLength(2);
    expect(findTag(tree, 'ResetBadge')?.props?.['color']).toBe('red');
  });

  it('formatCountdown renders hours and minutes', () => {
    expect(formatCountdown(7_200_000)).toBe('2h');
    expect(formatCountdown(8_040_000)).toBe('2h 14m');
    expect(formatCountdown(300_000)).toBe('5m');
  });
});

/* ================================================================== *
 * Project view
 * ================================================================== */

describe('project view', () => {
  const health: ContextHealthSnapshot = {
    agentId: 'codex',
    taskId: 'm1',
    windowFillPct: 0.81,
    eventsSinceCondensation: 120,
    condensationCount: 2,
    status: 'degraded',
  };

  it('renders the manager card with context health + worker list', () => {
    const view = buildProjectView({
      projectId: 'proj-1',
      projectName: 'florina',
      manager: task('m1', 'running', 'manage project'),
      managerHealth: health,
      workers: [task('w1', 'running', 'build'), task('w2', 'blocked', 'verify')],
    });
    const tree = renderProjectView(view);
    const card = findTag(tree, 'ManagerCard');
    expect(card?.props?.['taskId']).toBe('m1');
    const badge = findTag(tree, 'HealthBadge');
    expect(badge?.props?.['color']).toBe('orange');
    expect(findAll(tree, 'WorkerRow')).toHaveLength(2);
    // Talk to the manager — the card carries the message command.
    const action = findTag(tree, 'Action');
    expect(action?.props?.['command']).toBe('manager-message');
  });

  it('handles a project with no manager', () => {
    const view = buildProjectView({
      projectId: 'p',
      projectName: 'x',
      workers: [],
    });
    const tree = renderProjectView(view);
    expect(findTag(tree, 'EmptyHint')).toBeDefined();
  });
});

/* ================================================================== *
 * Session inspector
 * ================================================================== */

describe('session inspector', () => {
  const events: SupervisorEvent[] = [
    {
      type: 'AgentStarted',
      timestamp: '2026-01-01T00:00:00Z',
      taskId: 't1',
      sessionId: 's1',
      agentId: 'codex',
      adapterFidelityTier: 'B',
      objective: 'fix',
      workingDir: '/wt',
    } as SupervisorEvent,
    {
      type: 'AgentProgress',
      timestamp: '2026-01-01T00:01:00Z',
      taskId: 't1',
      sessionId: 's1',
      agentId: 'codex',
      message: 'found the bug in auth.ts',
    } as SupervisorEvent,
    {
      type: 'FileChanged',
      timestamp: '2026-01-01T00:02:00Z',
      taskId: 't1',
      sessionId: 's1',
      agentId: 'codex',
      path: 'src/auth.ts',
      changeType: 'modified',
    } as SupervisorEvent,
    {
      type: 'AgentCompleted',
      timestamp: '2026-01-01T00:03:00Z',
      taskId: 't1',
      sessionId: 's1',
      agentId: 'codex',
    } as SupervisorEvent,
  ];

  it('tier B renders timeline → transcript → diff sections', () => {
    const view = buildSessionInspector({
      sessionId: 's1',
      fidelityTier: 'B',
      events,
    });
    expect(view.timeline).toHaveLength(4);
    expect(view.transcript).toHaveLength(1);
    expect(view.transcript[0]!.text).toContain('auth.ts');
    expect(view.diffs[0]!.path).toBe('src/auth.ts');
    expect(view.terminalState).toBe('completed');
    const tree = renderSessionInspector(view);
    expect(findAll(tree, 'InspectorSection')).toHaveLength(3);
  });

  it('tier D collapses to verified output only', () => {
    const view = buildSessionInspector({
      sessionId: 's1',
      fidelityTier: 'D',
      events,
    });
    expect(view.verifiedOutputOnly).toBe(true);
    expect(view.transcript).toHaveLength(0);
    // Timeline keeps only terminal + verification events.
    expect(view.timeline.map((t) => t.type)).toEqual(['AgentStarted', 'AgentCompleted']);
    const tree = renderSessionInspector(view);
    expect(findTag(tree, 'FidelityNotice')).toBeDefined();
  });
});

/* ================================================================== *
 * Ideas view
 * ================================================================== */

describe('ideas view', () => {
  it('renders the ledger directory + reader + brief gate card', () => {
    const view = buildIdeasView({
      ideas: [
        {
          id: 'i1',
          title: 'fleet failover',
          status: 'open',
          path: '/ideas/fleet.md',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-02T00:00:00Z',
        },
      ],
      selected: {
        ledger: {
          id: 'i1',
          title: 'fleet failover',
          status: 'open',
          path: '/ideas/fleet.md',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-02T00:00:00Z',
        },
        body: '## Notes\n\nsome ideas',
      },
      brief: {
        id: 'b1',
        ideaId: 'i1',
        title: 'fleet failover',
        spec: 'spec',
        plan: {
          projectId: 'proj-1',
          tasks: [{ objective: 'build it', preferProvider: 'codex' }],
        },
        status: 'draft',
        createdAt: '2026-01-02T00:00:00Z',
      },
    });
    const tree = renderIdeasView(view);
    expect(findAll(tree, 'IdeaRow')).toHaveLength(1);
    expect(findTag(tree, 'LedgerReader')).toBeDefined();
    const card = findTag(tree, 'BriefCard');
    expect(card?.props?.['status']).toBe('draft');
    const confirm = findAll(tree, 'Action').find((a) => a.props?.['command'] === 'brief-confirm');
    expect(confirm).toBeDefined();
  });

  it('a confirmed brief renders status instead of the gate', () => {
    const view = buildIdeasView({
      ideas: [],
      brief: {
        id: 'b1',
        ideaId: 'i1',
        title: 't',
        spec: 's',
        plan: { projectId: 'p', tasks: [] },
        status: 'confirmed',
        createdAt: '2026-01-02T00:00:00Z',
      },
    });
    const tree = renderIdeasView(view);
    expect(findTag(tree, 'GateStatus')).toBeDefined();
    expect(
      findAll(tree, 'Action').find((a) => a.props?.['command'] === 'brief-confirm'),
    ).toBeUndefined();
  });
});

/* ================================================================== *
 * Preferences view
 * ================================================================== */

describe('preferences view', () => {
  it('renders routing rules and denies with revoke commands', () => {
    const view = buildPreferencesView(
      {
        rules: [{ provider: 'codex', workTypes: ['heavy'] }, { provider: 'devin' }],
        denied: [{ provider: 'claude-code', model: 'opus-4' }],
      },
      { rules: ['voice', 'cli'], denied: ['voice'] },
    );
    expect(view.rules[0]!.provenance).toBe('voice');
    const tree = renderPreferencesView(view);
    expect(findAll(tree, 'RoutingRule')).toHaveLength(2);
    expect(findAll(tree, 'DenyRule')).toHaveLength(1);
    const remove = findAll(tree, 'Action').find(
      (a) => a.props?.['command'] === 'preference-remove-deny',
    );
    expect(remove?.props?.['args']).toEqual({
      provider: 'claude-code',
      model: 'opus-4',
    });
  });
});

/* ================================================================== *
 * Secretary view
 * ================================================================== */

describe('secretary view', () => {
  it('renders plan, in-flight research, and pending memories', () => {
    const view = buildSecretaryView({
      todos: [
        { id: 't1', content: 'research quota APIs', status: 'in_progress' },
        { id: 't2', content: 'draft brief', status: 'pending' },
      ],
      research: [
        { id: 'r1', query: 'codex quota', startedAt: '2026-01-01T00:00:00Z', ideaId: 'i1' },
      ],
      pendingMemories: [{ id: 'm1', summary: 'prefers codex for heavy work', scope: 'user' }],
    });
    const tree = renderSecretaryView(view);
    expect(findAll(tree, 'TodoRow')).toHaveLength(2);
    expect(findAll(tree, 'ResearchJob')).toHaveLength(1);
    expect(findAll(tree, 'PendingMemory')).toHaveLength(1);
  });
});

/* ================================================================== *
 * Context health view
 * ================================================================== */

describe('context health view', () => {
  const snap = (
    agentId: string,
    status: ContextHealthSnapshot['status'],
    fill = 0.5,
  ): ContextHealthSnapshot => ({
    agentId,
    windowFillPct: fill,
    eventsSinceCondensation: 10,
    condensationCount: 1,
    status,
  });

  it('sorts worst-first and renders fill bars', () => {
    const view = buildContextHealthView([
      snap('a-ok', 'ok', 0.2),
      snap('a-crit', 'critical', 0.95),
      snap('a-deg', 'degraded', 0.8),
    ]);
    expect(view.agents.map((a) => a.agentId)).toEqual(['a-crit', 'a-deg', 'a-ok']);
    expect(view.worstStatus).toBe('critical');
    const tree = renderContextHealthView(view);
    expect(findAll(tree, 'AgentHealthRow')).toHaveLength(3);
    const bar = findTag(tree, 'WindowFillBar');
    expect(bar?.props?.['pct']).toBe(0.95);
  });

  it('renders an empty hint when nothing is tracked', () => {
    const view = buildContextHealthView([]);
    expect(view.worstStatus).toBe('ok');
    const tree = renderContextHealthView(view);
    expect(findTag(tree, 'EmptyHint')).toBeDefined();
  });
});
