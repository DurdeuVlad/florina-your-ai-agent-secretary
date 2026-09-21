/**
 * Settings' Memory/Rules browse view (issue #200/#223,
 * docs/RULES_MEMORY_AND_SUPERVISION.md § 12).
 *
 * Lists memory rows (active/proposed/candidate/conflict) with provenance
 * and confidence per row, filterable by scope and kind client-side (data
 * attributes + a static filter bar, no new round-trip command — pure
 * read-composition, consistent with #221/#222's "no new query" pattern).
 *
 * Only the `preference` kind has a real backing store today — it's
 * derived from the same `PreferenceProfile` the existing routing-rule
 * cards already render (via #205's `preferenceProfileToMemoryItems`
 * bridge), so "existing preference editing continues to work, now shown
 * as the preference kind" holds without touching that code path at all.
 * Other kinds (rule/hard-policy/fact/project-knowledge/decision/
 * temporary-instruction/learned-pattern) have no `MemoryStorePort`
 * adapter yet (#204 landed the port, not an adapter, as an explicit,
 * documented follow-up) — this view renders an honest empty state for
 * them rather than fabricating rows.
 */
import type { MemoryItem, MemoryKind, MemoryScope } from '../../../../core/domain/memory.js';
import type { RenderTree } from './view-types.js';

function el(
  tag: string,
  props?: Record<string, unknown>,
  children?: readonly (RenderTree | string)[],
): RenderTree {
  return { tag, props, children };
}

function scopeLabel(scope: MemoryScope): string {
  if (scope.type === 'global') return 'global';
  if (scope.type === 'project') return `project:${scope.projectId}`;
  return `task:${scope.taskId}`;
}

/** Every kind #204 defined — the filter bar always offers all of them, even ones with zero live items today. */
const ALL_KINDS: readonly MemoryKind[] = [
  'fact',
  'preference',
  'rule',
  'hard-policy',
  'project-knowledge',
  'decision',
  'temporary-instruction',
  'learned-pattern',
];

function memoryRow(item: MemoryItem): RenderTree {
  const actions: RenderTree[] = [];
  // Only preference-kind items have a real write path today (mapped 1:1
  // onto the existing routing-rule/deny commands by the caller, issue
  // #224) -- other kinds render read-only until a MemoryStorePort
  // adapter exists to persist a mutation against.
  if (item.kind === 'preference') {
    actions.push(
      el('Button', { variant: 'ghost', command: `memforget:${item.id}` }, ['Forget']),
    );
    if (item.scope.type === 'project') {
      actions.push(
        el('Button', { variant: 'ghost', command: `mempromote:${item.id}` }, ['Promote to global']),
      );
    }
  }
  return el(
    'MemoryRow',
    { itemId: item.id, scope: scopeLabel(item.scope), kind: item.kind, status: item.status },
    [
      el('MemoryStatement', {}, [item.statement]),
      el('MemoryMeta', {}, [
        el('Chip', { variant: 'slate' }, [item.kind]),
        el('Chip', { variant: 'slate' }, [scopeLabel(item.scope)]),
        el('Chip', { variant: item.provenance === 'explicit' ? 'green' : 'amber' }, [item.provenance]),
        el('Chip', { variant: item.confidence === 'high' ? 'green' : item.confidence === 'medium' ? 'amber' : 'slate' }, [
          `confidence: ${item.confidence}`,
        ]),
        ...(item.status !== 'active' ? [el('Chip', { variant: 'amber' }, [item.status])] : []),
      ]),
      ...(actions.length > 0 ? [el('MemoryActions', {}, actions)] : []),
    ],
  );
}

/**
 * Build the Memory/Rules browse view. `items` should already include
 * every kind the caller has a live source for (today: `preference` via
 * the PreferenceProfile bridge); kinds with zero items simply render
 * with nothing under them, not an error.
 */
export function renderMemorySettingsView(items: readonly MemoryItem[]): RenderTree {
  const filterBar = el(
    'MemoryFilterBar',
    {},
    [
      el('MemoryFilterChip', { filterKind: 'scope', value: '' }, ['All scopes']),
      el('MemoryFilterChip', { filterKind: 'scope', value: 'global' }, ['Global']),
      el('MemoryFilterChip', { filterKind: 'scope', value: 'project' }, ['Project']),
      el('MemoryFilterChip', { filterKind: 'kind', value: '' }, ['All kinds']),
      ...ALL_KINDS.map((k) => el('MemoryFilterChip', { filterKind: 'kind', value: k }, [k])),
    ],
  );

  if (items.length === 0) {
    return el('MemorySettingsView', {}, [
      filterBar,
      el('EmptyState', {}, [el('EmptyHint', {}, ['nothing remembered yet'])]),
    ]);
  }

  const sorted = [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return el('MemorySettingsView', {}, [filterBar, ...sorted.map(memoryRow)]);
}
