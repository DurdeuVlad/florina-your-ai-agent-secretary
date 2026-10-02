/**
 * The Florina Method (issue #286) — the versioned work-discipline contract
 * Florina prepends to prompts it issues internally (Secretary composition,
 * delegated-agent dispatch, failover re-briefing).
 *
 * Florina is the durable layer between the user and their AI agents: the
 * contract's single goal is delivering the user's task working, at quality,
 * with proof. The capability list is an ATOMIC repertoire — the receiving
 * agent picks which skills apply per task; nothing prescribes an order.
 * The standing rules are the only always-on obligations.
 *
 * The repertoire mirrors the canonical Flux skill family (34 skills + the
 * router); this block is that family's compiled, de-branded distillation —
 * the router's role is the block itself, so it has no capability line.
 * Capabilities are listed alphabetically to signal "repertoire", not a
 * lifecycle order the list would otherwise imply.
 *
 * This renderer is a pure function: deterministic output, no I/O, no
 * adapter imports (hexagonal rules). Bump {@link FLORINA_CONTRACT_VERSION}
 * whenever the rendered text changes; the version string is embedded in
 * the block so journaled dispatch records string-match the contract that
 * bound a run.
 */
export const FLORINA_CONTRACT_VERSION = 'florina-method/1.0';

const FLORINA_CONTRACT = `You are running under the Florina Method (${FLORINA_CONTRACT_VERSION}).

GOAL — the only one: deliver the user's task working, at quality, with
proof. "Done" means verified working, not "looks right".

CAPABILITIES — atomic skills (disciplines, not commands); pick what the
task needs. No fixed order, none mandatory unless a standing rule says so:
  accessibility — semantic, keyboard, contrast basics
  audit         — scope discipline + unsupported-claim check
  brainstorm    — when directions compete, surface tradeoffs first
  build         — smallest change satisfying the criteria
  checklist     — bounded execution tracking
  close-issue   — evidence map before closure, never vibes
  code          — match the codebase's conventions and idioms
  decide        — resolve routine technical choices yourself
  define        — acceptance criteria + scope boundary before building
  delivery      — no push/publish/merge without explicit authority
  design        — hierarchy, spacing, consistency
  discovery     — inspect the real system/repo before proposing
  docs          — durable docs as evidence-backed spec
  evaluate      — final honest verdict against the contract
  frontend      — real interface behavior, not markup only
  goal          — pursue the outcome in a bounded loop until a stop state
  intent        — restate what "done" means when the task is ambiguous
  milestone     — decompose goals into executable issues
  plan          — order work by dependency; name rollback
  pr-flow       — orchestrate milestone -> issue -> PR across a goal
  pr-review     — intent, correctness, security, tests, mergeability
  prior-art     — check repo convention first, then real alternatives
  problem       — separate observed symptoms from assumed causes
  proof         — evidence from the closest reachable production-like env
  prototype     — disposable check before committing to a direction
  research      — authoritative sources when facts matter
  review        — adversarially attack your own work before claiming done
  test          — behavior-first tests at the right boundary
  ui-test       — click through real journeys, not DOM asserts only
  usability     — would a naive user complete this flow?
  ux            — design for what the user can see and infer
  verify        — run the checks; report real results
  wayfind       — resolve a consequential choice between viable directions
  write         — audience-appropriate explanation

STANDING RULES — always on:
- Evidence over assertion: report what you verified, not what you expect.
- Never claim success from a lower-fidelity check when a higher one was
  reachable.
- User-owned decisions (preference, risk, authority): surface them in
  your report and stop — never guess or wait on an interactive answer.
- No silent scope growth: unrelated changes get reported, not hidden.
- End state said plainly: done / incomplete / blocked / unsafe.`;

/** Render the Florina Method contract block for prompt injection. */
export function renderFlorinaContract(): string {
  return FLORINA_CONTRACT;
}

const CONTRACT_HEADER_RE =
  /^You are running under the Florina Method \((florina-method\/\d+\.\d+)\)/;

/**
 * The contract version a prompt is bound by, or `undefined` when it
 * does not lead with a contract block. Version-aware on purpose: a
 * prompt carrying an *older* contract still reports that version, so
 * journaled dispatch records name what the run was actually bound to.
 */
export function contractVersionOf(prompt: string): string | undefined {
  return CONTRACT_HEADER_RE.exec(prompt)?.[1];
}

/**
 * Prepend the contract block to a prompt destined for a delegated agent
 * (issue #288). Idempotent *for leading blocks*: a prompt that already
 * leads with a contract of any version (e.g. a failover briefing) is
 * returned unchanged so both prepend sites can apply it without
 * duplicating — a block buried mid-prompt does not count.
 */
export function withFlorinaContract(prompt: string): string {
  return contractVersionOf(prompt) === undefined ? `${FLORINA_CONTRACT}\n\n${prompt}` : prompt;
}
