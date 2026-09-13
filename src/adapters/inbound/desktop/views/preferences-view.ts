/**
 * Preferences view (issue #74, #65): the learned routing profile —
 * ordered rules and denylists — with edit/confirm/revoke affordances
 * and provenance.
 *
 * Pure view model + {@link RenderTree} template over
 * {@link PreferenceProfile} snapshots.
 */
import type { PreferenceProfile } from '../../../../core/application/ports/outbound/preference-profile.js';
import type { RenderTree } from './view-types.js';

/** One routing-rule row, ordered by precedence. */
export interface RoutingRuleView {
  readonly index: number;
  readonly provider: string;
  readonly model?: string;
  readonly workTypes?: readonly string[];
  /** Where the rule came from ('voice', 'cli', 'learned', …). */
  readonly provenance?: string;
}

/** One deny-rule row. */
export interface DenyRuleView {
  readonly provider: string;
  readonly model?: string;
  readonly provenance?: string;
}

/** Full preferences view data. */
export interface PreferencesViewData {
  readonly rules: readonly RoutingRuleView[];
  readonly denied: readonly DenyRuleView[];
  readonly isEmpty: boolean;
}

/**
 * Optional provenance input — parallel to `rules`/`denied` — when the
 * caller knows where each entry came from (e.g. the profile store's
 * metadata channel).
 */
export interface RuleProvenance {
  readonly rules?: readonly (string | undefined)[];
  readonly denied?: readonly (string | undefined)[];
}

/** Build the preferences view from a profile snapshot. */
export function buildPreferencesView(
  profile: PreferenceProfile,
  provenance?: RuleProvenance,
): PreferencesViewData {
  return {
    rules: profile.rules.map((r, index) => ({
      index,
      provider: r.provider,
      ...(r.model !== undefined ? { model: r.model } : {}),
      ...(r.workTypes !== undefined ? { workTypes: r.workTypes } : {}),
      ...(provenance?.rules?.[index] !== undefined ? { provenance: provenance.rules[index] } : {}),
    })),
    denied: profile.denied.map((d, index) => ({
      provider: d.provider,
      ...(d.model !== undefined ? { model: d.model } : {}),
      ...(provenance?.denied?.[index] !== undefined
        ? { provenance: provenance.denied[index] }
        : {}),
    })),
    isEmpty: profile.rules.length === 0 && profile.denied.length === 0,
  };
}

function el(
  tag: string,
  props?: Record<string, unknown>,
  children?: readonly (RenderTree | string)[],
): RenderTree {
  return { tag, props, children };
}

/** Render one routing-rule row with its revoke affordance. */
export function renderRoutingRule(view: RoutingRuleView): RenderTree {
  const scope = view.model !== undefined ? `${view.provider} / ${view.model}` : view.provider;
  const workTypes =
    view.workTypes !== undefined && view.workTypes.length > 0
      ? view.workTypes.join(', ')
      : 'all work';
  return el('RoutingRule', { index: view.index, provider: view.provider }, [
    el('RuleScope', {}, [`${view.index + 1}. ${scope}`]),
    el('RuleWorkTypes', {}, [workTypes]),
    ...(view.provenance !== undefined
      ? [el('Provenance', { color: 'slate' }, [`via ${view.provenance}`])]
      : []),
    el('Action', {
      command: 'preference-remove-rule',
      args: { provider: view.provider, model: view.model ?? null },
      color: 'slate',
    }),
  ]);
}

/** Render one deny-rule row. */
export function renderDenyRule(view: DenyRuleView): RenderTree {
  const scope = view.model !== undefined ? `${view.provider} / ${view.model}` : view.provider;
  return el('DenyRule', { provider: view.provider, color: 'red' }, [
    el('RuleScope', {}, [scope]),
    ...(view.provenance !== undefined
      ? [el('Provenance', { color: 'slate' }, [`via ${view.provenance}`])]
      : []),
    el('Action', {
      command: 'preference-remove-deny',
      args: { provider: view.provider, model: view.model ?? null },
      color: 'slate',
    }),
  ]);
}

/** Render the full preferences panel. */
export function renderPreferencesView(view: PreferencesViewData): RenderTree {
  return el('PreferencesView', { empty: view.isEmpty }, [
    el(
      'PreferenceSection',
      { title: 'Routing order' },
      view.rules.length > 0
        ? view.rules.map(renderRoutingRule)
        : [el('EmptyHint', {}, ['no routing rules — the Secretary learns them as you talk'])],
    ),
    el(
      'PreferenceSection',
      { title: 'Denied' },
      view.denied.length > 0
        ? view.denied.map(renderDenyRule)
        : [el('EmptyHint', {}, ['no deny rules'])],
    ),
  ]);
}
