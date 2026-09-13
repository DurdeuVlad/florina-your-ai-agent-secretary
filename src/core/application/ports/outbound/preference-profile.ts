/**
 * Preference profile port — the core-owned outbound contract for durable
 * user routing preferences (DEC-020 User scope, DEC-029, issue #65).
 *
 * The profile model lives here (not in the capacity router) so both the
 * routing use case and the persistence adapter depend on the same
 * core-owned types. The file-backed `PreferenceProfileStore` under
 * `src/daemon/` satisfies the port until the outbound adapter migration.
 */

/**
 * One ordered preference: use `provider` (optionally a specific `model`)
 * for the given work types.
 */
export interface RoutingRule {
  /** Provider id, matching the adapter id (e.g. `codex`, `claude-code`). */
  readonly provider: string;
  /** Optional model pin (e.g. `haiku`, `gpt-extra-high`). */
  readonly model?: string;
  /** Work-type tags this rule applies to; undefined = catch-all. */
  readonly workTypes?: readonly string[];
  /**
   * Project this rule is scoped to; undefined = global default
   * (DEC-003 need-to-know — a project's manager sees global rules plus
   * its own project's rules, never other projects').
   */
  readonly projectId?: string;
  /**
   * The user's own words — the natural-language soft layer managers
   * read (e.g. "Sonnet for repeatable reading work"). Structured fields
   * are what the daemon enforces; the note is what the manager reasons
   * over.
   */
  readonly note?: string;
}

/**
 * A model-level deny rule. `{provider, model}` denies that model on that
 * provider; omitting `model` denies the provider entirely.
 */
export interface DenyRule {
  readonly provider: string;
  readonly model?: string;
  /** Project scope; undefined = global. */
  readonly projectId?: string;
  /** The user's own words for this deny (soft layer). */
  readonly note?: string;
}

/**
 * The user's preference profile (issue #65): ordered routing rules plus
 * model-level deny rules. Written by the Florina's preference memories
 * (User-scope capsule) and editable via CLI.
 */
export interface PreferenceProfile {
  readonly rules: readonly RoutingRule[];
  readonly denied: readonly DenyRule[];
}

/**
 * Render the need-to-know preference text injected into a project's
 * manager prompt (issue #65 soft layer): global rules/denies plus the
 * given project's own rules — other projects' rules are never included.
 * Returns `null` when nothing applies, so callers can skip the block.
 */
export function preferencePromptText(
  profile: PreferenceProfile,
  projectId?: string,
): string | null {
  const inScope = (r: { readonly projectId?: string }): boolean =>
    r.projectId === undefined || r.projectId === projectId;
  const lines: string[] = [];
  for (const rule of profile.rules.filter(inScope)) {
    const target = rule.model !== undefined ? `${rule.provider}/${rule.model}` : rule.provider;
    const scope = rule.projectId !== undefined ? ' (project rule)' : '';
    const work = rule.workTypes !== undefined ? ` for ${rule.workTypes.join(', ')}` : '';
    lines.push(
      `- Prefer ${target}${work}${scope}${rule.note !== undefined ? ` — ${rule.note}` : ''}`,
    );
  }
  for (const deny of profile.denied.filter(inScope)) {
    const target = deny.model !== undefined ? `${deny.provider}/${deny.model}` : deny.provider;
    const scope = deny.projectId !== undefined ? ' (project rule)' : '';
    lines.push(`- Never ${target}${scope}${deny.note !== undefined ? ` — ${deny.note}` : ''}`);
  }
  if (lines.length === 0) return null;
  return [
    'Routing preferences (need-to-know; the daemon still enforces quota + deny rules):',
    ...lines,
  ].join('\n');
}

/** Raised when a preference profile or mutation is malformed. */
export class PreferenceProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreferenceProfileError';
  }
}

/**
 * Durable preference profile store. `load`-style construction seeds or
 * reads the profile; mutations update memory immediately and `save`
 * persists.
 */
export interface PreferenceProfilePort {
  /** Current profile (immutable snapshot for the router). */
  toProfile(): PreferenceProfile;
  /** Append a routing rule (preferences are ordered; first eligible wins). */
  addRule(rule: RoutingRule): void;
  /** Add a model-level deny rule. */
  addDeny(deny: DenyRule): void;
  /** Remove the first routing rule matching provider (+model when given). */
  removeRule(provider: string, model?: string): boolean;
  /** Remove a deny rule matching provider (+model when given). */
  removeDeny(provider: string, model?: string): boolean;
  /** Persist the profile. */
  save(): Promise<void>;
}
