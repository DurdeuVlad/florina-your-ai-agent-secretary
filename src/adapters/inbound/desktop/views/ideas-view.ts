/**
 * Ideas view (issue #74, DEC-033): the global ledger directory, a
 * reader for the selected ledger, and the "Compile Brief" gate card —
 * review before anything dispatches.
 *
 * Pure view model + {@link RenderTree} template over {@link IdeaLedger}
 * index entries, ledger markdown bodies, and {@link Brief}s.
 */
import type { Brief, IdeaLedger, IdeaStatus } from '../../../../core/domain/ideas.js';
import type { RenderTree } from './view-types.js';

/** Display metadata per idea status. */
export const IDEA_STATUS_METADATA: Readonly<
  Record<IdeaStatus, { icon: string; color: string; label: string }>
> = {
  open: { icon: 'pencil', color: 'blue', label: 'Open' },
  promoted: { icon: 'folder', color: 'amber', label: 'Promoted' },
  compiled: { icon: 'document', color: 'green', label: 'Compiled' },
  archived: { icon: 'archive', color: 'slate', label: 'Archived' },
};

/** One row in the ledger directory. */
export interface IdeaRowView {
  readonly id: string;
  readonly title: string;
  readonly status: IdeaStatus;
  readonly projectId?: string;
  readonly updatedAt: string;
}

/** The compiled-Brief review card (the DEC-033 delegation gate). */
export interface BriefCardView {
  readonly id: string;
  readonly ideaId: string;
  readonly title: string;
  readonly status: Brief['status'];
  readonly projectId: string;
  readonly taskCount: number;
  readonly tasks: readonly { objective: string; provider?: string }[];
}

/** Full ideas view: directory + optional selected ledger + brief card. */
export interface IdeasViewData {
  readonly ideas: readonly IdeaRowView[];
  /** Markdown body of the selected ledger, when one is open. */
  readonly selected?: { id: string; title: string; body: string };
  /** The selected ledger's compiled brief, when one exists. */
  readonly brief?: BriefCardView;
  readonly isEmpty: boolean;
}

/** Build the ideas view from ledger index entries. */
export function buildIdeasView(input: {
  readonly ideas: readonly IdeaLedger[];
  readonly selected?: { readonly ledger: IdeaLedger; readonly body: string };
  readonly brief?: Brief;
}): IdeasViewData {
  const rows = [...input.ideas]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((i) => ({
      id: i.id,
      title: i.title,
      status: i.status,
      ...(i.projectId !== undefined ? { projectId: i.projectId } : {}),
      updatedAt: i.updatedAt,
    }));
  const brief = input.brief;
  return {
    ideas: rows,
    ...(input.selected !== undefined
      ? {
          selected: {
            id: input.selected.ledger.id,
            title: input.selected.ledger.title,
            body: input.selected.body,
          },
        }
      : {}),
    ...(brief !== undefined
      ? {
          brief: {
            id: brief.id,
            ideaId: brief.ideaId,
            title: brief.title,
            status: brief.status,
            projectId: brief.plan.projectId,
            taskCount: brief.plan.tasks.length,
            tasks: brief.plan.tasks.map((t) => ({
              objective: t.objective,
              ...(t.preferProvider !== undefined ? { provider: t.preferProvider } : {}),
            })),
          },
        }
      : {}),
    isEmpty: rows.length === 0,
  };
}

function el(
  tag: string,
  props?: Record<string, unknown>,
  children?: readonly (RenderTree | string)[],
): RenderTree {
  return { tag, props, children };
}

/** Render one ledger directory row. */
export function renderIdeaRow(view: IdeaRowView): RenderTree {
  const meta = IDEA_STATUS_METADATA[view.status];
  return el('IdeaRow', { ideaId: view.id, status: view.status }, [
    el('Icon', { name: meta.icon, color: meta.color }, []),
    el('IdeaTitle', {}, [view.title]),
    el('StatusBadge', { color: meta.color }, [meta.label]),
    el('Timestamp', {}, [view.updatedAt]),
  ]);
}

/**
 * Render the Brief review card — the human's delegation gate
 * (DEC-033). The confirm action is a string command; the renderer
 * dispatches it to `brief-confirm` on the command API.
 */
export function renderBriefCard(view: BriefCardView): RenderTree {
  return el('BriefCard', { briefId: view.id, ideaId: view.ideaId, status: view.status }, [
    el('BriefTitle', {}, [view.title]),
    el(
      'BriefTasks',
      {},
      view.tasks.map((t) => el('BriefTask', { provider: t.provider ?? 'auto' }, [t.objective])),
    ),
    view.status === 'draft'
      ? el('GateActions', { layout: 'row', gap: 'sm' }, [
          el('Action', {
            command: 'brief-confirm',
            args: { briefId: view.id },
            color: 'green',
            /* DEC-033 hard gate — approval delegates the plan to agents */
            confirm: 'Approve this brief? Its tasks will be delegated to agents.',
          }),
          el('Action', {
            command: 'brief-reject',
            args: { briefId: view.id },
            color: 'slate',
            confirm: 'Reject this compiled brief? The decision is journaled.',
          }),
        ])
      : el('GateStatus', { status: view.status }, [view.status]),
  ]);
}

/** Render the full ideas panel: directory + reader + brief card. */
export function renderIdeasView(view: IdeasViewData): RenderTree {
  return el('IdeasView', { empty: view.isEmpty }, [
    el(
      'IdeaDirectory',
      {},
      view.ideas.length > 0
        ? view.ideas.map(renderIdeaRow)
        : [el('EmptyHint', {}, ['no idea ledgers yet — talk to the Florina'])],
    ),
    ...(view.selected !== undefined
      ? [
          el('LedgerReader', { ideaId: view.selected.id, title: view.selected.title }, [
            el('MarkdownBody', {}, [view.selected.body]),
          ]),
        ]
      : []),
    ...(view.brief !== undefined ? [renderBriefCard(view.brief)] : []),
  ]);
}
