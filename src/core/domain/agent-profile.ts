/**
 * Agent Profile — the "role" sense of "agent" (issue #191/#196).
 *
 * `docs/PROVIDER_TOPOLOGY.md` § 1 distinguishes three senses of "agent":
 * provider/runtime ({@link Agent} in `types.ts`, DEC-013), the active
 * run ({@link Session}), and a reusable role/system-prompt/tool-scope
 * configuration applied to a Task — which had no domain type until now.
 *
 * This is scoped and additive: `Task.agentProfileId` is optional (DEC-004's
 * Project/Task/Agent/Session model is unchanged), and the existing
 * "project manager" pattern (DEC-018 — a Task with a special capsule/tool
 * set) is expressible as a Task referencing the built-in
 * {@link BUILT_IN_MANAGER_PROFILE_ID} profile, without touching DEC-018's
 * dispatch mechanism.
 */
import type { EntityId, ISODateString } from './types.js';

export interface AgentProfile {
  readonly id: EntityId;
  readonly name: string;
  /** Human-readable role description (e.g. "Security reviewer"). */
  readonly role: string;
  /** Tool names this profile is scoped to; undefined = no restriction beyond the Task's own grants. */
  readonly toolScope?: readonly string[];
  /** Default provider id this profile prefers, absent a routing override. */
  readonly defaultProvider?: string;
  /** Default model, paired with `defaultProvider`. */
  readonly defaultModel?: string;
  readonly createdAt: ISODateString;
  readonly updatedAt: ISODateString;
}

/**
 * Well-known id for the existing "project manager" Task pattern (DEC-018),
 * so it's expressible as a Task referencing a profile instead of being a
 * special case with no domain representation. No dispatch behavior change:
 * managers work exactly as before whether or not a Task sets this.
 */
export const BUILT_IN_MANAGER_PROFILE_ID: EntityId = 'agent-profile-manager';
