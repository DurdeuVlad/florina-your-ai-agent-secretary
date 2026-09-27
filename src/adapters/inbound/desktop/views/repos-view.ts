/**
 * Settings > Repos view (issue #253): the folders the user keeps their
 * repos in, in scan/search priority order, plus the repos discovered
 * under them.
 *
 * Move-up/move-down/remove buttons carry an atomic, identity-by-path
 * command (`move-repo-root`/`remove-repo-root`) via the `reposcmd:` wire
 * verb — never a precomputed "replace the whole list" command. A row's
 * button is built against whatever root list was last rendered, and by
 * the time the user clicks it that list may be stale (another window,
 * or a concurrent add); resolving by path against current daemon state
 * at execution time means a stale click is either correct or a safe
 * no-op, never a clobber of an unrelated concurrent edit (see
 * `RepoRootsPort`'s doc comment for the incident this replaced).
 *
 * The "+ Add folder"/"Use default folder" actions can't be precomputed
 * this way either (their result depends on a native OS dialog the main
 * process runs at click time), so they carry the bare local verbs
 * `pickfolders`/`defaultfolder`, handled directly by `DesktopApp` before
 * reaching the daemon (mirrors the `deskset:` local-verb pattern).
 *
 * Empty roots is the onboarding state: the `EmptyState` here *is* the
 * onboarding surface (no separate modal), consistent with how the
 * Preferences/Memory sections already message "nothing configured yet".
 */
import type { DiscoveredRepo } from '../../../../core/application/use-cases/repos/discover-repos.js';
import type {
  RepoRoot,
  RepoRootsConfig,
} from '../../../../core/application/ports/outbound/repo-roots.js';
import type {
  MoveRepoRootCommand,
  RemoveRepoRootCommand,
} from '../../../../core/application/use-cases/tasks/command-api.js';
import type { RenderTree } from './view-types.js';

function el(
  tag: string,
  props?: Record<string, unknown>,
  children?: readonly (RenderTree | string)[],
): RenderTree {
  return { tag, props, children };
}

/** URI-encode a command payload for the `reposcmd:` wire verb. */
export function encodeReposCommand(cmd: MoveRepoRootCommand | RemoveRepoRootCommand): string {
  return `reposcmd:${encodeURIComponent(JSON.stringify(cmd))}`;
}

function rootRow(root: RepoRoot, index: number, total: number): RenderTree {
  const actions: RenderTree[] = [];
  if (index > 0) {
    const cmd: MoveRepoRootCommand = { kind: 'move-repo-root', path: root.path, direction: 'up' };
    actions.push(el('Button', { variant: 'ghost', command: encodeReposCommand(cmd) }, ['↑']));
  }
  if (index < total - 1) {
    const cmd: MoveRepoRootCommand = { kind: 'move-repo-root', path: root.path, direction: 'down' };
    actions.push(el('Button', { variant: 'ghost', command: encodeReposCommand(cmd) }, ['↓']));
  }
  const removeCmd: RemoveRepoRootCommand = { kind: 'remove-repo-root', path: root.path };
  actions.push(
    el(
      'Button',
      {
        variant: 'ghost',
        command: encodeReposCommand(removeCmd),
        confirm: 'Remove this folder from Florina’s scope? It can be re-added later.',
      },
      ['Remove'],
    ),
  );
  return el('ReposRootRow', { path: root.path, priority: index }, [
    el('ReposRootPriority', {}, [String(index + 1)]),
    el('ReposRootPath', {}, [root.path]),
    el('ReposRootActions', {}, actions),
  ]);
}

function repoRow(repo: DiscoveredRepo): RenderTree {
  return el('ReposRepoRow', { path: repo.path, rootPath: repo.rootPath }, [
    el('ReposRepoName', {}, [repo.name]),
    el('ReposRepoPath', {}, [repo.path]),
  ]);
}

export interface ReposViewInput {
  readonly roots: RepoRootsConfig;
  readonly repos: readonly DiscoveredRepo[];
  /** The search query in effect, when the view was built from a search (issue #253). */
  readonly query?: string;
}

/** Build the Settings > Repos view: ordered root folders + discovered repos. */
export function renderReposView(input: ReposViewInput): RenderTree {
  const addRow = el('ReposAddRow', {}, [
    el('Button', { variant: 'primary', command: 'pickfolders' }, ['+ Add folder']),
    el('Button', { variant: 'ghost', command: 'defaultfolder' }, ['Use default folder']),
  ]);

  if (input.roots.roots.length === 0) {
    return el('ReposView', {}, [
      addRow,
      el('EmptyState', {}, [el('EmptyHint', {}, ['add a folder so Florina can find your repos'])]),
    ]);
  }

  const total = input.roots.roots.length;
  const rootsSection = el(
    'ReposRootsSection',
    {},
    input.roots.roots.map((root, i) => rootRow(root, i, total)),
  );

  const repoListSection =
    input.repos.length === 0
      ? el('EmptyHint', {}, [
          input.query !== undefined && input.query.trim().length > 0
            ? 'no matching repos'
            : 'no repos found under these folders',
        ])
      : el('ReposRepoList', {}, input.repos.map(repoRow));

  return el('ReposView', {}, [addRow, rootsSection, repoListSection]);
}
