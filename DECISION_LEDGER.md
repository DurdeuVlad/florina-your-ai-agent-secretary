# Agent Secretary Decision Ledger

This is the Decision Ledger for Agent Secretary — a living record that prevents future agents from repeatedly reopening settled product questions without evidence. It documents the core decisions that shape the architecture and product direction.

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
- **Rationale**: The intended experience is closer to having a live work secretary. Voice excels at delegation, status queries, and narrowly scoped approvals.
- **Consequences**: Must design all commands as voice-compatible; must handle voice approval security. Voice is part of the product thesis and experience, not optional. Do not quietly downgrade to 'optional voice input' without a deliberate future decision. The visual surface supports voice.
- **Alternatives Considered**: Text-only CLI; dashboard-first with voice addon.
- **Reconsideration Trigger**: If validation shows developers strongly prefer text-only interaction even after experiencing voice.

---

**ID**: DEC-003
**Date**: 2026-08-19
**Status**: ACCEPTED
**Decision**: Context isolation is non-negotiable
- **Rationale**: Without isolation, the secretary will confuse projects, merge unrelated concepts, hallucinate relationships, carry assumptions across tasks, and become less useful as concurrency increases.
- **Consequences**: Different projects/tasks must have hard context boundaries. The global secretary retrieves specific context as needed. Context isolation is an architectural primitive, not prompt engineering.
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
- **Consequences**: Approval cards must show structured adapter data (task, agent, requested capability, destination, command, working directory, scope). LLM explanation is supplemental, never the authorization basis.
- **Alternatives Considered**: Natural-language approval flow.
- **Reconsideration Trigger**: If formal verification of LLM output becomes reliable.

---

**ID**: DEC-011
**Date**: 2026-08-19
**Status**: ACCEPTED
**Decision**: The secretary should narrow permissions, never silently widen them
- **Rationale**: A remote secretary controlling local coding agents is close to a remote shell with an LLM between user and OS. Trust model must be correct.
- **Consequences**: The security hierarchy: OS/container boundary → agent-native sandbox → secret/capability broker → secretary policy → human approval → LLM recommendations. Never invert it. An LLM saying 'safe' must not defeat a lower-level restriction.
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
**Status**: ACCEPTED
**Decision**: MVP supports Codex and Claude Code only
- **Rationale**: These are the two highest-value coding agents with the best structured supervision surfaces. Starting narrow proves the thesis without spreading across ten adapters.
- **Consequences**: Codex via app-server JSON-RPC (adapter fidelity A), Claude Code via installed CLI + hooks (adapter fidelity B).
- **Alternatives Considered**: Support more agents immediately; start with a single agent.
- **Reconsideration Trigger**: If a third agent achieves significant adoption and has a strong structured API.

---

**ID**: DEC-014
**Date**: 2026-08-19
**Status**: ACCEPTED
**Decision**: Attention engine is initially deterministic, not LLM-driven
- **Rationale**: Creates a safe path toward intelligence without making the control loop non-deterministic from day one. Easier to debug and audit.
- **Consequences**: Version one uses rule-based always-surface / batch / elevate classification. LLM handles summarization, grouping, ranking, and digest writing — not control flow decisions.
- **Alternatives Considered**: Full LLM-driven attention classification from the start.
- **Reconsideration Trigger**: If rule-based classification proves too rigid for real-world use patterns.

---

**ID**: DEC-015
**Date**: 2026-08-19
**Status**: ACCEPTED
**Decision**: North-star metric is Attention Compression Ratio
- **Rationale**: The product exists to reduce human attention cost, not to improve code generation quality.
- **Consequences**: ACR = agent events that could have demanded human inspection / actual human interruptions. Do not benchmark primarily on SWE-bench or task completion rates — the underlying coding agents own those numbers.
- **Alternatives Considered**: Code quality metrics; task completion rate; agent throughput.
- **Reconsideration Trigger**: If users value the product primarily for coding quality improvements rather than attention savings.

---

## DEFERRED Decisions

**ID**: DEC-016
**Date**: 2026-08-19
**Status**: DEFERRED
**Decision**: Full remote control
- **Rationale**: Happy already proves the remote UX is feasible. Agent Secretary should validate the local attention thesis first.
- **Consequences**: Keep future remote supervision architecturally possible (outbound connections, E2E encryption, paired devices), but do not allow it to balloon initial scope.
- **Reconsideration Trigger**: Strong user demand for mobile/remote supervision.

---

**ID**: DEC-017
**Date**: 2026-08-19
**Status**: DEFERRED
**Decision**: Teams and organizations
- **Rationale**: Validate the individual-developer workflow first. Multi-user RBAC, team collaboration, enterprise admin are later.
- **Reconsideration Trigger**: Enterprise interest or need for shared fleet management.

---

**ID**: DEC-018
**Date**: 2026-08-19
**Status**: DEFERRED
**Decision**: Autonomous task decomposition
- **Rationale**: Those features obscure the hypothesis being tested (is attention compression valuable?).
- **Consequences**: MVP: one human objective → one selected worker. No manager agents auto-selecting Claude vs Codex, no automatic sub-task creation.
- **Reconsideration Trigger**: Users consistently want automated multi-step workflows.

---

## OPEN Decisions

**ID**: DEC-019
**Date**: 2026-08-19
**Status**: OPEN
**Decision**: Exact event normalization schema
- **Rationale**: Blocked on final adapter contracts.
- **Consequences**: Need to define the canonical SupervisorEvent type union. Must cover: AgentStarted, AgentProgress, ToolStarted/Finished, FileChanged, TestStarted/Finished, ApprovalRequested, HumanInputRequested, AgentBlocked, AgentCompleted, AgentFailed, AgentStopped.

---

**ID**: DEC-020
**Date**: 2026-08-19
**Status**: OPEN
**Decision**: Context Capsule storage and retrieval mechanism
- **Rationale**: Blocked on architecture design.
- **Consequences**: Need to decide how capsules are stored, versioned, and fetched, and how old context is summarized or discarded.

---

**ID**: DEC-021
**Date**: 2026-08-19
**Status**: OPEN
**Decision**: Voice intent parsing approach
- **Rationale**: Blocked on voice architecture design.
- **Consequences**: Options include whisper.cpp → structured intent parser → command API. Need to decide if the intent parser is an LLM call, a trained classifier, or rule-based.

---

**ID**: DEC-022
**Date**: 2026-08-19
**Status**: OPEN
**Decision**: Credential/secret brokering model
- **Rationale**: Blocked on security architecture design.
- **Consequences**: Workers should not receive permanent tokens. Capability broker pattern (worker requests create_pr, broker uses stored credential). Exact mechanism TBD.

---

**ID**: DEC-023
**Date**: 2026-08-19
**Status**: OPEN
**Decision**: PTY fallback adapter design
- **Rationale**: Blocked on adapter contract finalization.
- **Consequences**: Need to determine how to detect agent state from terminal output for unsupported agents, and how to handle confidence gaps (known to be low-fidelity).

---

**ID**: DEC-024
**Date**: 2026-08-19
**Status**: OPEN
**Decision**: Worktree lifecycle management
- **Rationale**: Blocked on task lifecycle design.
- **Consequences**: Decide who creates/destroys worktrees (Secretary or agent) and how worktrees are cleaned up after task completion.

---

**ID**: DEC-025
**Date**: 2026-08-19
**Status**: OPEN
**Decision**: Cross-project context resolution strategy
- **Rationale**: Blocked on context routing design.
- **Consequences**: Need a resolution hierarchy for when a user says 'the cache issue' and multiple projects have cache work, to allow the secretary to disambiguate.
