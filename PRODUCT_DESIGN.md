# Agent Secretary: Product Design

This is the product design document for Agent Secretary — an open-source supervisory layer for coding agents that routes human attention to what matters. The core premise is that developers can parallelize implementation with coding agents faster than they can supervise the resulting work.

## Product Principles

### Attention Over Activity
Do not surface every agent event. Surface what matters. Most agent activity should not interrupt the human.

### Deliverables Over Transcripts
Execution logs and conversation history are secondary. Outcomes are primary. The human interacts with Tasks, Deliverables, Attention Items, and Decisions — not agent sessions.

### Context Isolation by Default
Never blindly mix project/task contexts. This is a non-negotiable architectural primitive. Different projects/tasks must have hard context boundaries. The global secretary retrieves specific context as needed.

### Progressive Disclosure
Start with concise status/summary. Allow drill into: reasoning, diff, logs, tests, session, raw tool events — only when needed.

### Voice as First-Class Interaction
Voice is not speech-to-text pasted into a CLI. Conversation should maintain interaction state and allow natural follow-ups. But voice defines the interaction model; the visual surface supports it. Don't turn the product into a dashboard with a microphone button.

### Provider Independence
Agent-specific details live behind adapters. The secretary sits above heterogeneous agents. Users keep whichever coding agents they already use.

### User-Controlled Autonomy
Different users/tasks may use different execution/approval policies. The product makes policy and consequences visible and configurable rather than imposing one philosophy.

### Inspectability
User must always be able to see what actually happened beneath a secretary summary. LLM summaries are projections over the immutable event journal, never replacements.

## Core Domain Objects

### Project
Durable work context, usually corresponding to a repository or closely related workspace.

### Task
A goal delegated to one or more agents. Human-facing unit of work. A task may be handled by one agent, move between agents, use several parallel agents, produce several sessions, restart after failure, generate multiple Deliverables.

### Agent
A provider/runtime capable of performing work (Codex, Claude Code, future ACP agents, etc.).

### Session (Run)
A concrete execution/conversation instance belonging to a Task. Implementation detail — the human shouldn't need to care unless session-level detail becomes relevant.

### Deliverable
An artifact or meaningful result produced by a Task: code change, commit, diff, PR, analysis, test results, migration, design proposal.

### Event
Immutable timestamped observation of something that happened during task execution. Stored in the append-only event journal before any summarization.

### Attention Item
An event or state that merits human attention. Separate from both Task and Run. Has severity, reason, exact decision requested, affected capability, suggested safe options, deadline/blocking impact.

### Decision
A question that requires or records user judgment.

### Approval
An explicit permission to perform a particular class of action.

### Context Capsule
The isolated body of knowledge needed to reason about one project/task/session. Each project/task/session owns its own relevant context. Capsules exist at three scopes:
- **Project Capsule**: Repository metadata, project-level policies, task list summary. Persists across tasks.
- **Task Capsule**: Objective, agent assignment, run history, deliverables, rolled-up event summaries. Maps 1:1 with a git worktree in MVP.
- **Session Capsule**: Raw conversation, tool calls, event stream. Ephemeral; summarized into the Task Capsule when the session ends.

In MVP, capsules are stored as scoped rows/tables in the local SQLite database — not a retrieval/RAG system. The secretary loads a capsule's content into its working context on demand when discussion enters that scope, and unloads it when switching away.

### Relationships
- A **Project** contains multiple **Tasks**.
- A **Task** delegates work to one or more **Agents**.
- An **Agent** executes work via **Sessions** (Runs).
- **Sessions** produce an append-only stream of **Events** and ultimately generate **Deliverables**.
- **Events** are processed by the Attention Policy to create **Attention Items**.
- **Attention Items** prompt the user for **Decisions** or **Approvals**.
- Each **Project**, **Task**, and **Session** owns a **Context Capsule** at the appropriate boundary to ensure strict isolation.
- In MVP, one **Task** maps to one git **worktree** and one **Task Capsule**.

## Context Routing Model

The secretary acts as a context router, not a context blender, preventing cross-project contamination.

- **Global Secretary Level**: Maintains awareness of what projects exist, what tasks are active, what changed, what requires attention, and where detailed context can be retrieved.
- **Project Level**: Owns repository info, project-level policies, and the task list.
- **Task Level**: Owns the objective, agent assignment, run history, and deliverables.
- **Session Level**: Owns the conversation, tool calls, and raw events.

When the user switches subjects, the secretary routes to the relevant Context Capsule. The switch can be triggered via explicit commands or natural language references. The secretary resolves ambiguous references by evaluating active contexts rather than guessing (e.g., if asked "Did we fix the cache issue?", the secretary looks up active projects with cache work and confirms the intended context). Context is fetched on-demand only when discussion enters a specific boundary. Old context is summarized and eventually discarded when no longer active, keeping the working context lightweight and focused.

## Attention Model

The key insight: 'agent state' ≠ 'attention state'. 
- Running → may need attention (repeated test failures). 
- Waiting → may NOT need attention (question answerable by policy). 
- Done → may need HIGH attention (modified auth boundary). 
- Five completed doc tasks → collapse into one digest.

Agent Secretary transitions from standard states (running / waiting / idle / done) to actionable attention states (ignore / batch / summarize / ask / urgently interrupt).

**Categories and Priorities**:
- FYI (batch)
- Completed
- Blocked
- Approval Required
- Decision Required
- Risk Detected
- Failure
- Conflict
- Scope Changed

**Initial Deterministic Attention Engine**:
- **ALWAYS SURFACE**: Agent requests permission, agent requests human input, agent crashes, repeated failures, task completes, sandbox violation, liveness timeout (no meaningful events — file writes, tool calls, or test runs — for a configurable duration).
- **BATCH**: Normal file writes, ordinary tool calls, routine test progress, informational messages.
- **ELEVATE**: Secrets/auth directories changed, migrations changed, CI/deploy config changed, unexpected lockfile changes, network permission requested, filesystem scope expansion, push/merge/deploy requested.

After deterministic routing, an LLM handles the soft tasks: summarizing, grouping related events, ranking ambiguous items, and writing executive digests.

## Voice Experience

Voice should support:
- **Querying status**: 'What needs me right now?' / 'Which agents are finished?'
- **Switching projects**: 'Switch to the compiler project'
- **Interrogating deliverables**: 'Summarize the implementation' / 'Show me the risky part'
- **Approving actions**: 'Approve that' / 'Allow task twelve to run the test suite'
- **Redirecting tasks**: 'Ignore that for now'
- **Starting tasks**: 'Start a Codex task to add cursor pagination to invoices'
- **Asking comparisons**: 'Compare the two approaches'
- **Receiving concise proactive interruptions** (without becoming an annoying narrator)

Voice is excellent for delegation, status, quick updates, and narrow approvals. Voice is bad for examining large diffs, distinguishing similar identifiers, comparing type signatures, approving ambiguous shell pipelines, and reviewing security-sensitive code.

Voice and CLI share the same typed command API. Voice should never become a parallel orchestration system.

**Security Hierarchy for Voice Approvals**:
- **Voice only**: read/status/pause
- **Voice + explicit scoped phrase**: low-risk one-time permission, only when the voice readback includes deterministic fields from the adapter (not LLM-generated text). Example: "Approve network access to registry.npmjs.org for task oauth" — the task name, permission type, and destination are structured data read aloud.
- **Authenticated UI confirmation**: push/PR/network expansion — user must visually verify the structured approval card
- **Strong device confirmation**: merge/deploy/destructive cloud action

> **Compatibility with DEC-010**: Voice approvals do NOT approve LLM summaries. For low-risk voice approvals, the secretary reads back deterministic structured fields (task, capability, destination, scope) from the adapter data. For anything requiring the full approval card, voice merely stages the approval to a visual surface where the user verifies structured data before confirming.

## Visual Experience

The visual surface complements voice, providing persistent orientation and handling high-context tasks. 

Conceptual home screen (attention inbox, NOT a Kanban):
```
NEEDS YOU                                      3

HIGH   checkout-refactor
       Wants network access to npmjs.org
       [allow once] [deny] [inspect]

MED    password-reset
       Implementation complete. 9 files, +284/-71, 23/23 tests passing
       Main risk: token invalidation behavior changed
       [review digest] [open diff] [create PR]

LOW    docs-cleanup + api-comments + test-rename
       3 tasks completed; no production behavior changed
       [read combined digest]

WORKING                                        5
invoice-pagination  Codex    tests running
oauth-migration     Claude   editing
...
```

**Surfaces**: Active projects, active tasks, attention inbox, completed deliverables, blocked work, decisions, agent/session inspector.

There are four primary interfaces over the same local control plane:
1. **Desktop App (Electron / Tauri)**: High-craft, lightweight desktop frontend (inspired by the clean, minimal aesthetic of Codex Desktop and Raycast). Provides the persistent visual Attention Inbox, one-click capability approval cards, side-by-side completion digest & diff viewer, and floating Push-to-Talk voice HUD with global hotkey support.
2. **CLI (`secretary` / `asec`)**: Terminal-first workflow, scripting, headless CI/SSH environments, and automation.
3. **Push-to-Talk Voice**: Global hotkey, sub-second speech-to-speech interaction for hands-free delegation, quick status queries, and spoken approvals.
4. **Remote Companion (Near-Term / Later)**: Mobile/web paired device for push notifications, status monitoring, and away-from-desk approvals.

## Agent Adapters

Heterogeneous agents appear behind a single interface. The secretary never needs to understand the internal reasoning loop of each coding agent — only operational state and artifacts. We normalize events, not agent internals, into one canonical internal event schema.

**Adapter Fidelity Tiers**:
- **A**: Structured permissions + events (Codex app-server JSON-RPC)
- **B**: Structured lifecycle hooks (Claude Code hooks)
- **C**: ACP-native (compatible agents)
- **D**: Structured JSON CLI output (other tools)
- **E**: PTY heuristic (last-resort compatibility)

The attention engine adjusts its behavior based on adapter fidelity:
- **Tier A–B**: Auto-approve policies are available (the secretary has structured data to evaluate). Permission requests are presented with full structured context.
- **Tier C**: Auto-approve where ACP provides sufficient structured context; fall back to manual approval otherwise.
- **Tier D–E**: No auto-approval permitted. All permission-like events require human confirmation because the secretary cannot reliably distinguish actual permission requests from other output.

## Task Lifecycle

A Task moves through stages:
`created → delegated → running → attention-needed / blocked → running → completed → reviewed / accepted`

Tasks can fail and be cancelled. A worker process terminating successfully does not equal task completion. The task may need human review or have open decisions. In MVP, each individual task maps to one selected worker — but multiple tasks run concurrently across different worktrees and agents. Autonomous task decomposition and auto-selecting agents are deferred.

## Deliverable Review

When an agent claims completion, the secretary produces a Completion Digest. The distinction between observed (deterministic) and model-inferred information must be clearly visible.

**Completion Digest Structure**:
- **Objective**: What the agent says it achieved.
- **Observed changes**: Exact files, diff stats, branch (deterministic, from tools).
- **Behavior**: LLM description of externally visible behavior changes (inferred).
- **Verification**: Exact tests/commands and outcomes.
- **Risk**: Potential review hotspots.
- **Open questions**: Anything unresolved or assumed.
- **Agent notes**: Useful final-context information.
- **Recommended human action**: review / answer / rerun / create PR / abandon.

**Diff Intelligence Levels**:
- **Level A**: Cheap deterministic digest (git diff --stat, changed paths, renames, lockfile changes, migration changes, test files, config/security dirs, test results, commit metadata).
- **Level B**: Explicit deep review (call a dedicated code-review agent only when requested or if policy dictates high risk).

## Product Scope

### MVP
- Codex and Claude Code adapters
- Desktop App (Electron / Tauri): Minimal, high-craft desktop frontend featuring the visual Attention Inbox (`NEEDS YOU` cards, live fleet `WORKING` status), one-click capability approvals, completion digest inspector, and global hotkey push-to-talk voice HUD
- CLI (`secretary`, short alias `asec`): Full terminal parity (`secretary run`, `status`, `inbox`, `show`, `approve`, `stop`, `digest`)
- Multiple concurrent tasks, each mapping to one worktree and one run (no multi-agent or multi-run per task in MVP)
- Normalized event ingestion from adapters
- Deterministic attention engine (always-surface / batch / elevate rules + liveness timeout check)
- LLM completion digest separating observed git/test facts from inferred behavior changes and risk hotspots
- Context capsules (project/task isolation backed by local SQLite)
- Push-to-talk voice (OpenAI Realtime API fast-start WebRTC/WebSocket bridge with local whisper.cpp fallback)
- SQLite-backed task/event/attention state
- Immutable event journal
- Execution safety: MVP relies on agent-native sandboxing (Codex's built-in sandbox, Claude Code's permission system). The Secretary does not provision OS-level containers or sandboxes — it enforces policy atop existing agent security.

### Near-Term
Things that logically follow after validation:
- Additional agent adapters (ACP-native, PTY fallback)
- TUI / lightweight web UI
- Configurable attention policies
- Task dependencies (simple DAG)
- Beads interoperability
- Continuous real-time voice (Pipecat/LiveKit)
- Remote companion (paired E2E-encrypted)

### Later
Intentionally deferred:
- Organization/team collaboration
- Multi-user RBAC
- Autonomous task decomposition / manager agents
- Semantic long-term memory
- Custom code editor / IDE
- Cloud coding sandbox
- Automated merge/deploy
- Full Kanban/project manager
- Slack/messaging integrations
- Hosted synchronization
- Plugin marketplace
- Enterprise administration / billing
