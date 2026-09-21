/**
 * Settings > Repos view (issue #253): the folders the user keeps their
 * repos in, in scan/search priority order, plus the repos discovered
 * under them.
 *
 * Move-up/move-down/remove buttons carry a fully precomputed
 * `set-repo-roots` command (the *resulting* ordered path list) via the
 * `reposcmd:` wire verb — the same "server composes the exact command,
 * renderer just mounts it" pattern as #224's memory-actions rows. The
 * "+ Add folder"/"Use default folder" actions can't be precomputed this
 * way (their result depends on a native OS dialog the main process runs
 * at click time), so they carry the bare local verbs `pickfolders`/
 * `defaultfolder`, handled directly by `DesktopApp` before reaching the
 * daemon (mirrors the `deskset:` local-verb pattern).
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
import type { SetRepoRootsCommand } from '../../../../core/application/use-cases/tasks/command-api.js';
import type { RenderTree } from './view-types.js';

function el(
  tag: string,
  props?: Record<string, unknown>,
  children?: readonly (RenderTree | string)[],
): RenderTree {
  return { tag, props, children };
}

/** URI-encode a command payload for the `reposcmd:` wire verb. */
export function encodeReposCommand(cmd: SetRepoRootsCommand): string {
  return `reposcmd:${encodeURIComponent(JSON.stringify(cmd))}`;
}

function setRootsTo(paths: readonly string[]): SetRepoRootsCommand {
  return { kind: 'set-repo-roots', paths };
}

function rootRow(roots: readonly RepoRoot[], index: number): RenderTree {
  const paths = roots.map((r) => r.path);
  const withoutThis = [...paths.slice(0, index), ...paths.slice(index + 1)];
  const actions: RenderTree[] = [];
  if (index > 0) {
    const swapped = [...paths];
    [swapped[index - 1], swapped[index]] = [swapped[index]!, swapped[index - 1]!];
    actions.push(
      el('Button', { variant: 'ghost', command: encodeReposCommand(setRootsTo(swapped)) }, ['↑']),
    );
  }
  if (index < roots.length - 1) {
    const swapped = [...paths];
    [swapped[index], swapped[index + 1]] = [swapped[index + 1]!, swapped[index]!];
    actions.push(
      el('Button', { variant: 'ghost', command: encodeReposCommand(setRootsTo(swapped)) }, ['↓']),
    );
  }
  actions.push(
    el(
      'Button',
      { variant: 'ghost', command: encodeReposCommand(setRootsTo(withoutThis)) },
      ['Remove'],
    ),
  );
  return el('ReposRootRow', { path: roots[index]!.path, priority: index }, [
    el('ReposRootPriority', {}, [String(index + 1)]),
    el('ReposRootPath', {}, [roots[index]!.path]),
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
      el('EmptyState', {}, [
        el('EmptyHint', {}, ['add a folder so Florina can find your repos']),
      ]),
    ]);
  }

  const rootsSection = el(
    'ReposRootsSection',
    {},
    input.roots.roots.map((_, i) => rootRow(input.roots.roots, i)),
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
