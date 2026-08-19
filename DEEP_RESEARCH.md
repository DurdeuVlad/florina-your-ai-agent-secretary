# Agent Secretary: Deep Research Reference

This document organizes research findings around the core capabilities required to build Agent Secretary. Every referenced project is evaluated based on the specific capability it addresses, its reuse potential, and remaining gaps, with a focus on solving the human-attention bottleneck in parallelized agent development.

## Closest Products

Products that approximate the whole experience:

### OpenYabby
- **URL/License:** Unknown
- **What it does:** Voice/chat entry point, hierarchical multi-agent orchestration, persistent context, multiple coding CLI runners (Claude Code, Codex, Aider, Goose, Cline, Continue), WebRTC voice, local web UI and messaging channels.
- **Why it matters:** Closest match to the broad voice-first vision.
- **Reuse recommendation:** Competitor/reference, not foundation. Agent Secretary's differentiation must be sharper than 'voice + multiple agents'.
- **Gap:** Focuses on orchestration; the attention-routing / noise-suppression layer is the differentiation opportunity.

### Happy
- **URL/License:** MIT license
- **What it does:** Remote Claude Code/Codex control, mobile/web apps, real-time voice, E2E-encrypted session content, push notifications for permissions/errors, session handoff.
- **Why it matters:** Closest match to the remote secretary surface.
- **Reuse recommendation:** Strong UX/reference implementation; wrapper architecture worth studying.
- **Gap:** Remote companion UX, not the local supervisory/attention layer.

### Agent Deck
- **URL/License:** Unknown
- **What it does:** Fleet/session view, running/waiting/done state, worktrees, groups, cost tracking, remote phone conductor.
- **Why it matters:** Very close to 'agent mission control'.
- **Reuse recommendation:** Direct competitor; differentiate on semantic triage and approvals rather than session multiplexing.
- **Gap:** Shows agent state (running/waiting/done) but not attention state (ignore/batch/ask/interrupt).

### Gas Town
- **URL/License:** Unknown
- **What it does:** Persistent multi-agent coordination, worker identities, worktrees, mailboxes/handoffs, Beads-backed work state; supports several coding agents.
- **Why it matters:** Strongest reference for long-running work-oriented (vs session-oriented) orchestration.
- **Reuse recommendation:** Reuse ideas and optionally Beads interoperability; Gas Town itself is much broader/heavier than MVP.
- **Gap:** Broader infrastructure play, not focused on the attention-compression problem.

### Agent Teams AI
- **URL/License:** Unknown
- **What it does:** Heterogeneous agents, Kanban board, agent-to-agent collaboration, diff review, approval gates, notifications, task-scoped logs.
- **Why it matters:** Reference for approval gates and task-scoped design.
- **Reuse recommendation:** Reference for approval gates and task-scoped design.
- **Gap:** Kanban-centric; attention model is the differentiator.

### Vibe Kanban (sunset)
- **URL/License:** Unknown (April 2026 sunset/export behavior)
- **What it does:** Task planning, one branch/terminal/dev server per agent, inline diff feedback, 10+ coding agents, PR creation.
- **Why it matters:** Nearly the visual developer control plane described.
- **Reuse recommendation:** Do NOT build another Vibe Kanban. Its sunset argues against making a large custom IDE/dashboard the wedge.
- **Gap:** Scope ballooned; reinforces KISS approach.

## Coding Agents

Important agent runtimes/providers the secretary could supervise:

### Codex (OpenAI)
- **URL/License:** Unknown
- **What it does:** Local app-server JSON-RPC API: threads, turns, streamed events, errors, permission requests, file-change approvals, network approvals, user questions.
- **Why it matters:** The most structured supervision surface currently available.
- **Reuse recommendation:** Use app-server directly as primary adapter. Avoid scraping terminal output. OpenAI recommends headless app-server for programmatic orchestration.
- **Adapter fidelity:** A (structured permissions + events)

### Claude Code (Anthropic)
- **URL/License:** Unknown
- **What it does:** Structured lifecycle hooks, deterministic permission interception, programmatic agent access via Agent SDK.
- **Why it matters:** Hook decisions cannot override more restrictive permission rules — useful for a supervisor that should only narrow authority.
- **Reuse recommendation:** Wrap the user's installed CLI + use hooks. Avoid becoming a Claude subscription/authentication intermediary (Anthropic restricts this for third-party Agent SDK apps unless approved).
- **Adapter fidelity:** B (structured lifecycle hooks)

## Agent Orchestration

Frameworks that coordinate multiple agents:

### Agent Client Protocol (ACP)
- **URL/License:** Unknown
- **What it does:** Standard client↔agent sessions, progress updates, cancellation, permission requests, session discovery/configuration.
- **Why it matters:** Very close to the protocol the supervisor needs below the UI.
- **Reuse recommendation:** Make ACP a first-class adapter, but retain native adapters because adoption is not universal.
- **Adapter fidelity:** C (ACP-native)

### Claude Squad
- **URL/License:** Unknown
- **What it does:** Multiple local coding agents in isolated Git workspaces, background work, review-before-apply, terminal-first UI.
- **Why it matters:** Establishes that simple multi-agent terminal multiplexing is already solved.
- **Reuse recommendation:** Do not rebuild its core value proposition.

### CCManager
- **URL/License:** Unknown
- **What it does:** Multi-agent/worktree management, explicit busy/waiting/idle states, status hooks, experimental safe-prompt auto-approval.
- **Why it matters:** Proof that 'which agent needs me?' is emerging as the next UX problem.
- **Reuse recommendation:** Study state detection; build on structured protocols rather than terminal heuristics.

## Workflow and Task Graphs

### Beads
- **URL/License:** Unknown
- **What it does:** Durable dependency-aware task graph for coding agents, ready-work detection, task claiming, persistent structured memory, Dolt-backed state.
- **Why it matters:** Good task-state substrate.
- **Reuse recommendation:** Great interoperability target; probably too much infrastructure to hard-depend on for first release. Start with SQLite, expose Beads adapter/import-export later.

### LangGraph
- **URL/License:** Unknown
- **What it does:** Durable graph execution and resumable human-in-the-loop workflows.
- **Why it matters:** Useful if you own the graph nodes; probably wrong core abstraction for supervising independently implemented coding-agent harnesses.
- **Reuse recommendation:** Skip for MVP. Simpler scheduler + event journal is easier to reason about when the actual worker is an independent coding harness.

## Voice

### Pipecat
- **URL/License:** Unknown
- **What it does:** Real-time multimodal/voice pipelines, WebSocket/WebRTC transports, multi-agent handoffs, push-to-talk examples.
- **Why it matters:** Voice plumbing.
- **Reuse recommendation:** Reuse rather than invent. Probably unnecessary for push-to-talk MVP. Adopt when continuous real-time voice becomes validated.

### LiveKit Agents
- **URL/License:** Unknown
- **What it does:** Realtime voice/multimodal agent infrastructure.
- **Why it matters:** More complete real-time transport/runtime option.
- **Reuse recommendation:** Strong choice once true continuous/mobile voice matters. Not needed for MVP.

### whisper.cpp
- **URL/License:** Unknown
- **What it does:** Local speech recognition with VAD support, broad device/platform deployments.
- **Why it matters:** Privacy-friendly local speech input.
- **Reuse recommendation:** Excellent optional local ASR path. Good fit for push-to-talk MVP.

## Git and Diff Intelligence

### Alibaba Open Code Review
- **URL/License:** Unknown
- **What it does:** Open-source diff/code-review CLI with structured line-level findings; supports coding-agent integrations and deterministic review plumbing.
- **Why it matters:** Solves the deep-review component.
- **Reuse recommendation:** Integrate optionally for Level B deep review. Don't spend MVP building another reviewer.

### PR-Agent
- **URL/License:** Unknown
- **What it does:** Open-source community-maintained PR reviewer.
- **Reuse recommendation:** Reference; dedicated PR review is already mature enough as a standalone category.

## Human Approval

### OpenAI Symphony Architecture
- **URL/License:** Internal
- **What it does:** OpenAI's internal system. Problem statement almost exactly matches Agent Secretary's. Engineers constrained by context switching, not agent capability. Shifted from supervising sessions to supervising deliverables.
- **Why it matters:** Key architecture lesson: the scheduler should own deterministic work state; the coding agent should own implementation reasoning. Codex app-server API found more scalable than automating CLI/tmux sessions. Issue tracker became the control plane: one task → isolated workspace → agent process → human reviews outcomes.
- **Reuse recommendation:** Not open-source, but the strongest external validation of the thesis and architectural reference.

### Codex Permission System
- **What it does:** Fine-grained filesystem/network requests, host client can grant only subset of what was requested. Sandbox mode determines what commands can access; approval policy determines when agent pauses to ask.
- **Reuse recommendation:** Model the universal approval broker on this pattern.

### Claude Code Permission System
- **What it does:** Hooks can intercept lifecycle/tool events, influence permission decisions deterministically. Hook decisions cannot override more restrictive permission rules.
- **Reuse recommendation:** Good model for 'secretary should narrow permissions, never silently widen them'.

### ACP Permission Mechanism
- **What it does:** Passes explicit tool call/operation to client, expects explicit decision (not natural-language authorization).
- **Reuse recommendation:** Aligns perfectly with 'approve the underlying capability, not an LLM summary'.

## Sandboxing and Execution

Key insight: worktrees isolate development state, not authority. A Git worktree doesn't prevent an agent from executing `cat ~/.ssh/id_ed25519` or `rm -rf ~/Documents`.

Codex separates sandbox mode (OS-enforced workspace boundaries, disabled network) from approval policy. The secretary's security hierarchy should be: OS/container boundary → agent-native sandbox → secret/capability broker → secretary policy → human approval → LLM recommendations. Never invert it.

## Remote/Background Execution

### Happy's Approach
- E2E encrypted sync between local CLI/agent and remote mobile/web clients.
- Local daemon establishes outbound connection (no unauthenticated listening port).
- Reference for remote mode architecture.

Recommended remote model: paired-device with device-specific keys, short-lived sessions, revocation, replay protection, visible paired devices list, emergency 'disable remote control' command, separate permissions for view/message/approve/admin.

## Notifications/State Sync

The event journal is truth; LLM summaries are projections. Store every meaningful state transition before summarizing. The summary must never replace source events. Critical for debugging, security audits, regression testing of the attention model.

SQLite is sufficient for MVP state storage. Append-only event journal with normalized events from all adapters.

## What Is Already Solved

- Running many agents concurrently (Claude Squad, Gas Town, Vibe Kanban, Agent Deck, CCManager)
- One Git workspace per task (standard pattern)
- Persistent task/dependency graphs (Beads)
- Voice input/output transport (Pipecat, LiveKit, whisper.cpp)
- Remote phone control (Happy, Agent Deck)
- Diff summaries / PR review (Vibe Kanban, Open Code Review, PR-Agent)
- Individual-agent approvals (Codex sandbox, Claude Code hooks)
- Structured coding-agent control improving rapidly (Codex app-server, ACP, Claude hooks)

## What Is Not Solved

- Unified approval inbox across heterogeneous agents (each backend expresses risk/permission differently; ACP helps but native systems still differ)
- Semantic 'what actually needs me?' triage (existing managers show session states, not an attention policy that understands task importance and decision cost)
- Cross-agent executive digest ('what happened across my fleet, what is risky, what do I decide next?')
- Uniform safe execution across heterogeneous agents
- Voice-safe destructive approvals (transport exists, structured permissions exist, securely connecting them is open)

## Product Opportunity

The poorly solved integration is the developer-facing supervisory layer that converts many coding-agent sessions into a unified stream of deliverables, decisions, and attention requests while maintaining strict context separation.

The potentially defensible open-source primitive is not 'multi-agent orchestration' — it is the combination of a cross-agent event model, universal approval model, attention policy engine, evidence-backed work digest, and secure voice/remote decision interface.

OpenAI's Symphony gives the best external validation: once several capable coding agents operate concurrently, the system bottleneck becomes the person trying to supervise them. That bottleneck — not voice itself — is the product.
