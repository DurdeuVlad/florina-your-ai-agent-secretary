# Agent Supervision Campaign

**Status:** in flight — milestones 16–18 and issues #339–#345 created on
`DurdeuVlad/florina-your-ai-agent-secretary`.
**Issue map:** M1 #339 (verify gates) + #340 (nudge/escalate) ·
M2 #341 (capability matrix) + #342 (session pool) ·
M3 #343 (queue) + #344 (parallel gate) + #345 (queue surface).

**Source:** user feature request 2026-10-07 — *"florina knows to
automatically compact the ai between tasks and tries to keep the same
session… a task queue, florina appends to it, the managers make sure the
task gets done properly and fully and the agents are smacked on the head
until they produce high quality work that actually works."*

## Goal / System / Constraints / Evaluation

- **Goal:** The user stops being the scheduler, context hygienist, and QA
  gate for their agent fleet. Florina reuses sessions with fresh context,
  serializes work unless parallelism is safe/asked-for, and verifies "done"
  against evidence instead of agent self-report.
- **System:** Three independently shippable milestones, dependency-ordered.
  M1 (verification) stands alone on today's spawn-per-task model; M2 builds
  session continuity on top of it; M3 layers the queue/scheduler on M2's
  session pool.
- **Constraints:** Hexagonal layering (DEC-037) — new port surface goes in
  `src/core/application/ports`, adapters implement honestly (a provider
  that cannot compact must say so, never fake it). Journal-first (DEC-012):
  queue/scheduling/verify transitions are journaled events, not inferred
  state. Permissions narrow only (DEC-011): quality gates run the repo's
  own checks — Florina-authored checks are a separate scope decision.
  Bounded retries always — nudge loops burn quota, so every loop has a
  budget and an escalation path.
- **Evaluation:** each issue carries observable ACs; campaign proof = all
  milestones merged plus a live evidence run (two sequential tasks share a
  session with compaction observed between them; a parallel-forbidden task
  queues while a parallel-safe one runs; a failing deliverable gets nudged
  and re-verified or escalated).

## Existing machinery this builds on

- `AgentRuntimePort` (`src/core/application/ports/outbound/agent-runtime.ts`)
  — `connect`/`startRun`/`streamEvents`/`cancel`/`disconnect`. No
  resume/compact/send surface today — that is M2's port delta.
- `SessionManager` (`use-cases/tasks/session-manager.ts`) — 1:1
  task→session `Map`; `onSessionEnd` rolls journal into Task Capsule (#76)
  — the capsule is the natural carry-over artifact for digest-restart.
- `TaskStateMachine` + `ManagerToolService` — formal transitions and the
  manager spawn surface; `florinaMcpSpec` already injects Florina tools
  into agent runs (DEC-018).
- `QuotaLedger`/`CapacityRouter` (`use-cases/routing/`) — normalized quota
  windows, park/resume/failover already journaled.
- `context-health-monitor` + `florina/condenser` + `capsule-rollup` —
  context-health tracking and condensation exist (DEC-035).
- `RaiseAttentionCommand` — the escalation surface for the quality ladder.

---

# Milestone 1 — Verification ladder ("done means proven")

## Issue 1.1 — Objective verification gates on task completion

- **Labels:** `feature`, `tasks`, `quality` · **Type:** feature
- **Intent:** A task's completion is currently the agent's word. The
  manager needs objective evidence before "done" is claimed.
- **Expectation:** When a task's run ends, a `VerifyTask` step evaluates
  declared evidence gates before the task can transition to its terminal
  state: worktree is clean-or-committed per task policy, and any
  task-declared checks (e.g. `npm test`, `npm run build`, or a repo
  check command chosen at dispatch) run in the task's worktree and must
  pass. Results are journaled as `TaskVerified` / `TaskVerifyFailed`
  events carrying the check outputs.
- **Acceptance criteria:**
  - Task gains an optional `verifyCommands`/`checks` declaration at
    dispatch (`SpawnTaskInput`); absent → verification degrades to the
    worktree-cleanliness gate only, reported honestly as "unverified
    checks" not "passed".
  - Gates execute inside the task worktree with the task's env; output
    (truncated) is journaled with the verdict.
  - A failing gate produces `TaskVerifyFailed` with named check + exit
    code + tail output — never a masked pass.
  - `TaskStateMachine` gates the completion transition on verification
    outcome (`verified` vs `verify-failed` paths; `IllegalTransitionError`
    on bypass attempts).
- **Scope:** `use-cases/tasks/` (verify use-case, state machine paths),
  `ManagerToolService` spawn input, journal event types, adapter-neutral
  check runner.
- **Non-goals:** Florina-authored tests/checks (permission widening —
  separate decision); re-running the whole repo suite beyond declared
  checks.
- **Verification:** unit — state machine rejects unverified completion;
  verify use-case runs declared checks in worktree; integration — a
  task whose check fails lands in the failed path with journaled
  evidence.

## Issue 1.2 — Bounded nudge loop and escalation

- **Labels:** `feature`, `tasks`, `quality`, `managers` · **Type:** feature
- **Intent:** "Smack agents on the head until they produce high quality
  work" — mechanized: a failed verify gets the task re-dispatched to the
  same session/adapter with the failure evidence, bounded by a retry
  budget, then escalated to the human.
- **Expectation:** `TaskVerifyFailed` triggers a nudge dispatch carrying
  the failing check + output tail as task context (a `nudge` verb or
  message into the run). Attempts are journaled (`TaskNudged` with
  attempt number). At the retry budget (default 2, task-configurable),
  the task parks and raises a `High`/`Critical` attention item naming
  the repeated failure — the human decides, the loop does not silently
  burn quota.
- **Acceptance criteria:**
  - Nudge carries the concrete failure evidence into the next attempt —
    not just "try again".
  - Retry budget enforced deterministically; exhausted budget → task
    `parked` + attention item with full attempt history.
  - Every transition journaled: `TaskVerifyFailed`, `TaskNudged`,
    `TaskParked` (existing), attention item raised.
  - Human can resolve by approving current state, increasing budget, or
    cancelling — all through existing commands.
- **Scope:** verify/nudge use-case in `use-cases/tasks/`, attention-item
  integration, journal events. Adapter note: nudge re-dispatch uses
  `startRun` until M2's send/continue surface exists — documented, not
  hidden.
- **Non-goals:** semantic judgment of code quality beyond declared gates
  (that's manager reasoning, not the mechanical ladder).
- **Verification:** unit — budget bounds, escalation on exhaustion;
  integration — scripted failing-then-passing check produces nudge then
  verified; always-failing check produces parked + attention item.

---

# Milestone 2 — Session continuity ("same session, fresh context")

## Issue 2.1 — Session capability matrix on the runtime port

- **Labels:** `feature`, `adapters`, `sessions` · **Type:** feature
- **Intent:** Session reuse and context maintenance are provider
  capabilities, not assumptions. The port must expose them honestly so
  scheduling degrades correctly instead of faking.
- **Expectation:** `AgentRuntimePort` gains a `capabilities` descriptor —
  `sendMessage`, `resume`, `compact` — plus the optional methods they
  gate (`sendMessage(sessionId, msg)`, `maintainContext(sessionId)`).
  Each adapter declares real support: codex JSON-RPC and claude-code
  get actual implementations where the provider exposes them; ACP/agy
  adapters declare what they can do and fall back honestly.
- **Acceptance criteria:**
  - Capability flags are static per adapter and surfaced via provider
    facts (queryable — the fleet/providers view can show them).
  - `maintainContext` returns the mode applied: `compacted` |
    `restarted-with-carryover` | `unsupported` — never silent.
  - Restart-with-carryover composes the Task Capsule (#76) as the
    carry-over summary — no bespoke summarizer.
  - Adapters that cannot do any of it declare `unsupported` and the
    caller degrades to spawn-fresh — no fake implementations.
- **Scope:** `agent-runtime.ts` port, all four adapters + stub, provider
  facts surface.
- **Non-goals:** implementing compaction for providers that don't
  support it (impossible); UI for capabilities.
- **Verification:** unit — capability matrix per adapter;
  integration — stub adapter exercises all three modes.

## Issue 2.2 — Session pool and between-task context maintenance

- **Labels:** `feature`, `sessions`, `daemon` · **Type:** feature
- **Intent:** Sessions outlive tasks. Sequential tasks on the same
  provider reuse the session with the context window reset between
  them — continuity without rot.
- **Expectation:** `SessionManager` becomes a per-provider session pool:
  `Map<providerId, PooledSession>` where a session is bound to a provider
  (+ project/repo context), not a single task. On task completion the
  session is released to the pool with `maintainContext` run
  (compact where supported, digest-restart otherwise); the next task on
  that provider attaches to the pooled session. Sessions still die on
  stop/disconnect/failure — the pool is a reuse cache, not a leak.
- **Acceptance criteria:**
  - Two sequential same-provider tasks share one session; the journal
    shows `maintainContext` between them (mode recorded).
  - Pool membership keyed by provider + project context — a session
    never bleeds across projects or repos.
  - Session failure/age/context-health thresholds evict and spawn
    fresh — degradation is graceful, not fatal.
  - `onSessionEnd`/capsule rollup still fires per task boundary.
  - The 1:1 guarantee per task is preserved *while attached* — a pooled
    session serves one task at a time.
- **Scope:** `session-manager.ts` (pool lifecycle, eviction, maintain
  between tasks), bootstrap wiring, journal events
  (`SessionPooled`/`SessionReused`/`ContextMaintained`).
- **Non-goals:** cross-provider session sharing (meaningless); session
  migration between worktrees.
- **Verification:** unit — pool reuse/eviction/matrix-keying;
  integration — two sequential tasks on the stub adapter reuse one
  session with compaction journaled between.

---

# Milestone 3 — Capacity-aware queue ("schedule to the session")

## Issue 3.1 — Persistent task queue

- **Labels:** `feature`, `tasks`, `daemon` · **Type:** feature
- **Intent:** Submission stops being spawn-or-fail. Tasks enter a
  durable queue; scheduling is a decision, not an accident.
- **Expectation:** A `TaskQueued` journal event + materialized queue
  state. `start-task` (and manager `SpawnTaskInput`) enqueues instead of
  racing for a session; a scheduler drains the queue per the policy in
  3.2. Queue position and reason ("waiting: session busy" / "waiting:
  quota") are queryable facts, never inferred.
- **Acceptance criteria:**
  - Queue survives daemon restart — rebuilt from journaled events,
    matching the journal-first rule (DEC-012).
  - Ordering: FIFO per provider by default; a task's `priority` field
    can promote it (journaled).
  - Cancellation/timeout of a queued task removes it without spawning
    anything.
  - `list-tasks` (or `query-fleet`) exposes queued state with wait
    reason.
- **Scope:** new `use-cases/scheduling/` queue + events, command-api
  enqueue path, journal materialization.
- **Non-goals:** dependency graphs between tasks (out of scope; a task
  is independently schedulable or the user sequences manually).
- **Verification:** unit — enqueue/dequeue/priority/cancel;
  integration — restart-rebuild produces the same queue.

## Issue 3.2 — Capacity- and consent-gated parallelism

- **Labels:** `feature`, `scheduling`, `routing` · **Type:** feature
- **Intent:** The scheduling rule the user described, mechanized:
  queued tasks land on the pooled session unless the job is parallel-safe
  AND quota headroom exists OR the user explicitly asked for parallel.
- **Expectation:** Scheduler policy per queued task:
  `parallel` only when (`task.parallelizable` flag ∨ user parallel
  request) AND `QuotaLedger` shows headroom on the target provider.
  Otherwise attach to the provider's pooled session when free, else
  stay queued with honest wait reason. Every spawn/queue decision is a
  journaled `RoutingDecision`-class event.
- **Acceptance criteria:**
  - Default stance is serial-per-provider — parallel is opt-in at
    dispatch (`parallelizable` flag) or by user verb.
  - Quota headroom reads `QuotaLedger` windows exactly like
    `CapacityRouter` — one source of truth for "enough usage".
  - No-headroom parallel request parks with a resume time, reusing the
    existing park/resume machinery.
  - Decisions journaled with the reasons (parallel-ok, quota-blocked,
    session-busy) so `query-fleet` can explain them.
- **Scope:** scheduler policy in `use-cases/scheduling/`, CapacityRouter
  integration, spawn-input `parallelizable` flag, journal events.
- **Non-goals:** quota forecasting, fair-share balancing across
  providers, preemption.
- **Verification:** unit — all four policy branches with fake ledger;
  integration — parallel-safe task spawns alongside a busy session,
  unsafe one queues with journaled reason.

## Issue 3.3 — Queue visibility surface

- **Labels:** `feature`, `ux`, `desktop` · **Type:** feature
- **Intent:** A queue you can't see is a black box; the user's mental
  model ("florina appends to it") needs a surface or it reads as lost
  work.
- **Expectation:** `query-fleet` (or a `query-queue` verb) returns
  queued tasks with position, wait reason, target provider, and the
  pooled session they'll land on. Desktop Fleet view renders the queue
  section; chat/status can answer "where is my task".
- **Acceptance criteria:**
  - Queue facts queryable via existing command surface; shape covers
    position, reason, provider, ETA-class hint where derivable.
  - Desktop shows queued entries distinctly from running/parked —
    visual-qa captures it.
  - No invented ETAs — only what the journal can prove (quota reset
    times are the only clock-based estimate allowed).
- **Scope:** command-api query, fleet view renderer section, visual-qa
  capture.
- **Non-goals:** drag-to-reorder in v1 (verb suffices); queue
  analytics.
- **Verification:** unit — query shape; visual-qa run captures the
  queue section on a live seeded queue.

---

## PR contract (all issues)

Same contract as the UX Correctness campaign — every PR body carries:
intent, expectation, per-criterion evidence, non-code context (DEC/DG
references), scope & non-goals, verification & risk. `None` /
`Not applicable` / `Unknown—blocked` stated explicitly.

## Sequencing note

M1 first — it delivers "managers ensure quality" on today's model and is
the most testable. M2's session pool assumes verified task boundaries
(verify-then-release-to-pool). M3's scheduler assumes the pool exists to
schedule onto. Within the user's framing, this order ships "smacked on
the head" before "scheduling smarts" — matching their stated priority
that work must *actually work*.
