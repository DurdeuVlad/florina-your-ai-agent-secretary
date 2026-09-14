/**
 * Ideas screen (issue #129, mockup `docs/mockups/ideas.html`, DEC-033).
 *
 * Renders `idea-list` + `brief-list` responses into the mockup's card
 * vocabulary:
 *
 *  - **Open**: a card per open/promoted ledger — title, `N entries` chip,
 *    body preview, `project · last touched <date> · status` meta, and
 *    Compile brief / Read ledger actions.
 *  - **Compiled → awaiting your decision**: draft Briefs as inbox-style
 *    cards with a BRIEF chip and the delegation plan; `Review & approve`
 *    sends `brief-confirm` — the DEC-033 hard gate.
 *  - **Reader**: `Read ledger` opens the markdown body inline (Back
 *    clears it).
 *
 * Mutation commands are `ideacmd:<uri-encoded JSON>` payloads validated
 * main-side against a whitelist of idea/brief command kinds (same
 * discipline as `prefcmd:` on the prefs screen). `idearead:` /
 * `ideaclose` / `ideaadd` / `ideacompile:` are view verbs — the reader
 * pull is daemon-backed, the forms are renderer-local.
 */
import type {
  BriefListResponse,
  IdeaListItem,
  IdeaListResponse,
  Command,
} from '../../../../core/application/use-cases/tasks/command-api.js';
import type { Brief } from '../../../../core/domain/ideas.js';
import type { RenderTree } from './view-types.js';

/** Idea/brief command kinds the `ideacmd:` verb is allowed to carry. */
export const IDEACMD_KINDS = new Set([
  'idea-create',
  'idea-append',
  'brief-compile',
  'brief-confirm',
]);

/** URI-encode an idea/brief command payload for the `ideacmd:` verb. */
export function encodeIdeaCommand(cmd: Command): string {
  return `ideacmd:${encodeURIComponent(JSON.stringify(cmd))}`;
}

function el(
  tag: string,
  props?: Record<string, unknown>,
  children?: readonly (RenderTree | string)[],
): RenderTree {
  return { tag, props, children };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-09-15T…` → `Sep 15`. */
function shortDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (m === null) return iso;
  const month = MONTHS[Number.parseInt(m[2]!, 10) - 1];
  return month === undefined ? iso : `${month} ${Number.parseInt(m[3]!, 10)}`;
}

function ideaCard(idea: IdeaListItem): RenderTree {
  const meta = [
    ...(idea.projectId !== undefined ? [idea.projectId] : []),
    `last touched ${shortDate(idea.updatedAt)}`,
    `status: ${idea.status}`,
  ].join(' · ');
  return el('PrefCard', {}, [
    el('PrefTop', {}, [
      el('PrefKind', {}, [idea.title]),
      el('Chip', {}, [`${idea.entryCount} ${idea.entryCount === 1 ? 'entry' : 'entries'}`]),
      ...(idea.projectId !== undefined
        ? [el('Chip', { variant: 'amber' }, [`project:${idea.projectId}`])]
        : []),
    ]),
    el('PrefNote', {}, [idea.preview !== '' ? idea.preview : '(empty ledger)']),
    el('PrefMeta', {}, [meta]),
    el('PrefActions', {}, [
      el('Button', { variant: 'ghost', command: `ideacompile:${idea.id}` }, ['Compile brief']),
      el('Button', { variant: 'ghost', command: `idearead:${idea.id}` }, ['Read ledger']),
    ]),
  ]);
}

function briefCard(brief: Brief): RenderTree {
  const plan = brief.plan.tasks
    .map((t) => `· ${t.objective}${t.preferProvider !== undefined ? ` → ${t.preferProvider}` : ''}`)
    .join('\n');
  return el('PrefCard', { priority: 'Medium' }, [
    el('PrefTop', {}, [
      el('Chip', { variant: 'amber' }, ['BRIEF']),
      el('PrefKind', {}, [brief.title]),
    ]),
    el('PrefNote', {}, [
      `Brief compiled ${shortDate(brief.createdAt)} — delegation gated on your approval (DEC-033)`,
    ]),
    el('DetailMono', {}, [`project ${brief.plan.projectId}\n${plan}`]),
    el('PrefActions', {}, [
      el(
        'Button',
        {
          command: encodeIdeaCommand({
            kind: 'brief-confirm',
            briefId: brief.id,
            confirmedBy: 'desktop',
          }),
        },
        ['Review & approve'],
      ),
    ]),
  ]);
}

export interface IdeasScreenInput {
  readonly ideas: IdeaListResponse;
  readonly briefs: BriefListResponse;
  /** Open reader: the ledger's title + markdown body. */
  readonly reader?: { readonly ideaId: string; readonly title: string; readonly body: string };
}

/** Build the ideas screen tree from `idea-list` + `brief-list` responses. */
export function renderIdeasScreen(input: IdeasScreenInput): RenderTree {
  const children: RenderTree[] = [];
  const ideas = input.ideas.ok ? input.ideas.ideas : [];
  const briefs = input.briefs.ok ? input.briefs.briefs : [];

  if (input.reader !== undefined) {
    children.push(
      el('SectionHeader', { label: `Ledger — ${input.reader.title}` }, []),
      el('PrefCard', {}, [
        el('DetailMono', {}, [input.reader.body !== '' ? input.reader.body : '(empty ledger)']),
        el('PrefActions', {}, [
          el('Button', { variant: 'ghost', command: 'ideaclose' }, ['← Back']),
        ]),
      ]),
    );
  }

  children.push(
    el('PrefAddBar', {}, [el('Button', { variant: 'ghost', command: 'ideaadd' }, ['+ New idea'])]),
  );

  const open = ideas.filter((i) => i.status === 'open' || i.status === 'promoted');
  children.push(
    el('SectionHeader', { label: 'Open' }, [el('SectionCount', {}, [String(open.length)])]),
  );
  if (open.length === 0) {
    children.push(
      el('EmptyState', {}, [
        el('EmptyHint', {}, ['no open ledgers — talk to Florina or start one above']),
      ]),
    );
  } else {
    children.push(...open.map(ideaCard));
  }

  const awaiting = briefs.filter((b) => b.status === 'draft');
  if (awaiting.length > 0) {
    children.push(
      el('SectionHeader', { label: 'Compiled → awaiting your decision' }, [
        el('SectionCount', {}, [String(awaiting.length)]),
      ]),
      ...awaiting.map(briefCard),
    );
  }

  return el('PrefsView', {}, children);
}
