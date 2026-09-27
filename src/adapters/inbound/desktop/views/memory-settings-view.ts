/**
 * Settings' Memory/Rules browse view (issue #200/#223/#224,
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
 *
 * Forget/Promote (issue #224) encode the *real* `UpdatePreferenceCommand`
 * the caller built (via #224's `preferenceProfileToMemoryRows`) as a
 * `memcmd:<uri-encoded JSON>` command — the same wire-verb pattern as
 * `prefcmd:`/`chatcmd:`/`ideacmd:`, so the memory action goes through the
 * exact same daemon-side `update-preference` handler the conversational
 * path and the existing routing-rule cards use. No parallel write path.
 */
import type { MemoryItem, MemoryKind, MemoryScope } from '../../../../core/domain/memory.js';
import type { UpdatePreferenceCommand } from '../../../../core/application/use-cases/tasks/command-api.js';
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

/** URI-encode a command payload for the `memcmd:` wire verb. */
export function encodeMemoryCommand(cmd: UpdatePreferenceCommand): string {
  return `memcmd:${encodeURIComponent(JSON.stringify(cmd))}`;
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

/** One memory row plus whatever real write commands the caller has for it (#224). */
export interface MemoryRowInput {
  readonly item: MemoryItem;
  readonly forgetCommand?: UpdatePreferenceCommand;
  readonly promoteCommand?: UpdatePreferenceCommand;
}

function memoryRow(row: MemoryRowInput): RenderTree {
  const { item } = row;
  const actions: RenderTree[] = [];
  if (row.forgetCommand !== undefined) {
    actions.push(
      el(
        'Button',
        {
          variant: 'ghost',
          command: encodeMemoryCommand(row.forgetCommand),
          confirm: 'Forget this memory? It is removed from storage; the action is journaled.',
        },
        ['Forget'],
      ),
    );
  }
  if (row.promoteCommand !== undefined) {
    // Client confirms before sending (issue #224: "never silent") — now
    // via the shared data-confirm gate (#261).
    actions.push(
      el(
        'Button',
        {
          variant: 'ghost',
          command: encodeMemoryCommand(row.promoteCommand),
          confirm: 'Promote this rule to global scope?',
        },
        ['Promote to global'],
      ),
    );
  }
  return el(
    'MemoryRow',
    { itemId: item.id, scope: scopeLabel(item.scope), kind: item.kind, status: item.status },
    [
      el('MemoryStatement', {}, [item.statement]),
      el('MemoryMeta', {}, [
        el('Chip', { variant: 'slate' }, [item.kind]),
        el('Chip', { variant: 'slate' }, [scopeLabel(item.scope)]),
        el('Chip', { variant: item.provenance === 'explicit' ? 'green' : 'amber' }, [
          item.provenance,
        ]),
        el(
          'Chip',
          {
            variant:
              item.confidence === 'high'
                ? 'green'
                : item.confidence === 'medium'
                  ? 'amber'
                  : 'slate',
          },
          [`confidence: ${item.confidence}`],
        ),
        ...(item.status !== 'active' ? [el('Chip', { variant: 'amber' }, [item.status])] : []),
      ]),
      ...(actions.length > 0 ? [el('MemoryActions', {}, actions)] : []),
    ],
  );
}

/**
 * Build the Memory/Rules browse view. `rows` should already include
 * every kind the caller has a live source for (today: `preference`, via
 * `preferenceProfileToMemoryRows`); kinds with zero items simply render
 * with nothing under them, not an error.
 */
export function renderMemorySettingsView(rows: readonly MemoryRowInput[]): RenderTree {
  const filterBar = el('MemoryFilterBar', {}, [
    el('MemoryFilterChip', { filterKind: 'scope', value: '' }, ['All scopes']),
    el('MemoryFilterChip', { filterKind: 'scope', value: 'global' }, ['Global']),
    el('MemoryFilterChip', { filterKind: 'scope', value: 'project' }, ['Project']),
    el('MemoryFilterChip', { filterKind: 'kind', value: '' }, ['All kinds']),
    ...ALL_KINDS.map((k) => el('MemoryFilterChip', { filterKind: 'kind', value: k }, [k])),
  ]);

  if (rows.length === 0) {
    return el('MemorySettingsView', {}, [
      filterBar,
      el('EmptyState', {}, [el('EmptyHint', {}, ['nothing remembered yet'])]),
    ]);
  }

  const sorted = [...rows].sort((a, b) => b.item.updatedAt.localeCompare(a.item.updatedAt));
  return el('MemorySettingsView', {}, [filterBar, ...sorted.map(memoryRow)]);
}
