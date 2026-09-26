/**
 * Inline memory actions for preference-kind rows: forget/promote (issue
 * #200/#224). "narrow"/"broaden" are the general form for any scoped
 * memory item; for `preference` specifically — the only kind with a real
 * backing store today (#205/#223) — scope only ever has two values
 * (global/project), so narrow-to-project and broaden-to-global collapse
 * onto the same action as "promote"/"demote" and are exposed under
 * those names rather than inventing a distinction preference rules don't
 * have.
 *
 * These build real {@link UpdatePreferenceCommand}s — the *same* command
 * the conversational path and the existing routing-rule cards already
 * use (DEC-029/#65) — never a second, parallel write path onto the
 * preference profile. No new data model, no new mutation mechanism.
 */
import type { MemoryItem } from '../../../domain/memory.js';
import type {
  DenyRule,
  PreferenceProfile,
  RoutingRule,
} from '../../ports/outbound/preference-profile.js';
import type { UpdatePreferenceCommand } from '../tasks/command-api.js';
import type { IdGeneratorPort } from '../../ports/outbound/id-generator.js';
import type { ClockPort } from '../../ports/outbound/clock.js';
import { preferenceProfileToMemoryItems } from './preference-bridge.js';

/** One memory row paired with the real command(s) that would mutate its underlying rule. */
export interface PreferenceMemoryRow {
  readonly item: MemoryItem;
  /** "Forget" — removes the underlying rule/deny entirely. */
  readonly forgetCommand: UpdatePreferenceCommand;
  /** "Promote to global" — undefined when already global (nothing to promote). */
  readonly promoteCommand?: UpdatePreferenceCommand;
}

function forgetCommandFor(rule: RoutingRule): UpdatePreferenceCommand;
function forgetCommandFor(deny: DenyRule, isDeny: true): UpdatePreferenceCommand;
function forgetCommandFor(ruleOrDeny: RoutingRule | DenyRule, isDeny?: true): UpdatePreferenceCommand {
  return {
    kind: 'update-preference',
    action: isDeny ? 'remove-deny' : 'remove-rule',
    provider: ruleOrDeny.provider,
    ...(ruleOrDeny.model !== undefined ? { model: ruleOrDeny.model } : {}),
    ...(ruleOrDeny.projectId !== undefined ? { projectId: ruleOrDeny.projectId } : {}),
  };
}

/**
 * Promoting a project-scoped rule to global means: add it at global
 * scope, then remove the project-scoped copy — the daemon has no
 * "reparent in place" primitive, and doesn't need one (both steps go
 * through the same audited command). Returns `undefined` for an
 * already-global rule (§5: promotion is always an explicit user action,
 * never implicit — offering "promote" on something already global would
 * be a no-op masquerading as an action).
 */
function promoteCommandFor(rule: RoutingRule): UpdatePreferenceCommand | undefined {
  if (rule.projectId === undefined) return undefined;
  return {
    kind: 'update-preference',
    action: 'add-rule',
    provider: rule.provider,
    ...(rule.model !== undefined ? { model: rule.model } : {}),
    ...(rule.workTypes !== undefined ? { workTypes: rule.workTypes } : {}),
    ...(rule.note !== undefined ? { note: rule.note } : {}),
    // projectId omitted -> global, per the command's own doc comment.
  };
}

function promoteDenyCommandFor(deny: DenyRule): UpdatePreferenceCommand | undefined {
  if (deny.projectId === undefined) return undefined;
  return {
    kind: 'update-preference',
    action: 'deny',
    provider: deny.provider,
    ...(deny.model !== undefined ? { model: deny.model } : {}),
    ...(deny.note !== undefined ? { note: deny.note } : {}),
  };
}

/**
 * Pair every preference-kind memory item with the real command(s) that
 * would mutate it. Reuses {@link preferenceProfileToMemoryItems} for the
 * items themselves and zips by position — both functions iterate the
 * same profile in the same order (rules, then denied), so this is safe
 * without exposing the item/rule pairing as a new public contract.
 */
export function preferenceProfileToMemoryRows(
  profile: PreferenceProfile,
  ids: IdGeneratorPort,
  clock: ClockPort,
): readonly PreferenceMemoryRow[] {
  const items = preferenceProfileToMemoryItems(profile, ids, clock);
  const rows: PreferenceMemoryRow[] = [];
  let i = 0;
  for (const rule of profile.rules) {
    const promote = promoteCommandFor(rule);
    rows.push({
      item: items[i]!,
      forgetCommand: forgetCommandFor(rule),
      ...(promote !== undefined ? { promoteCommand: promote } : {}),
    });
    i++;
  }
  for (const deny of profile.denied) {
    const promote = promoteDenyCommandFor(deny);
    rows.push({
      item: items[i]!,
      forgetCommand: forgetCommandFor(deny, true),
      ...(promote !== undefined ? { promoteCommand: promote } : {}),
    });
    i++;
  }
  return rows;
}
