/**
 * First-run setup panel (issue #277): a guided, one-step-at-a-time card
 * rendered at the top of the Florina home view — not a sixth nav
 * destination (docs/UX_ONBOARDING_AUDIT.md state inventory).
 *
 * Renders the current setup step from observable facts only:
 *
 *  - welcome  — what Florina is + the install-path chooser (packaged app
 *               vs. run-from-source), with skip/resume
 *  - apps     — which supported coding apps were detected (`found` means
 *               the executable exists and its adapter registered — never
 *               that the user is signed in) plus a plain-language next
 *               step per missing app and a Check-again path
 *  - folder   — explains folder scope BEFORE the native picker opens,
 *               then shows the chosen folders and discovered projects
 *  - done     — an honest readiness summary (missing pieces stay
 *               visible as missing) and one next action
 *
 * All verbs are `setup:*` strings handled main-side by
 * `DesktopApp.handleSetupCommand`; the folder buttons reuse the existing
 * `pickfolders`/`defaultfolder` verbs unchanged (issue #253).
 */
import type { RenderTree } from './view-types.js';

function el(
  tag: string,
  props?: Record<string, unknown>,
  children?: readonly (RenderTree | string)[],
): RenderTree {
  return { tag, props, children };
}

export type SetupStep = 'welcome' | 'apps' | 'folder' | 'done';

/** How the user is running Florina — drives which setup facts apply. */
export type SetupInstallMode = 'packaged' | 'source';

/** One provider's probe outcome, as reported by `query-providers`. */
export interface SetupProvider {
  readonly id: string;
  readonly found: boolean;
  readonly detail?: string;
  /**
   * Best-effort sign-in state (issue #294) — `undefined` when the
   * daemon predates the field; absent state renders honestly as
   * "couldn't check sign-in".
   */
  readonly auth?: 'signed-in' | 'found-not-signed-in' | 'auth-failing' | 'unknown';
  /** Plain-language failure reason for `auth-failing` rows. */
  readonly authDetail?: string;
  /** The provider's fix recipe — drives the row's action button. */
  readonly fix?: {
    readonly kind: 'run-command' | 'store-key' | 'set-env';
    readonly label: string;
    readonly detail: string;
  };
  /**
   * On `found:false` rows only: a verified official installer exists
   * for this platform — gate for the Install button (never a dead one).
   */
  readonly installable?: boolean;
}

/** Secretary chat-model readiness, as reported by `query-providers`. */
export interface SetupChatModel {
  readonly configured: boolean;
  readonly keySource: 'env' | 'vault' | 'none';
  readonly state:
    'ok' | 'auth-failing' | 'misconfigured' | 'unreachable' | 'unknown' | 'unconfigured';
  readonly detail?: string;
}

export interface SetupViewInput {
  readonly step: SetupStep;
  readonly installMode: SetupInstallMode;
  readonly providers: readonly SetupProvider[];
  /** Configured project-folder roots (query-repos `roots`). */
  readonly roots: readonly string[];
  /** Projects discovered under the roots. */
  readonly repos: readonly { readonly name: string; readonly path: string }[];
  /**
   * Whether a well-formed provider response actually arrived this
   * session. Checked-and-empty renders "none found"; never-checked
   * renders "couldn't check" — the panel never asserts an empty world
   * on a failed or missing query.
   */
  readonly providersChecked: boolean;
  /** Same honesty flag for the repo-roots query. */
  readonly reposChecked: boolean;
  /** Chat-model readiness — absent on daemons that predate the field. */
  readonly chatModel?: SetupChatModel;
  /** Whether the daemon is reachable — offline facts can't be re-checked. */
  readonly daemonOnline: boolean;
}

/** Plain display names — provider ids never reach the user verbatim. */
const PROVIDER_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  devin: 'Devin',
  gemini: 'Gemini CLI',
  antigravity: 'Antigravity',
  copilot: 'GitHub Copilot',
  opencode: 'OpenCode',
  all: 'Provider detection',
};

/** Display order for known ids; unknown ids append in probe order. */
const PROVIDER_ORDER = [
  'claude-code',
  'codex',
  'devin',
  'gemini',
  'antigravity',
  'copilot',
  'opencode',
];

/** Plain display name for a provider id — shared with the chat context line. */
export function providerLabel(id: string): string {
  return PROVIDER_LABELS[id] ?? id;
}

function providerOrder(id: string): number {
  const i = PROVIDER_ORDER.indexOf(id);
  return i === -1 ? 99 : i;
}

/**
 * Translate a probe skip reason into a calm next step — the line answers
 * "what do I do now?" honestly. The probe runs at daemon start and a
 * running daemon can't see apps installed after it started, so the
 * recovery for a real install is restarting Florina's background helper —
 * never "Check again" (which only re-reads the last probe's facts).
 */
function skipHint(detail: string | undefined): string {
  if (detail === undefined) return 'not detected on this machine';
  if (detail.includes('FLORINA_PROVIDERS') || detail.includes('FLORINA_DISABLED_PROVIDERS'))
    return 'turned off by an environment setting on this machine';
  if (detail.includes('failed to start'))
    return 'installed, but it didn’t start — restart it, then restart Florina’s helper (tray → Stop daemon)';
  return (
    'not installed — install it and sign in once in that app. If it’s already ' +
    'installed, restart Florina’s helper (tray → Stop daemon) so it rescans'
  );
}

function actionsRow(children: readonly RenderTree[]): RenderTree {
  return el('SetupActions', {}, children);
}

function renderWelcome(input: SetupViewInput): RenderTree[] {
  const modes: RenderTree[] = (
    [
      ['packaged', 'I installed the app'],
      ['source', 'I built it from source'],
    ] as const
  ).map(([mode, label]) =>
    el(
      'Button',
      // Selection shows as a ✓ prefix — "Set up" stays the only primary
      // action so the step keeps one obvious forward path.
      { variant: 'ghost', command: `setup:mode:${mode}` },
      [input.installMode === mode ? `✓ ${label}` : label],
    ),
  );
  return [
    el('SetupStepTitle', {}, ['Welcome to Florina']),
    el('SetupStepBody', {}, [
      'Florina watches the coding apps on this machine and brings everything that needs you ' +
        'into one place — one inbox instead of many windows.',
    ]),
    el('SetupStepBody', { color: 'muted' }, ['How are you running Florina?']),
    el('SetupModeRow', {}, modes),
    el('SetupStepBody', { color: 'muted' }, [
      input.installMode === 'packaged'
        ? 'Everything Florina needs starts with the app — no terminal required.'
        : 'Keep the `florina start` terminal running — the app talks to that background service.',
    ]),
    actionsRow([
      el('Button', { variant: 'primary', command: 'setup:next' }, ['Set up']),
      el('Button', { variant: 'ghost', command: 'setup:skip' }, ['Skip for now']),
    ]),
  ];
}

/**
 * Plain-language sign-in state for an installed provider (issue #294).
 * `signed-in` is honestly hedged — credentials on disk can still be
 * dead until a real failure says so.
 */
function authHint(p: SetupProvider): string {
  switch (p.auth) {
    case 'signed-in':
      return 'looks signed in — credentials are on this machine';
    case 'found-not-signed-in':
      return 'installed but not signed in';
    case 'auth-failing':
      return `sign-in is failing${p.authDetail !== undefined ? ` — ${p.authDetail}` : ''}`;
    case undefined:
      return 'installed; sign-in happens inside the app itself';
    case 'unknown':
      // A classified non-auth failure (network/quota/missing) leaves real
      // detail behind — show it instead of pretending nothing happened.
      return p.authDetail !== undefined
        ? `installed — last check reported a problem: ${p.authDetail}`
        : 'installed; sign-in happens inside the app itself';
  }
}

function renderApps(input: SetupViewInput): RenderTree[] {
  const sorted = [...input.providers].sort(
    (a, b) => providerOrder(a.id) - providerOrder(b.id) || Number(b.found) - Number(a.found),
  );
  const rows: RenderTree[] = sorted.map((p) => {
    const children: RenderTree[] = [
      el('SetupItemName', {}, [`${providerLabel(p.id)} — ${p.found ? 'found' : 'not found'}`]),
      el('SetupItemHint', {}, [p.found ? authHint(p) : skipHint(p.detail)]),
    ];
    // A provider that needs sign-in gets its own action button —
    // `setup:signin:<id>` opens the provider's native login in a visible
    // terminal via the daemon. Only on `found` rows: a missing binary
    // can't run its own login command.
    if (
      p.found &&
      p.fix !== undefined &&
      (p.auth === 'found-not-signed-in' || p.auth === 'auth-failing')
    ) {
      if (p.fix.kind === 'run-command') {
        children.push(
          el('SetupItemAction', {}, [
            el('Button', { variant: 'primary', command: `setup:signin:${p.id}` }, [p.fix.label]),
          ]),
        );
      } else {
        // set-env/store-key: there is no button to press — the fix is
        // the instruction itself, so render it as text, not a verb.
        children.push(el('SetupItemHint', {}, [`${p.fix.label}: ${p.fix.detail}`]));
      }
    }
    // Not-found rows offer Install only when the daemon verified an
    // official installer exists for this OS (`installable`) — a dead
    // button is worse than none. The verb is the consent: the installer
    // runs in a visible terminal, never silently.
    if (!p.found && p.installable === true) {
      children.push(
        el('SetupItemAction', {}, [
          el('Button', { variant: 'secondary', command: `setup:install:${p.id}` }, [
            `Install ${providerLabel(p.id)}`,
          ]),
        ]),
      );
    }
    const color = !p.found
      ? 'muted'
      : p.auth === 'found-not-signed-in' ||
          p.auth === 'auth-failing' ||
          (p.auth === 'unknown' && p.authDetail !== undefined)
        ? 'warn'
        : p.auth === 'signed-in'
          ? 'success'
          : 'muted';
    return el('SetupItem', { color }, children);
  });
  const body: RenderTree[] = [
    el('SetupStepTitle', {}, ['Check your coding apps']),
    el('SetupStepBody', {}, [
      'Florina looked for supported coding apps on this machine. “Found” means the app is ' +
        'installed — it does not mean you are signed in. Florina never asks for your ' +
        'passwords or keys; sign-in always happens inside the app itself.',
    ]),
  ];
  if (!input.daemonOnline) {
    body.push(
      el('SetupStepBody', { color: 'muted' }, [
        'Florina can’t check right now — it’s not connected to its background service. ' +
          'Once the status dot turns on, use Check again.',
      ]),
    );
  } else if (!input.providersChecked) {
    body.push(
      el('SetupStepBody', { color: 'muted' }, [
        'Florina couldn’t get an answer just now — Check again retries. If it keeps ' +
          'happening, restart Florina’s helper (tray → Stop daemon) and reopen Florina.',
      ]),
    );
  } else if (input.providers.length === 0) {
    body.push(
      el('SetupStepBody', { color: 'muted' }, [
        'No supported coding apps are set up yet. You can continue anyway — Florina just ' +
          'can’t run tasks until one is installed and signed in.',
      ]),
    );
  } else {
    body.push(el('SetupList', {}, rows));
  }
  // Chat-model row (issue #294): Florina's own brain needs a key too —
  // surface it whenever the daemon answered, even with zero providers
  // found. `navto:prefs` deep-links the API-keys card.
  const chat = input.chatModel;
  // `chatModelStatus` doesn't depend on the provider probe — render it
  // whenever the daemon answered, even when providers weren't checked.
  if (input.daemonOnline && chat !== undefined) {
    const chatChildren: RenderTree[] = [
      el('SetupItemName', {}, ['Florina’s chat brain — ' + chatStateLabel(chat)]),
      el('SetupItemHint', {}, [chat.detail !== undefined ? chat.detail : chatHintFor(chat)]),
    ];
    // The key CTA shows only when a key could actually fix it:
    // auth-failing (key rejected), or unknown+no-key (worth storing
    // one before first use). 'misconfigured' needs the env var the
    // detail names; 'unreachable' is connectivity; 'unconfigured'
    // needs env vars + restart. No nag for a working keyless model.
    if (chat.state === 'auth-failing' || (chat.state === 'unknown' && chat.keySource === 'none')) {
      chatChildren.push(
        el('SetupItemAction', {}, [
          el('Button', { variant: 'primary', command: 'navto:prefs' }, ['Add a model key']),
        ]),
      );
    }
    body.push(
      el('SetupList', {}, [
        el(
          'SetupItem',
          {
            color:
              chat.state === 'ok'
                ? 'success'
                : chat.state === 'auth-failing' ||
                    chat.state === 'misconfigured' ||
                    chat.state === 'unconfigured' ||
                    chat.keySource === 'none'
                  ? 'warn'
                  : 'muted',
          },
          chatChildren,
        ),
      ]),
    );
  }
  body.push(
    actionsRow([
      el('Button', { variant: 'primary', command: 'setup:next' }, ['Continue']),
      el('Button', { variant: 'ghost', command: 'setup:recheck' }, ['Check again']),
      el('Button', { variant: 'ghost', command: 'setup:back' }, ['Back']),
    ]),
  );
  return body;
}

/** One-line label for the chat-model row — honest about evidence. */
function chatStateLabel(chat: SetupChatModel): string {
  switch (chat.state) {
    case 'ok':
      return 'working';
    case 'auth-failing':
      return 'its key is being rejected';
    case 'misconfigured':
      return 'a setting it needs is missing';
    case 'unreachable':
      return 'can’t reach its model service';
    case 'unconfigured':
      return 'not set up';
    default:
      return 'set up but untested';
  }
}

function chatHintFor(chat: SetupChatModel): string {
  if (chat.state === 'unconfigured') {
    // No connector exists at all — a stored key alone changes nothing.
    // Name the env vars + restart instead of pointing at the vault.
    return (
      'no chat model is configured — set FLORINA_LITELLM_URL and FLORINA_MODEL ' +
      'on the helper (see docs/INSTALL.md), restart it, then add a key below'
    );
  }
  if (chat.state === 'misconfigured') {
    // A config-class turn failure (missing env var etc.) — the detail
    // names it; a key is NOT the fix.
    return 'check the error above — it names the missing setting; set it and restart the helper';
  }
  if (chat.state === 'auth-failing' || chat.keySource === 'none') {
    return 'needs a model API key — store it once in Settings';
  }
  const source =
    chat.keySource === 'vault' ? 'key stored in Florina’s vault' : 'key from the environment';
  return `key source: ${source}`;
}

function renderFolder(input: SetupViewInput): RenderTree[] {
  const body: RenderTree[] = [
    el('SetupStepTitle', {}, ['Choose a project folder']),
    el('SetupStepBody', {}, [
      'Pick the folder where you keep your projects. Florina will look inside it for ' +
        'repositories — it never looks outside the folders you choose, and you can remove ' +
        'a folder later in Settings.',
    ]),
  ];
  if (!input.daemonOnline) {
    body.push(
      el('SetupStepBody', { color: 'muted' }, [
        'Florina isn’t connected to its background service — picking a folder needs it; ' +
          'wait for the status dot first.',
      ]),
    );
  } else if (!input.reposChecked) {
    body.push(
      el('SetupStepBody', { color: 'muted' }, [
        'Florina couldn’t check your folders just now — you can still pick one below.',
      ]),
    );
  }
  if (input.roots.length > 0) {
    body.push(
      el('SetupList', {}, [
        ...input.roots.map((root) =>
          el('SetupItem', {}, [
            el('SetupItemName', {}, ['Watching']),
            el('SetupItemHint', {}, [root]),
          ]),
        ),
        ...input.repos.map((repo) =>
          el('SetupItem', { color: 'success' }, [
            el('SetupItemName', {}, [repo.name]),
            el('SetupItemHint', {}, [repo.path]),
          ]),
        ),
      ]),
    );
    body.push(
      el('SetupStepBody', { color: 'muted' }, [
        input.repos.length > 0
          ? `Florina found ${input.repos.length} project${input.repos.length === 1 ? '' : 's'} inside.`
          : 'Folder added, but Florina didn’t find a project inside it — pick a different ' +
            'folder, or continue and add one later.',
      ]),
    );
  }
  const buttons: RenderTree[] =
    input.roots.length === 0
      ? [
          el('Button', { variant: 'primary', command: 'pickfolders' }, ['Choose folder']),
          el('Button', { variant: 'ghost', command: 'defaultfolder' }, ['Use default folder']),
          el('Button', { variant: 'ghost', command: 'setup:next' }, ['Continue anyway']),
        ]
      : [
          el('Button', { variant: 'primary', command: 'setup:next' }, ['Continue']),
          el('Button', { variant: 'ghost', command: 'pickfolders' }, ['Choose another folder']),
        ];
  buttons.push(el('Button', { variant: 'ghost', command: 'setup:back' }, ['Back']));
  body.push(actionsRow(buttons));
  return body;
}

function renderDone(input: SetupViewInput): RenderTree[] {
  const found = input.providers.filter((p) => p.found).length;
  const missing = input.providers.length - found;
  // Unchecked ≠ empty: a failed/absent query renders "couldn't check",
  // never a fabricated "none found".
  const appLine = !input.providersChecked
    ? 'Coding apps: couldn’t check — if none appear later, install one and sign in once in that app.'
    : found === 0
      ? 'No coding apps found — Florina can’t run tasks until one is installed and signed in.'
      : missing === 0
        ? `Coding apps: all ${found} found.`
        : `Coding apps: ${found} found, ${missing} not installed — you only need one.`;
  const folderLine = !input.reposChecked
    ? 'Project folder: couldn’t check — you can add one anytime in Settings.'
    : input.roots.length === 0
      ? 'No project folder yet — add one anytime in Settings.'
      : `Watching ${input.roots.length} folder${input.roots.length === 1 ? '' : 's'} for projects.`;
  return [
    el('SetupStepTitle', {}, [
      found === 0 || input.roots.length === 0 ? 'Almost there' : 'You’re set',
    ]),
    el('SetupList', {}, [
      el('SetupItem', { color: found === 0 ? 'muted' : 'success' }, [
        el('SetupItemName', {}, [appLine]),
      ]),
      el('SetupItem', { color: input.roots.length === 0 ? 'muted' : 'success' }, [
        el('SetupItemName', {}, [folderLine]),
      ]),
    ]),
    el('SetupStepBody', {}, [
      'Ask Florina for something small to try it out. Anything that needs you shows up in ' +
        'Attention — you decide what happens next.',
    ]),
    actionsRow([
      el('Button', { variant: 'primary', command: 'setup:done' }, ['Done']),
      el('Button', { variant: 'ghost', command: 'setup:back' }, ['Back']),
    ]),
  ];
}

/** Build the setup card for the current step. */
export function renderSetupView(input: SetupViewInput): RenderTree {
  const stepBody =
    input.step === 'welcome'
      ? renderWelcome(input)
      : input.step === 'apps'
        ? renderApps(input)
        : input.step === 'folder'
          ? renderFolder(input)
          : renderDone(input);
  return el('SetupPanel', {}, [el('SetupCard', {}, stepBody)]);
}

/** Collapsed state after Skip — a calm resumable row, never a trap. */
export function renderSetupResumeRow(): RenderTree {
  return el('SetupPanel', {}, [
    el('SetupResumeRow', {}, [
      el('SetupStepBody', { color: 'muted' }, [
        'Setup isn’t finished — Florina might be missing what it needs.',
      ]),
      el('Button', { variant: 'ghost', command: 'setup:resume' }, ['Finish setup']),
    ]),
  ]);
}

/** Setup hidden (completed) — an empty panel, nothing rendered. */
export function renderSetupHidden(): RenderTree {
  return el('SetupPanel', {}, []);
}
