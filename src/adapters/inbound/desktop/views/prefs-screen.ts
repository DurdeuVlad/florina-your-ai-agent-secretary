/**
 * Preferences screen (issue #128, mockup `docs/mockups/preferences.html`).
 *
 * Renders the durable preference profile (`query-preferences` →
 * `PreferenceResponse.profile`) into a serializable {@link RenderTree}:
 *
 *  - **Routing rules**: `provider · work-type: X` (or `catch-all`) kind
 *    line, the user's note in quotes, an amber `project:<id>` chip for
 *    project-scoped entries, Edit/Revoke actions.
 *  - **Denied**: provider/model targets in a distinct section with a red
 *    `denied` chip; `Revoke deny` maps to `remove-deny`.
 *  - **+ Add rule**: opens the renderer-side inline form.
 *
 * Mutation commands are encoded as `prefcmd:<uri-encoded JSON>` where the
 * payload is a typed `update-preference` {@link Command} — the main
 * process decodes, validates, and forwards it to the daemon, keeping the
 * renderer a strict client (DEC-028). `prefedit:<json>` and `prefadd`
 * are renderer-only verbs intercepted client-side to open the inline
 * forms.
 */
import type { UpdatePreferenceCommand } from '../../../../core/application/use-cases/tasks/command-api.js';
import type {
  DenyRule,
  PreferenceProfile,
  RoutingRule,
} from '../../../../core/application/ports/outbound/preference-profile.js';
import type { RenderTree } from './view-types.js';

function el(
  tag: string,
  props?: Record<string, unknown>,
  children?: readonly (RenderTree | string)[],
): RenderTree {
  return { tag, props, children };
}

/** URI-encode a command payload — UTF-8 safe, no delimiter ambiguity. */
export function encodePrefCommand(cmd: UpdatePreferenceCommand): string {
  return `prefcmd:${encodeURIComponent(JSON.stringify(cmd))}`;
}

function ruleKind(rule: RoutingRule): string {
  const target = rule.model !== undefined ? `${rule.provider}/${rule.model}` : rule.provider;
  const work =
    rule.workTypes !== undefined ? `work-type: ${rule.workTypes.join(', ')}` : 'catch-all';
  return `${target} · ${work}`;
}

function denyKind(deny: DenyRule): string {
  return deny.model !== undefined
    ? `${deny.provider}/${deny.model}`
    : `${deny.provider} · all models`;
}

function scopeMeta(projectId: string | undefined): string {
  return projectId !== undefined ? 'project scope' : 'global scope';
}

function projectChip(projectId: string | undefined): RenderTree | null {
  return projectId !== undefined
    ? el('Chip', { variant: 'amber' }, [`project:${projectId}`])
    : null;
}

function ruleCard(rule: RoutingRule): RenderTree {
  const remove: UpdatePreferenceCommand = {
    kind: 'update-preference',
    action: 'remove-rule',
    provider: rule.provider,
    ...(rule.model !== undefined ? { model: rule.model } : {}),
    ...(rule.projectId !== undefined ? { projectId: rule.projectId } : {}),
  };
  const top: RenderTree[] = [el('PrefKind', {}, [ruleKind(rule)])];
  const chip = projectChip(rule.projectId);
  if (chip !== null) top.push(chip);
  return el('PrefCard', {}, [
    el('PrefTop', {}, top),
    el('PrefNote', {}, [rule.note !== undefined ? `"${rule.note}"` : '(no note)']),
    el('PrefMeta', {}, [scopeMeta(rule.projectId)]),
    el('PrefActions', {}, [
      el(
        'Button',
        { variant: 'ghost', command: `prefedit:${encodeURIComponent(JSON.stringify(rule))}` },
        ['Edit'],
      ),
      el('Button', { variant: 'danger', command: encodePrefCommand(remove) }, ['Revoke']),
    ]),
  ]);
}

function denyCard(deny: DenyRule): RenderTree {
  const remove: UpdatePreferenceCommand = {
    kind: 'update-preference',
    action: 'remove-deny',
    provider: deny.provider,
    ...(deny.model !== undefined ? { model: deny.model } : {}),
    ...(deny.projectId !== undefined ? { projectId: deny.projectId } : {}),
  };
  const top: RenderTree[] = [
    el('PrefKind', {}, [denyKind(deny)]),
    el('Chip', { variant: 'red' }, ['denied']),
  ];
  const chip = projectChip(deny.projectId);
  if (chip !== null) top.push(chip);
  return el('PrefCard', {}, [
    el('PrefTop', {}, top),
    el('PrefNote', {}, [deny.note !== undefined ? `"${deny.note}"` : '(no note)']),
    el('PrefMeta', {}, [scopeMeta(deny.projectId)]),
    el('PrefActions', {}, [
      el('Button', { variant: 'danger', command: encodePrefCommand(remove) }, ['Revoke deny']),
    ]),
  ]);
}

/** Build the preferences screen tree from a `query-preferences` profile. */
export function renderPrefsScreen(profile: PreferenceProfile): RenderTree {
  const children: RenderTree[] = [];

  children.push(
    el('PrefAddBar', {}, [el('Button', { variant: 'ghost', command: 'prefadd' }, ['+ Add rule'])]),
  );

  children.push(
    el('SectionHeader', { label: 'Routing rules' }, [
      el('SectionCount', {}, [String(profile.rules.length)]),
    ]),
  );
  if (profile.rules.length === 0) {
    children.push(
      el('EmptyState', {}, [
        el('EmptyHint', {}, ['no routing rules — add one or let Florina learn from your voice']),
      ]),
    );
  } else {
    children.push(...profile.rules.map(ruleCard));
  }

  children.push(
    el('SectionHeader', { label: 'Denied' }, [
      el('SectionCount', {}, [String(profile.denied.length)]),
    ]),
  );
  if (profile.denied.length === 0) {
    children.push(el('EmptyState', {}, [el('EmptyHint', {}, ['no providers denied'])]));
  } else {
    children.push(...profile.denied.map(denyCard));
  }

  return el('PrefsView', {}, children);
}
