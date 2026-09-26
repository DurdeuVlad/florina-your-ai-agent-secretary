/**
 * Bridges DEC-029's `PreferenceProfile` (`RoutingRule`/`DenyRule`) onto the
 * general memory taxonomy's `preference` kind (DEC-039, issue #191/#205).
 *
 * This is a read-only re-expression, not a replacement. `PreferenceProfile`
 * remains the durable store `CapacityRouter`, the command API, and the
 * desktop Preferences screen all consume directly — none of those change
 * here, which is exactly #205's "existing consumers unaffected" and
 * "existing tests pass unmodified" acceptance criteria. This module only
 * proves (and tests) that every routing/deny rule is expressible as a
 * `preference`-kind {@link MemoryItem}, for the general memory audit
 * surface (#200) to eventually read from without a second parallel write
 * path for provider preferences.
 */
import type { EntityId, ISODateString } from '../../../domain/types.js';
import type { MemoryItem } from '../../../domain/memory.js';
import type {
  DenyRule,
  PreferenceProfile,
  RoutingRule,
} from '../../ports/outbound/preference-profile.js';
import type { IdGeneratorPort } from '../../ports/outbound/id-generator.js';
import type { ClockPort } from '../../ports/outbound/clock.js';

function routingRuleStatement(rule: RoutingRule): string {
  const target = rule.model !== undefined ? `${rule.provider}/${rule.model}` : rule.provider;
  const work = rule.workTypes !== undefined ? ` for ${rule.workTypes.join(', ')}` : '';
  const scope = rule.projectId !== undefined ? ' (project rule)' : '';
  const note = rule.note !== undefined ? ` — ${rule.note}` : '';
  return `Prefer ${target}${work}${scope}${note}`;
}

function denyRuleStatement(rule: DenyRule): string {
  const target = rule.model !== undefined ? `${rule.provider}/${rule.model}` : rule.provider;
  const scope = rule.projectId !== undefined ? ' (project rule)' : '';
  const note = rule.note !== undefined ? ` — ${rule.note}` : '';
  return `Never ${target}${scope}${note}`;
}

function scopeFor(projectId: EntityId | undefined): MemoryItem['scope'] {
  return projectId !== undefined ? { type: 'project', projectId } : { type: 'global' };
}

/**
 * Every preference-profile write today is a direct, user-driven CLI/tool
 * call (DEC-029) — there is no inference path onto `PreferenceProfile` yet,
 * so every re-expressed item carries `explicit` provenance and `active`
 * status. This will need revisiting if/when routing rules gain an inferred
 * write path.
 */
function routingRuleToMemoryItem(
  rule: RoutingRule,
  id: EntityId,
  now: ISODateString,
): MemoryItem {
  return {
    id,
    kind: 'preference',
    scope: scopeFor(rule.projectId),
    statement: routingRuleStatement(rule),
    provenance: 'explicit',
    confidence: 'high',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
}

function denyRuleToMemoryItem(rule: DenyRule, id: EntityId, now: ISODateString): MemoryItem {
  return {
    id,
    kind: 'preference',
    scope: scopeFor(rule.projectId),
    statement: denyRuleStatement(rule),
    provenance: 'explicit',
    confidence: 'high',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Re-express an entire {@link PreferenceProfile} as `preference`-kind
 * memory items, rules first then denies, in profile order.
 */
export function preferenceProfileToMemoryItems(
  profile: PreferenceProfile,
  ids: IdGeneratorPort,
  clock: ClockPort,
): readonly MemoryItem[] {
  const now = clock.now().toISOString();
  return [
    ...profile.rules.map((rule) => routingRuleToMemoryItem(rule, ids.generate('mem'), now)),
    ...profile.denied.map((deny) => denyRuleToMemoryItem(deny, ids.generate('mem'), now)),
  ];
}
