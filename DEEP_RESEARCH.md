# Florina: Deep Research Reference

This document organizes research findings around the core capabilities required to build Florina. Every referenced project is evaluated based on the specific capability it addresses, its reuse potential, and remaining gaps, with a focus on solving the human-attention bottleneck in parallelized agent development while maximizing the reuse of existing open-source components and their hard-learned architectural lessons.

## Closest Products

Products that approximate aspects of the supervisory experience:

### OpenYabby
- **URL:** [https://github.com/OpenYabby/OpenYabby](https://github.com/OpenYabby/OpenYabby)
- **License:** MIT
- **What it does:** Voice/chat entry point, hierarchical multi-agent orchestration, persistent context, multiple coding CLI runners (Claude Code, Codex, Aider, Goose, Cline, Continue), WebRTC voice, local web UI and messaging channels.
- **Why it matters:** Closest match to the broad voice-first vision.
- **Reuse recommendation:** Competitor/reference, not foundation. Florina's differentiation must be sharper than 'voice + multiple agents'.
- **Lesson / Gap:** OpenYabby tries to own both agent orchestration and chat/voice channels, leading to a broad surface. Florina focuses strictly on the attention-routing / noise-suppression layer.

### Happy
- **URL:** [https://github.com/slopus/happy](https://github.com/slopus/happy)
- **License:** MIT
- **What it does:** Remote Claude Code/Codex control, mobile/web apps, real-time voice, E2E-encrypted session content, push notifications for permissions/errors, session handoff.
- **Why it matters:** Closest match to the remote Florina surface.
- **Reuse recommendation:** Strong reference implementation for remote companion architecture and outbound daemon relay patterns.
- **Lesson / Gap:** Happy solves remote mobile interaction for individual agents; Florina solves local multi-agent attention triage and cross-project context isolation.

### Agent Deck
- **URL:** [https://github.com/asheshgoplani/agent-deck](https://github.com/asheshgoplani/agent-deck)
- **License:** MIT
- **What it does:** Fleet/session view, running/waiting/done state, worktrees, groups, cost tracking, remote phone conductor.
- **Why it matters:** Very close to 'agent mission control'.
- **Reuse recommendation:** Direct reference for worktree lifecycle and fleet state visualization.
- **Lesson / Gap:** Exposes raw agent state (`running`/`waiting`/`done`) rather than an attention policy (`ignore`/`batch`/`ask`/`interrupt`).

### Gas Town
- **URL:** [https://github.com/gastownhall/gastown](https://github.com/gastownhall/gastown)
- **License:** MIT
- **What it does:** Persistent multi-agent coordination, worker identities, worktrees, mailboxes/handoffs, Beads-backed work state; supports several coding agents.
- **Why it matters:** Strongest reference for long-running work-oriented (vs session-oriented) orchestration.
- **Reuse recommendation:** Reuse architectural ideas on work orientation; optionally integrate Beads task import/export in later phases.
- **Lesson / Gap:** Gas Town is a heavy, ambitious ecosystem infrastructure play; Florina stays lean and focused on local attention routing.

### Agent Teams AI
- **URL:** [https://github.com/777genius/agent-teams-ai](https://github.com/777genius/agent-teams-ai)
- **License:** AGPL-3.0
- **What it does:** Heterogeneous agents, Kanban board, agent-to-agent collaboration, diff review, approval gates, notifications, task-scoped logs.
- **Why it matters:** Combines heterogeneous agents with approval gates and task-scoped isolation — closest existing reference for the approval workflow.
- **Reuse recommendation:** Study approval gate patterns and task-scoped logs.
- **Lesson / Gap:** Built around a Kanban board. Vibe Kanban's sunset demonstrates that dashboards are not the core wedge.

### Vibe Kanban (sunset)
- **Status:** Sunset (April 2026 export/sunset releases)
- **What it does:** Task planning, one branch/terminal/dev server per agent, inline diff feedback, 10+ coding agents, PR creation.
- **Why it matters:** Nearly the visual developer control plane previously envisioned by the ecosystem.
- **Reuse recommendation:** Do NOT build another Vibe Kanban.
- **Lesson / Gap:** Trying to become a complete web IDE / dev-server manager caused scope ballooning. Reinforces the KISS principle: build an attention inbox, not an IDE.

## Coding Agents

Important agent runtimes/providers Florina supervises:

### Codex (OpenAI)
- **Protocol:** Local `app-server` JSON-RPC API
- **What it does:** Programmatic control over threads, turns, streamed events, errors, structured permission requests (filesystem, network), file-change approvals, user prompts.
- **Why it matters:** The most structured and reliable programmatic supervision surface available.
- **Reuse recommendation:** Use `app-server` JSON-RPC directly as the primary native adapter. Avoid PTY terminal scraping.
- **Adapter fidelity:** A (structured permissions + events)

### Claude Code (Anthropic)
- **Protocol:** Installed CLI + structured lifecycle hooks / Agent SDK
- **What it does:** Lifecycle event interception, tool call tracking, deterministic permission hooks.
- **Why it matters:** Hook decisions narrow authority deterministically without overriding restrictive safety boundaries.
- **Reuse recommendation:** Wrap the user's installed CLI and configure hooks. Avoid becoming an authentication/subscription intermediary (Anthropic restricts third-party auth proxying).
- **Adapter fidelity:** B (structured lifecycle hooks)

## Agent Orchestration & Protocols

### Agent Client Protocol (ACP)
- **URL:** [https://github.com/agentclientprotocol/agent-client-protocol](https://github.com/agentclientprotocol/agent-client-protocol)
- **License:** Apache-2.0
- **What it does:** Standardizes client↔agent communication: sessions, progress updates, cancellation, structured permission requests, tool invocations.
- **Why it matters:** Represents the emerging open standard for agent control planes.
- **Reuse recommendation:** First-class adapter target for near-term ACP-compliant agents alongside native Codex/Claude adapters.
- **Adapter fidelity:** C (ACP-native)

### Claude Squad
- **URL:** [https://github.com/smtg-ai/claude-squad](https://github.com/smtg-ai/claude-squad)
- **License:** AGPL-3.0
- **What it does:** Multiple local coding agents in isolated Git workspaces, background execution, review-before-apply.
- **Why it matters / Lesson:** Proves that basic multi-agent Git worktree multiplexing is solved commodity code.

### CCManager
- **URL:** [https://github.com/kbwo/ccmanager](https://github.com/kbwo/ccmanager)
- **License:** MIT
- **What it does:** Multi-agent worktree management, busy/waiting/idle state tracking, status hooks, experimental safe auto-approvals.
- **Why it matters / Lesson:** Concrete proof that "which agent needs me?" is the core emerging UX demand.

## Workflow and Task Graphs

### Beads
- **URL:** [https://github.com/gastownhall/beads](https://github.com/gastownhall/beads)
- **License:** MIT
- **What it does:** Durable dependency-aware task graph for coding agents, ready-work detection, task claiming, persistent structured memory on Dolt.
- **Why it matters:** Excellent task-state substrate.
- **Reuse recommendation:** Start with a lean embedded SQLite DAG for MVP; provide Beads task import/export interoperability in near-term roadmap.

### LangGraph
- **URL:** [https://github.com/langchain-ai/langgraph](https://github.com/langchain-ai/langgraph)
- **License:** MIT
- **What it does:** Durable graph execution and human-in-the-loop workflows.
- **Why it matters / Lesson:** LangGraph is designed for developers building internal agent reasoning loops. When supervising external agent processes (Codex, Claude), a simple SQLite event journal + scheduler is much lighter and easier to inspect. Skip for MVP.

## Voice Infrastructure

### whisper.cpp
- **URL:** [https://github.com/ggerganov/whisper.cpp](https://github.com/ggerganov/whisper.cpp)
- **License:** MIT
- **What it does:** High-performance, zero-dependency local speech recognition in C/C++ with Voice Activity Detection (VAD).
- **Why it matters:** Enables completely local, private, low-latency push-to-talk voice input without third-party API keys or cloud round-trips.
- **Reuse recommendation:** Primary local ASR engine for MVP push-to-talk.

### Pipecat
- **URL:** [https://github.com/pipecat-ai/pipecat](https://github.com/pipecat-ai/pipecat)
- **License:** BSD 2-Clause
- **What it does:** Real-time multimodal/voice pipelines, WebRTC/WebSocket transports, VAD, interruption handling.
- **Reuse recommendation:** Candidate for continuous real-time voice in the near-term roadmap once push-to-talk validation succeeds.

### LiveKit Agents
- **URL:** [https://github.com/livekit/agents](https://github.com/livekit/agents)
- **License:** Apache-2.0
- **What it does:** Full-duplex realtime voice and multimodal agent framework with distributed infrastructure.
- **Reuse recommendation:** Strong alternative for production remote/continuous voice streaming in later phases.

## Git and Diff Intelligence

### Alibaba Open Code Review
- **URL:** [https://github.com/alibaba/open-code-review](https://github.com/alibaba/open-code-review)
- **License:** Apache-2.0
- **What it does:** Open-source CLI for automated diff analysis, generating structured line-level review findings with tool/agent integration.
- **Why it matters:** Solves deep code review without needing to build custom review heuristics.
- **Reuse recommendation:** Integrate optionally as the Level B deep-review engine for high-risk changes.

### PR-Agent
- **URL:** [https://github.com/The-PR-Agent/pr-agent](https://github.com/The-PR-Agent/pr-agent)
- **License:** Apache-2.0
- **What it does:** Multi-platform automated pull request reviewer and description generator.
- **Lesson:** Dedicated PR review is a solved, standalone category. Florina's core differentiator is the *executive completion digest before deep review*.

## Human Approval & Supervision Architecture

### OpenAI Symphony Architecture (Case Study)
- **Reference:** OpenAI internal orchestrator research (2026)
- **Core Lesson:** The orchestrator owns deterministic work state and workspace lifecycle; the coding agent owns code implementation reasoning.
- **Validation:** OpenAI independently confirmed that context-switching across 3–5+ concurrent agents creates a severe human-attention bottleneck, requiring a deliverable-oriented supervisory plane.
- **Protocol Lesson:** Programmatic app-servers (like Codex app-server) are vastly superior to PTY/tmux automation for reliability.

### Structured Permission Patterns (Codex & ACP)
- **Pattern:** Agent requests capability (e.g. `network:login.microsoftonline.com`, `file_edit:path`) with structured metadata; broker evaluates against policy; user approves specific capability, not an LLM narrative.
- **Reuse Strategy:** Adopt this pattern universally across all adapter tiers.

## Sandboxing and Execution Safety

- **Key Principle:** Git worktrees isolate filesystem state, not process execution authority.
- **Security Model:** OS boundary → Agent Sandbox → Capability Broker → Florina Policy → Human Approval.
- **MVP Boundary:** MVP leverages agent-native sandboxing (Codex built-in OS sandbox, Claude Code permission hooks) without attempting to provision custom container environments, keeping initial complexity low.

## What Is Already Solved (Do Not Re-invent)

1. **Multi-Agent Git Workspace Isolation:** Git worktree creation and lifecycle (solved in Claude Squad, Gas Town, CCManager).
2. **Local Speech-to-Text:** Zero-dependency, privacy-preserving ASR (solved in whisper.cpp).
3. **Structured Agent Session Protocol:** Client-agent JSON-RPC communication (solved in Codex app-server, ACP).
4. **Automated Line-Level Code Review:** Structured diff critique (solved in Open Code Review, PR-Agent).
5. **Real-time Voice Transport:** WebSocket/WebRTC streaming (solved in Pipecat, LiveKit).
6. **Encrypted Mobile-to-Local Relay:** Outbound tunnel session sync (proven in Happy).

## What Is NOT Solved (The Core Florina Opportunity)

1. **Cross-Agent Attention Triage:** A normalized policy engine that turns heterogeneous agent events into high-signal attention items (`ignore`, `batch`, `elevate`, `interrupt`).
2. **Strict Context-Capsule Routing:** True multi-project, multi-task context isolation that prevents LLM context contamination across unrelated repositories.
3. **Evidence-Backed Executive Completion Digest:** A structured deliverable summary cleanly separating deterministic facts (git stats, test outcomes) from model-inferred insights (behavior changes, risk hotspots).
4. **Voice-Safe Approval Broker:** A secure interaction model allowing natural voice queries while strictly enforcing capability-level authorization.

## Product Opportunity Synthesis

The existing open-source ecosystem provides mature, high-quality building blocks for speech recognition, agent communication, git isolation, and code review. 

The missing layer is the **developer-facing attention broker** that ties these components together into a calm, unified supervisory inbox. Florina succeeds by leveraging these proven open-source primitives (whisper.cpp, Codex app-server, ACP, Open Code Review) and focusing its innovation strictly on the **attention engine, context capsules, and supervisory workflow**.
