/**
 * PreferenceProfileStore — durable user preference memories (DEC-020 User
 * scope, DEC-029, issue #65).
 *
 * The preference profile is the machine-checkable half of "how Vlad wants
 * work routed": ordered routing rules (`provider`, optional `model`,
 * optional `workTypes`) plus model-level deny rules. The Secretary writes
 * entries through the `preference` tool as it learns them in conversation;
 * the CapacityRouter consumes {@link PreferenceProfileStore.toProfile}.
 *
 * The file is plain JSON — human-editable, journaled changes happen at the
 * tool layer (each mutation is a loop event → SupervisorEvent, DEC-012).
 * The store validates on load and refuses to persist malformed data.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { DenyRule, PreferenceProfile, RoutingRule } from './capacity-router.js';

/** Raised when a preference file or mutation is malformed. */
export class PreferenceProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreferenceProfileError';
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/** Validate an unknown value as a {@link PreferenceProfile}. */
export function validatePreferenceProfile(value: unknown): PreferenceProfile {
  if (!isObject(value)) {
    throw new PreferenceProfileError('preference profile must be an object');
  }
  if (!Array.isArray(value['rules']) || !Array.isArray(value['denied'])) {
    throw new PreferenceProfileError('preference profile requires "rules" and "denied" arrays');
  }
  for (const [i, rule] of (value['rules'] as unknown[]).entries()) {
    if (!isObject(rule) || typeof rule['provider'] !== 'string' || rule['provider'].length === 0) {
      throw new PreferenceProfileError(`rules[${i}] requires a non-empty "provider"`);
    }
    if (rule['model'] !== undefined && typeof rule['model'] !== 'string') {
      throw new PreferenceProfileError(`rules[${i}].model must be a string`);
    }
    if (rule['workTypes'] !== undefined && !isStringArray(rule['workTypes'])) {
      throw new PreferenceProfileError(`rules[${i}].workTypes must be an array of strings`);
    }
  }
  for (const [i, deny] of (value['denied'] as unknown[]).entries()) {
    if (!isObject(deny) || typeof deny['provider'] !== 'string' || deny['provider'].length === 0) {
      throw new PreferenceProfileError(`denied[${i}] requires a non-empty "provider"`);
    }
    if (deny['model'] !== undefined && typeof deny['model'] !== 'string') {
      throw new PreferenceProfileError(`denied[${i}].model must be a string`);
    }
  }
  return {
    rules: value['rules'] as readonly RoutingRule[],
    denied: value['denied'] as readonly DenyRule[],
  };
}

/**
 * File-backed preference profile. `load` reads (or seeds an empty) profile;
 * mutations update memory immediately and `save` persists.
 */
export class PreferenceProfileStore {
  private readonly path: string;
  private profile: PreferenceProfile;

  private constructor(path: string, profile: PreferenceProfile) {
    this.path = path;
    this.profile = profile;
  }

  /** The profile file location. */
  get filePath(): string {
    return this.path;
  }

  /**
   * Load the profile at `path`. A missing file seeds an empty profile;
   * a malformed file throws {@link PreferenceProfileError}.
   */
  static async load(path: string): Promise<PreferenceProfileStore> {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return new PreferenceProfileStore(path, { rules: [], denied: [] });
      }
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new PreferenceProfileError(`preference file at ${path} is not valid JSON`);
    }
    return new PreferenceProfileStore(path, validatePreferenceProfile(parsed));
  }

  /** Current profile (immutable snapshot for the router). */
  toProfile(): PreferenceProfile {
    return { rules: [...this.profile.rules], denied: [...this.profile.denied] };
  }

  /** Append a routing rule (preferences are ordered; first eligible wins). */
  addRule(rule: RoutingRule): void {
    if (rule.provider.length === 0) {
      throw new PreferenceProfileError('rule provider must be non-empty');
    }
    this.profile = { ...this.profile, rules: [...this.profile.rules, rule] };
  }

  /** Add a model-level deny rule. `{provider}` denies the provider; with `model`, denies just that model. */
  addDeny(deny: DenyRule): void {
    if (deny.provider.length === 0) {
      throw new PreferenceProfileError('deny provider must be non-empty');
    }
    const exists = this.profile.denied.some(
      (d) => d.provider === deny.provider && d.model === deny.model,
    );
    if (!exists) {
      this.profile = { ...this.profile, denied: [...this.profile.denied, deny] };
    }
  }

  /** Remove the first routing rule matching provider (+model when given). */
  removeRule(provider: string, model?: string): boolean {
    const index = this.profile.rules.findIndex(
      (r) => r.provider === provider && (model === undefined || r.model === model),
    );
    if (index === -1) {
      return false;
    }
    const rules = [...this.profile.rules];
    rules.splice(index, 1);
    this.profile = { ...this.profile, rules };
    return true;
  }

  /** Remove a deny rule matching provider (+model when given). */
  removeDeny(provider: string, model?: string): boolean {
    const index = this.profile.denied.findIndex(
      (d) => d.provider === provider && (model === undefined || d.model === model),
    );
    if (index === -1) {
      return false;
    }
    const denied = [...this.profile.denied];
    denied.splice(index, 1);
    this.profile = { ...this.profile, denied };
    return true;
  }

  /** Persist the profile to disk (pretty-printed JSON). */
  async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.profile, null, 2) + '\n', 'utf8');
  }
}
