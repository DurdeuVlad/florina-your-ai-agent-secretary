# Florina Decision Ledger

This is the Decision Ledger for Florina — a living record that prevents future agents from repeatedly reopening settled product questions without evidence. It documents the core decisions that shape the architecture and product direction.

---

## ACCEPTED Decisions

**ID**: DEC-001  
**Date**: 2026-08-19  
**Status**: ACCEPTED  
**Decision**: The product is a supervisor, not another coding agent  
- **Rationale**: Coding intelligence is a commodity; attention compression across heterogeneous agents is the less-solved layer. The ecosystem already has Codex, Claude Code, etc. Building another coding agent would be a benchmark race against agent vendors.
- **Consequences**: The product's primary responsibility is routing attention and mediating work. It may use models internally (for summarization, attention ranking), but is not competing on code generation.
- **Alternatives Considered**: Build a full coding agent with supervision features; build a framework that includes code generation.
- **Reconsideration Trigger**: If coding agents stop being independently capable enough, or if the attention problem disappears because agents become fully autonomous.

---

**ID**: DEC-002  
**Date**: 2026-08-19  
**Status**: ACCEPTED  
**Decision**: Real-time voice is core to the product identity  
- **Rationale**: The intended experience is closer to having a live work Secretary—now named Florina. Voice excels at delegation, status queries, and narrowly scoped approvals.
- **Consequences**: Must design all commands as voice-compatible; must handle voice approval security. Voice is part of the product thesis and experience, not optional. Do not quietly downgrade to 'optional voice input' without a deliberate future decision. The visual surface supports voice.
- **Alternatives Considered**: Text-only CLI; dashboard-first with voice addon.
- **Reconsideration Trigger**: If validation shows developers strongly prefer text-only interaction even after experiencing voice.

---

**ID**: DEC-003  
**Date**: 2026-08-19  
**Status**: ACCEPTED  
**Decision**: Context isolation is non-negotiable  
- **Rationale**: Without isolation, Florina will confuse projects, merge unrelated concepts, hallucinate relationships, carry assumptions across tasks, and become less useful as concurrency increases.
- **Consequences**: Different projects/tasks must have hard context boundaries. The global Florina retrieves specific context as needed. Context isolation is an architectural primitive, not prompt engineering.
- **Alternatives Considered**: Single shared context; soft/advisory boundaries.
- **Reconsideration Trigger**: If a reliable technique for maintaining accuracy in very large mixed contexts is discovered.

---

**ID**: DEC-004  
**Date**: 2026-08-19  
**Status**: ACCEPTED  
**Decision**: Deliverables over sessions  
- **Rationale**: A task may use one agent, several agents, restart after failure, generate multiple deliverables. The human should not need to care about session mechanics unless relevant.
- **Consequences**: Sessions are implementation details. Human-facing interaction centers on Tasks, Deliverables, Attention Items, and Decisions. Hierarchy: Projects → Tasks → Deliverables → Decisions.
- **Alternatives Considered**: Session-centric UI (like terminal multiplexers).
- **Reconsideration Trigger**: If users consistently prefer session-level interaction over task/deliverable-level.

---

**ID**: DEC-005  
**Date**: 2026-08-19  
**Status**: ACCEPTED  
**Decision**: Multi-project and multi-session concurrency is fundamental  
- **Rationale**: The entire reason for the product is concurrency. Single-agent/single-project use doesn't justify a supervisory layer.
- **Consequences**: Even if MVP begins with limited providers, the model assumes simultaneous work across multiple projects, repositories, agents, and sessions.
- **Alternatives Considered**: Single-project focus.
- **Reconsideration Trigger**: If the user base consistently uses only one project at a time.

---

**ID**: DEC-006  
**Date**: 2026-08-19  
**Status**: ACCEPTED  
**Decision**: Visual UI supports voice, not the other way around  
- **Rationale**: Vibe Kanban's sunset shows dashboards aren't the wedge. The inbox metaphor (needs-you / working / done) is closer to the attention-routing thesis.
- **Consequences**: There should be a persistent inspection surface (CLI/TUI/web), but the product should not collapse into a dashboard-first experience. The home screen is an attention inbox, not a Kanban board.
- **Alternatives Considered**: Dashboard-first, Kanban-first.
- **Reconsideration Trigger**: If users overwhelmingly prefer a visual-first experience and voice usage is negligible.

---

**ID**: DEC-007  
**Date**: 2026-08-19  
**Status**: ACCEPTED  
**Decision**: Agent autonomy is user-configurable  
- **Rationale**: Different users and tasks have different risk profiles. A documentation task doesn't need the same approval gates as a production deployment.
- **Consequences**: Support different permission/approval modes rather than forcing a single conservative policy. The product makes policy and consequences visible and configurable.
- **Alternatives Considered**: Enforce conservative execution for all tasks; fully autonomous execution.
- **Reconsideration Trigger**: If configurable autonomy leads to widespread security incidents.

---

**ID**: DEC-008  
**Date**: 2026-08-19  
**Status**: ACCEPTED  
**Decision**: Build an inbox, not another IDE  
- **Rationale**: OpenYabby, Vibe Kanban, Agent Teams AI show scope balloons quickly when combining IDE, Kanban, voice, memory, connectors. The wedge is attention compression, not a coding environment.
- **Consequences**: CLI-first supervisor with inbox-first UX. Four surfaces over the same local control plane: CLI, TUI/web, push-to-talk voice, remote companion.
- **Alternatives Considered**: Full IDE integration; Kanban board; elaborate web dashboard.
- **Reconsideration Trigger**: If users cannot effectively use the product without deeper IDE integration.

---

**ID**: DEC-009  
**Date**: 2026-08-19  
**Status**: ACCEPTED  
**Decision**: PR review is a feature, not the wedge  
- **Rationale**: Dedicated PR review is already mature (Open Code Review, PR-Agent). Don't compete with dedicated review tools; integrate them optionally.
- **Consequences**: The differentiator is the executive digest before deep review.
- **Alternatives Considered**: Build a full code review system as the core feature.
- **Reconsideration Trigger**: If no adequate open-source review tool remains available.

---

**ID**: DEC-010  
**Date**: 2026-08-19  
**Status**: ACCEPTED  
**Decision**: Approve the underlying capability, never an LLM summary  
- **Rationale**: LLM text could be wrong or manipulated. Structured data from adapters is trustworthy. ACP and Codex already expose structured permission requests.
- **Consequences**: Approval cards must show structured adapter data (task, agent, requested capability, destination, command, working directory, scope). LLM explanation is supplemental, never the authorization basis. Low-risk voice approvals only approve deterministic fields read aloud (task, capability, destination, scope); higher-authority actions stage approvals to a visual confirmation card.
- **Alternatives Considered**: Natural-language approval flow.
- **Reconsideration Trigger**: If formal verification of LLM output becomes reliable.

---

**ID**: DEC-011  
**Date**: 2026-08-19  
**Status**: ACCEPTED  
**Decision**: Florina should narrow permissions, never silently widen them  
- **Rationale**: A remote Florina controlling local coding agents is close to a remote shell with an LLM between user and OS. Trust model must be correct.
- **Consequences**: The security hierarchy: OS/container boundary → agent-native sandbox → secret/capability broker → Florina policy → human approval → LLM recommendations. Never invert it. An LLM saying 'safe' must not defeat a lower-level restriction.
- **Alternatives Considered**: Trust LLM risk assessments for permission decisions.
- **Reconsideration Trigger**: If LLM safety classification reaches formal-verification levels of reliability.

---

**ID**: DEC-012  
**Date**: 2026-08-19  
**Status**: ACCEPTED  
**Decision**: Event journal is truth; LLM summaries are projections  
- **Rationale**: Critical for debugging, security audits, regression testing of the attention model, and eventually team/enterprise use.
- **Consequences**: Store every meaningful state transition in an immutable append-only event journal before summarizing. Summaries never replace source events.
- **Alternatives Considered**: Store only summaries to save space.
- **Reconsideration Trigger**: If storage costs become prohibitive (unlikely with SQLite for local use).

---

**ID**: DEC-013  
**Date**: 2026-08-19  
**Status**: ACCEPTED (amended 2026-08-20 issue #40; provider set expanded 2026-09-13, issues #60–#62)  
**Decision**: MVP supports Codex and Claude Code only  
- **Rationale**: These are the two highest-value coding agents with the best structured supervision surfaces. Starting narrow proves the thesis without spreading across ten adapters.
- **Consequences**: Codex via app-server JSON-RPC (adapter fidelity A), Claude Code via installed CLI + structured lifecycle hooks (adapter fidelity B). The Claude Code hooks adapter (`src/adapters/claude-hooks-adapter.ts`) wraps the user's installed `claude` CLI in headless (`-p`) mode and configures lifecycle hooks (PreToolUse, PostToolUse, PermissionRequest, Stop, Notification, SessionStart) that emit structured JSON events, which are mapped to the canonical `SupervisorEvent` schema. The previous PTY regex adapter (`src/adapters/claude-adapter.ts`) was misclassified as Tier B; it has been reclassified as Tier E per DEC-023 (PTY heuristics are Tier E, not Tier B). Tier B = "installed CLI + structured lifecycle hooks / Agent SDK" — NOT PTY scraping.
- **Alternatives Considered**: Support more agents immediately; start with a single agent; classify PTY regex as Tier B (rejected — contradicts DEC-023 and DEC-011).
- **Reconsideration Trigger**: If a third agent achieves significant adoption and has a strong structured API.

**Amendment 2026-09-13 (issues #60–#62)**: The provider set expands beyond the MVP pair — the capacity-routing thesis (DEC-029) requires at least three providers to be meaningful. New providers: Devin CLI via `devin acp` (Tier C, DEC-030), Gemini CLI via `gemini --acp` (Tier C), and Antigravity `agy` headless `stream-json` (Tier D). All providers are local-only; Devin Cloud sessions are explicitly out of scope.

---

**ID**: DEC-014  
**Date**: 2026-08-19  
**Status**: ACCEPTED  
**Decision**: Attention engine is initially deterministic, not LLM-driven  
- **Rationale**: Creates a safe path toward intelligence without making the control loop non-deterministic from day one. Easier to debug and audit.
- **Consequences**: Version one uses rule-based always-surface / batch / elevate classification (including a liveness timeout check). LLM handles summarization, grouping, ranking, and digest writing — not control flow decisions.
- **Alternatives Considered**: Full LLM-driven attention classification from the start.
- **Reconsideration Trigger**: If rule-based classification proves too rigid for real-world use patterns.

---

**ID**: DEC-015  
**Date**: 2026-08-19  
**Status**: ACCEPTED  
**Decision**: North-star metric is Attention Compression Ratio  
- **Rationale**: The product exists to reduce human attention cost, not to improve code generation quality.
- **Consequences**: ACR = total classifiable agent events processed by the attention engine / actual human interruptions surfaced. Do not benchmark primarily on SWE-bench or task completion rates — the underlying coding agents own those numbers.
- **Alternatives Considered**: Code quality metrics; task completion rate; agent throughput.
- **Reconsideration Trigger**: If users value the product primarily for coding quality improvements rather than attention savings.

---

**ID**: DEC-020  
**Date**: 2026-08-19  
**Status**: ACCEPTED  
**Decision**: Context Capsules are scoped SQLite state, not a retrieval system  
- **Rationale**: Capsules must be simple enough for MVP. A RAG/vector-search approach adds complexity without proven value. Scoped rows in SQLite match the existing storage decision.
- **Consequences**: Three capsule scopes: Project (repo metadata, policies, task list), Task (objective, run history, deliverables, event summaries — maps 1:1 with a worktree), Session (raw events, conversation — ephemeral, summarized into Task Capsule on completion). Florina loads the relevant capsule on-demand when context switches. **Amendment 2026-09-13 (DEC-029, issue #65)**: a fourth **User scope** is added — durable preference memories (provider/model rules, work-type affinities, quota-conditioned fallbacks) auto-written by the Florina from conversation. User scope is global but read-only to managers/workers; it feeds the CapacityRouter, not task context.
- **Alternatives Considered**: Vector database / RAG retrieval; in-memory-only capsules; single flat context.
- **Reconsideration Trigger**: If capsule sizes exceed what fits in a single LLM context window, necessitating retrieval.

---

**ID**: DEC-021  
**Date**: 2026-08-19  
**Status**: ACCEPTED  
**Decision**: Dual-track voice pipeline: OpenAI Realtime API for sub-second fast-start, whisper.cpp for local offline  
- **Rationale**: Realtime speech-to-speech (via WebRTC/WebSocket) natively provides sub-second latency, voice activity detection (VAD), interruption handling, and direct function/tool calling against the local daemon API without multi-week audio plumbing. `whisper.cpp` + local TTS is preserved as the local/offline privacy alternative.
- **Consequences**: The Realtime voice session is passed the Florina's typed tool definitions (`start_task`, `get_inbox`, `approve_permission`, etc.). Spoken intent triggers tool calls executed on `localhost`. The voice model never executes arbitrary shell commands directly.
- **Alternatives Considered**: Local-only whisper.cpp pipeline exclusively (high latency/robotic turns in early versions); cloud STT + LLM + cloud TTS pipeline (high latency, lacks native interruption handling).
- **Reconsideration Trigger**: If local realtime speech-to-speech models reach sub-second parity on consumer hardware.

---

**ID**: DEC-026  
**Date**: 2026-08-19  
**Status**: SUPERSEDED by DEC-038  
**Decision**: Canonical CLI binary name is `florina`, with official short alias `flor`  
- **Rationale**: `sec` suffers from severe namespace collision with standard security tooling (e.g. `sec` Simple Event Correlator, AppSec/InfoSec scripts, SEC regulatory tools) and timing units. `florina` is completely unambiguous, expressive, matches the product persona. `flor` provides a clean, 4-letter, non-colliding short alias for frequent CLI use.
- **Consequences**: Primary CLI binary is `florina`, install symlink/alias is `flor`. Commands work interchangeably (e.g. `florina run` or `flor run`). Package/repo name is `florina`.
- **Alternatives Considered**: `sec` (rejected due to security/sec namespace collision); `as` (rejected due to standard shell keyword / assembler collisions).
- **Reconsideration Trigger**: If a compelling community convention emerges.
- **History**: Originally chose `secretary`/`asec`; binary names amended by DEC-038 (project rebrand to Florina).

---

**ID**: DEC-027  
**Date**: 2026-08-19  
**Status**: ACCEPTED  
**Decision**: MVP relies on agent-native sandboxing, not Florina-provisioned containers  
- **Rationale**: Codex and Claude Code both have built-in sandboxing and permission systems. The Florina enforces policy atop these. Provisioning OS-level containers (Docker, etc.) for local CLIs is a massive scope item with minimal thesis-validation value.
- **Consequences**: The security hierarchy in MVP starts at the agent-native sandbox level. The Florina's role is to broker approvals and enforce policy, not to provision execution environments. The OS/container layer in the hierarchy is documented for future hardening, not MVP implementation.
- **Alternatives Considered**: Docker-based sandbox per task; firejail/bubblewrap per agent; Florina-managed VMs.
- **Reconsideration Trigger**: If agent-native sandboxes prove insufficient for multi-tenant or high-security use cases.

---

**ID**: DEC-028  
**Date**: 2026-08-19  
**Status**: ACCEPTED  
**Decision**: Desktop frontend is a lightweight, high-craft desktop app (Electron / Tauri)  
- **Rationale**: To feel as polished and fast as tools like Codex Desktop, Raycast, and Claude Desktop, the visual surface needs native OS integration: global push-to-talk hotkeys, system tray status, floating HUD / attention notifications, and instant keyboard navigation (`j`/`k`, `y`, `d`).
- **Consequences**: The Desktop UI connects to the local Florina Daemon over `localhost` IPC/WebSocket. It renders the Attention Inbox, structured capability approval cards, side-by-side completion digest & diff views, and voice waveform indicator. It is strictly a client to the daemon, ensuring 100% feature and state parity with the CLI.
- **Alternatives Considered**: Web-only browser dashboard (lacks global OS push-to-talk hotkeys and system tray hooks); pure TUI only (harder to view rich side-by-side diffs and audio visualizers).
- **Reconsideration Trigger**: If maintaining the desktop wrapper creates unacceptable build/distribution overhead.

---

**ID**: DEC-022  
**Date**: 2026-08-19  
**Status**: ACCEPTED  
**Decision**: Credential/secret brokering model — capability broker pattern where workers request actions and the broker executes using stored credentials  
- **Rationale**: Workers (coding agents) must never receive permanent credentials (GitHub tokens, cloud keys). Injecting secrets into worker processes or environments risks leakage via logs, error messages, or prompt injection. A broker pattern keeps credentials in a vault that the worker cannot directly access; the worker requests an action (e.g. `create_pr`) and receives only the action result.
- **Consequences**:
  - **Credential vault** (`src/daemon/credential-broker.ts`): securely stores credentials using the OS keychain where available (Windows Credential Manager via `cmdkey`, macOS Keychain via `security`) and falls back to an AES-256-GCM encrypted local file store (PBKDF2 key derivation from machine-specific material). `listCredentials` returns names only — never values.
  - **Capability broker** (`src/daemon/capability-broker.ts`): workers call `executeAction(action, params, credentialName, context)`. The broker (1) evaluates the request against the policy engine from #12 (DEC-007, DEC-011) — a `deny` means the credential is never accessed; (2) retrieves the credential from the vault; (3) executes the action via a registered executor, passing the credential internally; (4) returns only the `ActionResult` to the worker — never the raw credential.
  - **Audit log**: every credential use is recorded in the immutable event journal (DEC-012) with the action, credential name (not value), timestamp, and success/failure.
  - **Security hierarchy** (DEC-011): the capability broker sits at the "secret/capability broker" rung, below Florina policy rung. Policy is evaluated before any credential is retrieved. An LLM "safe" verdict can never defeat a policy deny.
- **Alternatives Considered**: Environment variable injection into worker processes (risks leakage via logs/process inspection); credential proxy daemon (same concept but separate process — unnecessary for MVP since the Florina daemon already brokers); direct developer interactive auth per action (too much friction for concurrent multi-task workflows).
- **Reconsideration Trigger**: If a need arises for credential rotation, scoped/temporary credentials, or cross-machine credential sharing that the current vault model cannot support.

---

## DEFERRED Decisions

**ID**: DEC-016  
**Date**: 2026-08-19  
**Status**: DEFERRED  
**Decision**: Full remote control  
- **Rationale**: Happy already proves the remote UX is feasible. Florina should validate the local attention thesis first.
- **Consequences**: Keep future remote supervision architecturally possible (outbound connections, E2E encryption, paired devices), but do not allow it to balloon initial scope.
- **Alternatives Considered**: Build mobile-first from day one; exclude remote control entirely from future architecture.
- **Reconsideration Trigger**: Strong user demand for mobile/remote supervision.

---

**ID**: DEC-017  
**Date**: 2026-08-19  
**Status**: DEFERRED  
**Decision**: Teams and organizations  
- **Rationale**: Validate the individual-developer workflow first. Multi-user RBAC, team collaboration, enterprise admin are later.
- **Consequences**: Architecture remains focused on single-user local control plane.
- **Alternatives Considered**: Multi-tenant cloud backend from start.
- **Reconsideration Trigger**: Enterprise interest or need for shared fleet management.

---

**ID**: DEC-018  
**Date**: 2026-08-19  
**Status**: ACCEPTED (amended 2026-09-13, issue #63)  
**Decision**: Autonomous task decomposition via per-project manager agents  
- **Rationale**: Originally deferred because decomposition obscured the attention-compression hypothesis. The first user's workflow requires it: the Florina delegates to a per-project manager agent (itself a provider agent), which decomposes objectives and spawns workers.
- **Consequences**: Manager agents exist but may only dispatch workers through the Florina daemon's MCP tool server (`florina_spawn_task` and friends). Every spawn is journaled (DEC-012), policy-checked (DEC-011), quota-checked (DEC-029), and visible in the attention inbox. Native provider subagents that bypass the daemon are disallowed — there is no parallel orchestration channel. A manager is a Task with a special capsule/tool set and is itself quota-tracked.
- **Alternatives Considered**: Managers spawning workers natively inside their own runtime (rejected: invisible to journal, policy, and quota); no manager agents (superseded).
- **Reconsideration Trigger**: If manager-driven decomposition generates attention noise that defeats DEC-015's metric.

---

## OPEN Decisions (For Architecture Phase)

**ID**: DEC-019  
**Date**: 2026-08-19  
**Status**: OPEN  
**Decision**: Exact event normalization schema  
- **Rationale**: Blocked on final adapter contracts for Codex app-server and Claude Code hooks.
- **Consequences**: Need to define the canonical TypeScript/JSON schema for `SupervisorEvent` union type covering: `AgentStarted`, `AgentProgress`, `ToolStarted`, `ToolFinished`, `FileChanged`, `TestStarted`, `TestFinished`, `ApprovalRequested`, `HumanInputRequested`, `AgentBlocked`, `AgentCompleted`, `AgentFailed`, `AgentStopped`.
- **Alternatives Considered**: Loose untyped JSON events; strict Protobuf definitions; agent-specific event pass-through.
- **Blocked On**: Adapter contract specification in architecture design.

---

**ID**: DEC-023  
**Date**: 2026-08-19  
**Status**: ACCEPTED  
**Decision**: PTY fallback adapter design — omit PTY fallback in early versions (Approach C); Tier E contract preserved but no concrete adapter shipped  
- **Rationale**: The PTY fallback (Tier E) is a last-resort path for agents with no structured supervision surface. Three approaches were evaluated in `docs/PTY_FALLBACK_DESIGN.md`: (A) generic regex matching on terminal output, (B) PTY scrape with a vision model, (C) omit PTY fallback entirely in early versions. Approach C is recommended because it aligns with DEC-013 (MVP = Codex Tier A + Claude Code Tier B only), DEC-011 (never silently widen permissions — refusing to guess at permission prompts from unstructured text is the conservative choice), and the product thesis DEC-015 (attention compression requires trustworthy event sources; a fragile regex scraper or hallucination-prone vision classifier generates false-positive confirmation cards and missed prompts, both worsening Attention Compression Ratio). Approach A is deterministic but fragile (per-agent pattern maintenance, version drift). Approach B imports a non-deterministic vision model into event generation, in tension with DEC-014 (deterministic attention engine) and complicating audit (DEC-012).
- **Consequences**: No concrete Tier E PTY adapter is implemented in the MVP or near-term. Unsupported agents run outside the Florina until they receive a structured adapter (Tier A–D). `AdapterFidelityTier.E` and the Tier E contract (no auto-approve; all permission-like events require human confirmation) remain defined in `src/domain/enums.ts` and `src/adapters/base.ts` so the attention engine and policy layer are forward-compatible. The confidence gap is eliminated by not attempting detection — the strongest possible strategy. When a third agent achieves significant adoption (DEC-013 reconsideration trigger), first pursue a structured adapter (ACP-native Tier C or JSON CLI Tier D); only fall back to a PTY heuristic if no structured surface exists and demand justifies the maintenance burden, preferring Approach A (regex, deterministic, auditable) over Approach B (vision) as the interim.
- **Alternatives Considered**: Generic regex matching on terminal output (Approach A — pragmatic but fragile, high maintenance); PTY scrape with vision model (Approach B — robust detection but high complexity, cost, non-deterministic input, hallucination risk); omit PTY fallback entirely in early versions (Approach C — chosen).
- **Resolved By**: Issue #13 — `docs/PTY_FALLBACK_DESIGN.md`.

---

**ID**: DEC-024  
**Date**: 2026-08-19  
**Status**: ACCEPTED  
**Decision**: Worktree lifecycle management  
- **Rationale**: Each Task maps 1:1 to one git worktree and one run in MVP (DEC-020). A deterministic branch naming convention and a safe prune policy are required so Florina-managed work is clearly distinguishable from human-authored branches and uncommitted work is never silently destroyed.
- **Consequences**: Branch naming convention is `florina/<task-slug>` (sanitized slug, lowercase alphanumeric + hyphens). Worktrees are placed in a sibling `.florina-worktrees/` directory at a deterministic path. Worktrees are retained until an explicit prune; `pruneWorktree` removes only clean worktrees and throws `DirtyWorktreeError` on dirty ones (DEC-011 — never silently destroy uncommitted work). Dirty detection via `git status --porcelain` surfaces a status the attention engine can elevate for human review. Implemented in `src/daemon/worktree.ts` (`WorktreeManager`).
- **Alternatives Considered**: Automatic worktree deletion on task completion; retain all worktrees until explicit user prune; ephemeral temp directories.
- **Resolved By**: Issue #7 — `src/daemon/worktree.ts`.

---

**ID**: DEC-025  
**Date**: 2026-08-19  
**Status**: OPEN  
**Decision**: Cross-project context resolution strategy  
- **Rationale**: Blocked on context routing design.
- **Consequences**: Need a deterministic disambiguation hierarchy for natural language queries (e.g., "how is the auth task doing?" when multiple projects have auth tasks).
- **Alternatives Considered**: Interactive conversational clarification ("Did you mean Project A or Project B?"); recency bias (most recently active project); error on ambiguity.
- **Blocked On**: Context routing design.

---

**ID**: DEC-029  
**Date**: 2026-09-13  
**Status**: ACCEPTED  
**Decision**: Quota-aware capacity routing across the user's provider subscriptions  
- **Rationale**: The first user pays for multiple agent subscriptions (Codex, Claude, Devin, Gemini/Antigravity) with per-provider preferences and per-provider quota windows. Treating subscriptions as a pooled capacity resource — rather than silos — is the product's differentiator: work migrates when a provider runs dry and pauses only when all providers are exhausted.
- **Consequences**:
  - `QuotaLedger` normalizes per-provider quota as `{provider, window, used_pct, resets_at, source}`. Sources: Codex `account/rateLimits/read` over app-server JSON-RPC (authoritative), Claude statusline `rate_limits` / underlying `anthropic-ratelimit-unified-*` headers, and reactive 429/exhaustion detection for Devin and Gemini/agy (no official quota API).
  - `CapacityRouter` routes new work to the highest-preference provider with capacity (proactive polling where supported) and triggers failover on exhaustion (reactive everywhere).
  - **Failover mechanism**: freeze the current session, then resume the Task on the next preferred provider in the *same git worktree*, primed from the Task Capsule (DEC-020/024). All providers are local, so worktree + capsule is the uniform handoff artifact — no diff shipping or cloud handoff.
  - When every provider is exhausted the project parks; the daemon schedules resume at the earliest `resets_at`.
  - A **provider preference profile** is a model-level ruleset, not a provider ranking: `provider → model → work-type → quota-conditional fallback`. It supports per-model allow/deny rules (e.g. "Claude: never Opus, never Faber; default latest Sonnet; Haiku for repeatable reading work") and quota-conditioned chains (e.g. "Devin: GPT extra-high until quota, then SWE-2 or GLM-5 whichever is free/better"). The Florina **auto-writes preference memories** captured from ordinary conversation — stated preferences are persisted without requiring a formal interview — and the profile remains editable via CLI. Built config-first for a single user; generalized onboarding is not a goal. Preference memories persist in a **User-scope Context Capsule** (a fourth scope; see DEC-020 amendment).
  - **Preferences are prompts, not code** (amendment, 2026-09-13): preference rules are natural-language text injected into manager prompts on a **need-to-know basis** — a project's manager sees only its own project's preferences plus global defaults (DEC-003). Different projects carry different preferences ("this project matters → Claude/Codex priority; that one → Devin/Gemini only"). The split is two-layer: managers *express preference* in their `florina_spawn_task` calls (soft layer, NL-interpreted); the daemon *enforces feasibility* against the QuotaLedger, model deny-rules, and policy (hard layer — an LLM's provider choice can never defeat a quota exhaustion or a deny rule, per DEC-011). Per-project prompts live in the Project capsule; global defaults in the User capsule.
- **Alternatives Considered**: Reactive-only failover (insufficient — proactive polling prevents mid-task stalls on Codex/Claude); static per-task provider pinning (rejected — defeats quota pooling); Devin Cloud participation in failover (rejected — local-only providers; cloud handoff breaks the uniform worktree+capsule model).
- **Resolved By**: Issues #60, #64, #65.

---

**ID**: DEC-030  
**Date**: 2026-09-13  
**Status**: ACCEPTED  
**Decision**: ACP (Agent Client Protocol) is the generic Tier C adapter surface  
- **Rationale**: Both local Devin CLI (`devin acp`) and Gemini CLI (`gemini --acp`) expose ACP — JSON-RPC 2.0 over stdio with session management, structured permission requests, and usage notifications. One ACP client adapts both providers at Tier C fidelity instead of two bespoke adapters. ACP's `PromptResponse.usage` / `UsageUpdate` also feeds the QuotaLedger (DEC-029).
- **Consequences**: `src/adapters/acp-adapter.ts` implements a generic ACP client; per-provider config supplies launch command, auth, and capability flags. ACP `session/request_permission` maps to `ApprovalRequested` (supports DEC-010 structured approvals). Native higher-fidelity adapters remain for Codex (Tier A — required for `account/rateLimits/read`) and Claude Code (Tier B hooks). Antigravity `agy` stays Tier D headless stream-json (requires a PTY bridge for its non-TTY output bug — an I/O shim, not Tier E scraping). Gemini ACP has known flaky-429 issues under OAuth; treat 429s as a reactive quota signal.
- **Alternatives Considered**: Bespoke per-provider adapters (rejected — duplicated effort; ACP already standardizes sessions and permissions); Tier D stream-json for all CLIs (lower fidelity, no structured permission surface).
- **Resolved By**: Issues #61, #62.

---

**ID**: DEC-031  
**Date**: 2026-09-13  
**Status**: ACCEPTED  
**Decision**: Interruption discipline — resolve from memory, grants, and context before ever asking the human  
- **Rationale**: The user's scarce resource is energy, not information. The product exists so the human can debate direction and ideas with the Florina — not manage agents. Interrupting with a question whose answer is already recorded (preference memories, granted scopes, project policies) or easily inferable from observable state is a product failure regardless of how politely it is phrased.
- **Consequences**: Before any Attention Item or spoken question reaches the human, the Florina must check: User-scope preference memories (DEC-020/029), granted capability scopes (#67), project/task capsule contents, and deterministic observable state (git, tests, quota ledger). A question that resolves there is answered silently and journaled — the human may audit the inference afterward but is never blocked on it. Conversational clarification (DEC-025) is the *last* resort, reserved for genuine ambiguity with material consequences.
- **Alternatives Considered**: Ask-when-uncertain defaults (rejected — converts the human back into the router); blanket autonomy (rejected by DEC-011 for anything not covered by grants/policy).
- **Reconsideration Trigger**: If silent inference produces materially wrong decisions that erode trust.

---

**ID**: DEC-032  
**Date**: 2026-09-13  
**Status**: ACCEPTED  
**Decision**: Done means proven — task completion is gated on verification evidence, not agent self-report  
- **Rationale**: Writing code is the easy part; proving it works is the hard, important part. An agent's claim of completion is a claim. The human's attention should only be spent reviewing *verified* deliverables.
- **Consequences**: A Task may not surface as `completed` in the inbox without verification evidence attached to its Completion Digest: tests run with results, build/lint/typecheck status, and — where applicable — observed runtime behavior. Manager agents (DEC-018) are responsible for driving verification before reporting completion; a "finished" worker that produced no proof is routed back with a verification objective, not surfaced to the human. Verification results are deterministic adapter/journal facts (DEC-010 discipline applies — observed evidence is primary, LLM narrative is supplemental).
- **Alternatives Considered**: Trust agent self-reports with a human-review step (rejected — review burden lands on the human); post-hoc review agent for everything (kept as Level B diff intelligence, opt-in per PRODUCT_DESIGN).
- **Resolved By**: Issue #68.

---

**ID**: DEC-033  
**Date**: 2026-09-13  
**Status**: ACCEPTED  
**Decision**: Collaborative idea ledger — the Florina is a thinking partner during ideation, with an explicit human gate before anything becomes delegated work  
- **Rationale**: The first user ideates chaotically — long unstructured voice monologues mixing goals, constraints, and tangents. The Florina's job is to think *with* them: build on the ideas, run background research, surface structure, name the fog and open questions, and ask the questions the user cannot ask themselves — living in the user's shoes. She does NOT silently convert conversation into work.
- **Consequences**:
  - **Per-idea markdown ledger**: each idea (or each system being updated by an idea) gets a persistent, growing markdown document the Florina maintains — structured spec, research notes, open questions, decisions-in-progress. The file is a first-class artifact the user can read and edit. Ledgers live in a **global Florina ideas directory** by default (ideas precede project selection); when a project is specified for an idea, its ledger is **promoted** — moved into that project. Format: single `.md` + YAML frontmatter (status, linked project, created/updated) so the daemon can index and promote without parsing prose.
  - **Compile-on-request**: when the user says they're ready, the Florina offers to compile the ledger into an actionable **Brief** (spec + delegation plan: which project, which manager, what task breakdown, provider/model per task). The Brief is *shown to the user* — "if it's all right, I start giving it to agents; if not, we keep working on it."
  - **Hard delegation gate**: no agent is ever dispatched from ideation without explicit user confirmation of the compiled Brief. Confirming a Brief is a Decision, journaled (DEC-012).
  - On confirmation, the Brief decomposes into Tasks dispatched to the project's manager agent (DEC-018) through the normal daemon path — no special channel.
  - Delegation plans include building the **testing/proving systems** first-class — verification infrastructure is part of every task order, per DEC-032 (done means proven).
- **Alternatives Considered**: Automatic distillation-to-dispatch (rejected — the user must review before agents act); transcript summarization after the fact (rejected — loses the live collaborative-research loop); dedicated ideation mode switch (rejected — ideation is ambient, not a mode).
- **Resolved By**: Issue #69.

---

**ID**: DEC-034  
**Date**: 2026-09-13  
**Status**: ACCEPTED  
**Decision**: The Florina runs on our own agentic loop — loop + todo + tools + context management — with LiteLLM as the model connector  
- **Rationale**: The Florina is the only agent loop we own (DEC-001); every worker/manager is a provider agent. Owning the loop means the Florina's reasoning model is pluggable (today's best reasoning model tomorrow, a local model for privacy later) and her capabilities (background research, spec structuring, preference capture, inbox triage) are our tools, not a provider's.
- **Consequences**:
  - **`src/florina/`** module: the reasoning-action loop, a typed tool registry, a plan/todo tool (the model maintains its own plan, per goose's "maintain a plan" pattern), and context management (capsule load/unload per DEC-020 + condenser-style history compression per OpenHands).
  - **Connector**: LiteLLM proxy — OpenAI-compatible `/chat/completions` against 100+ providers, plus spend tracking/budgets that feed the QuotaLedger (DEC-029). The daemon calls the proxy endpoint; no provider SDKs in our code.
  - **Voice boundary unchanged** (DEC-021): Realtime API remains the ears/mouth (VAD, interruptions, speech-to-speech). Its tool calls land on the same typed command API; heavyweight reasoning (research, spec structuring, Brief compilation) runs in the Florina loop on LiteLLM-connected models. The split is turn-taking vs. thinking.
  - **Patterns stolen from open source**: OpenHands — stateless loop over an append-only event stream (already our journal, DEC-012), condenser, confirmation mode, max-iterations/budget guards; goose — tool inspection pipeline (security → permission → repetition checks before execution) and profile-based capability sets; Cline SDK — harness separated from surfaces so CLI/voice/desktop share one loop; opencode — durable admission before execution (we already journal-first).
  - Florina loop events are journaled like provider events (DEC-012) — her reasoning is inspectable, not hidden.
- **Alternatives Considered**: Riding a provider's agent SDK for the Florina loop (rejected — reintroduces provider dependence at the one layer that must be ours); LangChain/LangGraph (rejected — heavyweight abstraction for a loop we understand and want to keep small); direct per-provider SDK calls (rejected — LiteLLM gives plug-and-play + spend tracking for free).
- **Resolved By**: Issue #70.

---

**ID**: DEC-035  
**Date**: 2026-09-13  
**Status**: ACCEPTED  
**Decision**: Continuous agents (Florina, managers) use a three-layer context model — hot working context, warm condenser + capsules, cold journal + durable memory  
- **Rationale**: The Florina and project managers run for days, not sessions. Unbounded context growth degrades reasoning and inflates cost; naive truncation loses the plot. OpenHands' condenser and two-tier memory are proven open-source patterns that map cleanly onto our existing journal + capsule primitives.
- **Consequences**: Threshold-triggered summarization (keep first N + last M verbatim, summarize the middle — OpenHands `RollingCondenser` pattern); condensation itself emits a journaled event carrying `forgotten_event_ids` so compression never destroys the record (DEC-012). Durable memory is two-tier, mirroring capsules: User scope (cross-project preferences, DEC-029) + Project scope (repo knowledge). Context health (window fill, last condensation, memory size) is a first-class per-agent status the attention engine can elevate. Full design: `docs/DESKTOP_UI.md` § Continuous-agent context.
- **Alternatives Considered**: Fixed sliding window (loses early goals/spec); restart-fresh sessions (breaks continuity, forces manual context carry); vector-store RAG (rejected per DEC-020 — capsules stay simple scoped state).
- **Reconsideration Trigger**: If condensation measurably drops task-critical facts (detect via verification regressions, DEC-032).
- **Resolved By**: Issues #75 (condenser), #76 (capsule rollup pipeline), #77 (context health).

---

**ID**: DEC-036  
**Date**: 2026-09-13  
**Status**: ACCEPTED  
**Decision**: Federated sub-Florina daemons — remote machines run the full stack and register with a parent daemon as capacity pools  
- **Rationale**: The first user already runs Codex/Claude on a separate server. A machine-to-machine federation extends capacity across devices without inventing a second protocol: a child daemon presents to its parent as a provider-shaped adapter, so the recursion is the architecture.
- **Consequences**:
  - `RemoteFlorinaAdapter` on the parent connects to the child daemon's control-plane WebSocket. The child's entire fleet appears in the parent's QuotaLedger as `provider@host` entries; the child reports its own quota state upstream.
  - Delegation uses the identical typed command API; the child's `SupervisorEvent`s roll up the chain (fidelity stays structured end-to-end — Tier A/B quality is inherited, not re-derived).
  - Worktrees and event journals remain local to each machine. The **Task Capsule is the delegation payload** — the same handoff artifact as cross-provider failover (DEC-029), so "move task to the server" and "move task to Gemini" are the same mechanism.
  - The project (repo) must exist on the remote machine. Recursion composes: a child may itself have sub-secretaries.
  - **Security**: explicit pairing/auth between daemons; the parent may narrow but never widen a child's policy (DEC-011). Remote commands are capability-scoped like everything else.
  - Distinct from DEC-016 (remote *control* — the human-facing phone companion, still deferred): this is remote *capacity*.
- **Alternatives Considered**: SSH-managed remote agents (rejected — loses the child's own journal, attention engine, and quota ledger; a shell is not a supervisor); treating remote providers as direct adapters over SSH (rejected — no local policy boundary on the remote machine).
- **Reconsideration Trigger**: If upstream event volume or trust-boundary complexity defeats the attention model.
- **Resolved By**: Issue #78.

---

**ID**: DEC-037
**Date**: 2026-09-13
**Status**: ACCEPTED
**Decision**: Repository-wide hexagonal (ports & adapters) architecture — the core owns the domain model and all port contracts; adapters depend inward; the bootstrap layer alone composes concrete implementations
- **Rationale**: The codebase had grown consumer-owned contracts (e.g. `AgentAdapter` living in `src/adapters/base.ts`, `WorktreeStatus` in `src/daemon/worktree.ts`) and a flat module layout where any module could import any other. As adapters, daemon services, storage, and surfaces multiply, inward-pointing dependencies must be enforced mechanically rather than by convention.
- **Consequences**:
  - **`src/core/domain/`** is the canonical home of the domain model (enums, types, factories, capabilities, policy, approval, SupervisorEvent). **`src/core/application/ports/`** holds the pure port contracts the core owns (`ClockPort`, `IdGeneratorPort`, `EventBusPort`/`EventPublisherPort`/`EventSubscriberPort`, `AgentRuntimePort`, `WorktreePort`). Core files may import only other core files — never adapters, daemon, storage, node builtins, or external packages.
  - Dependency direction: `domain <- application ports/use-cases <- inbound/outbound adapters`. A future **`src/bootstrap/`** layer is the only place concrete implementations are composed into the core.
  - **Compatibility facades**: legacy `src/domain/*.ts` paths are thin `export *` re-exports resolving inward to `src/core/domain`, so existing consumers keep working while migration proceeds incrementally. Facades are temporary migration surfaces, not permanent API.
  - Conformance is enforced by `tests/architecture-boundaries.test.ts`, which statically scans core import specifiers and the legacy facades — the boundary is a test, not a convention.
- **Alternatives Considered**: Keep the flat layout and rely on code review (rejected — no mechanical enforcement); big-bang rewrite moving all consumers at once (rejected — unsafe mid-flight with parallel feature work); ports owned by their consumers (rejected — inverts the dependency direction this decision exists to establish).
- **Resolved By**: Issue #90.

---

**ID**: DEC-038
**Date**: 2026-09-14
**Status**: ACCEPTED
**Decision**: Rebrand the project from Agent Secretary to **Florina** — full rename, clean break
- **Rationale**: Owner direction — Florina is the product and persona name. A full rename avoids the ambiguity of maintaining two names (product vs persona) and keeps the vocabulary self-consistent.
- **Consequences**:
  - Package name `florina`; CLI binaries `florina` + `flor` (amends DEC-026).
  - Persona name is Florina throughout: `FlorinaDaemon`, `FlorinaLoop`, `FlorinaMcpServer`, `RemoteFlorinaAdapter`, etc.
  - Internal identifiers renamed with no compatibility aliases: `florina/` branch prefix (amends DEC-024), `.florina-worktrees/`, `florina_*` MCP tool names, `florina.lock` lockfile. Pre-rebrand worktrees and saved manager configs are not migrated.
  - Repo rename to `florina` is a follow-up (GitHub-side operation).
- **Alternatives Considered**: Florina as product name with "Secretary" retained as the in-product persona (rejected — two names, permanent ambiguity); rename with backward-compatible aliases for `secretary_*` tool names and worktree paths (rejected — pre-1.0, clean break is cheaper than a permanent compat layer).
- **Resolved By**: Issue #66.
