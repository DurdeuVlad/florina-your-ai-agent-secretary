# Provider Topology: Agent Model, Native Subagents, Brokered vs. Federated

Resolves brief § 11 (three senses of "agent," provider-native subagent
topology) with primary-source research, dated 2026-09-20. Amends DEC-018
via DEC-041 (`DECISION_LEDGER.md`).

## 1. The three senses of "agent" — and why the current domain model is mostly right

The domain currently uses `Agent` for provider/runtime identity only
(`PRODUCT_DESIGN.md` § Core Domain Objects: "A provider/runtime capable of
performing work (Codex, Claude Code, future ACP agents, etc.)"). Checking
that against the market:

1. **Provider/runtime** — Codex, Claude Code, Gemini CLI, Devin, `agy`. A
   capability surface with an adapter fidelity tier (DEC-013/030).
2. **Agent profile/role** — a reusable configuration *within* a runtime:
   system prompt, tool scope, model choice. Claude Code's `.claude/agents/*`
   subagent definitions, Gemini CLI's `.gemini/agents/*.md` files with YAML
   frontmatter, and GitHub Copilot's `architect.agent.md` / custom agent
   pattern are all this sense. Florina's own "project manager" is this sense
   too — a Task with a special capsule/tool set (DEC-018) is functionally an
   Agent Profile applied to a Task.
3. **Active execution instance** — a concrete run: Florina's `Session`
   (Run), a Claude Code Agent View row, a Gemini CLI subagent invocation, an
   ACP session.

**Finding: sense (1) is correctly modeled today. Sense (3) is correctly
modeled as `Session`/Run. Sense (2) has no first-class domain type** — it is
currently implicit in how a manager Task is configured. Recommendation: add
a lightweight **Agent Profile** concept (name, system-prompt/role, tool
scope, default provider/model preference) that a Task references, rather
than adopting the brief's full proposed vocabulary (Runtime-Connection /
Task-Objective / Delegation Edge / etc.) wholesale. The existing
Project → Task → Deliverable/Decision hierarchy (DEC-004) plus a new Agent
Profile layer covers all three senses without a domain rewrite. This is a
**scoped addition, not a replacement** — see `docs/GAP_ANALYSIS.md` for the
issue that carries it.

## 2. What providers actually expose today (primary-source findings)

All access dates 2026-09-20.

| Provider | Native subagent capability | Structured control surface? | Source |
|---|---|---|---|
| **Claude Code** | Subagents: isolated Claude instances spawned by a parent session, own context window/system prompt/tools/permissions; nested subagents to depth 5; foreground (blocking) or background (concurrent) | The *parent session* sees only each subagent's final summary — no external structured API for a supervisor outside that session to enumerate or control subagent state mid-run | [Anthropic subagents course](https://anthropic.skilljar.com/introduction-to-subagents); [Tembo.io 2026 guide](https://www.tembo.io/blog/claude-code-subagents); [morphllm.com](https://www.morphllm.com/claude-subagents) |
| **Claude Code Agent View** (research preview, May 11 2026) | `claude agents` — a CLI dashboard listing every live session (session id, waiting-on-you flag, last response, timestamp), reply-inline or attach | This is a **session-list view**, not a subagent-spawn API — it observes sibling top-level sessions the *user* started, not a tree Florina dispatched. No public API confirmed for an external process to enumerate this list programmatically as of this research pass. | [claude.com/blog/agent-view-in-claude-code](https://claude.com/blog/agent-view-in-claude-code); [code.claude.com/docs/en/agent-view](https://code.claude.com/docs/en/agent-view) |
| **Gemini CLI** | Subagents: hub-and-spoke — main session is Hub, subagents are Spokes; defined as markdown+YAML in `.gemini/agents/*.md`; `/agents`, `/agents reload`, `/agents enable/disable` commands; "Remote Subagents" doc page exists | Experimental as of March 2026; management is via in-session slash commands, not a documented external RPC surface for a supervisor process | [developers.googleblog.com](https://developers.googleblog.com/subagents-have-arrived-in-gemini-cli/); [github.com/google-gemini/gemini-cli docs/core/subagents.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/core/subagents.md); [geminicli.com/docs/core/remote-agents](https://geminicli.com/docs/core/remote-agents/) |
| **ACP (Agent Client Protocol)** | A draft `clientCapabilities.subagents` field exists; JetBrains' ACP adapter mirrors a `nativeSubagentSessions` capability via `_meta.jetbrains.air.capabilities` | Subagent exposure is gated behind **bilateral capability negotiation** and is explicitly draft-stage — not yet a stable, universally-implemented part of the protocol | [agentclientprotocol.com](https://agentclientprotocol.com/get-started/introduction); [github.com/agentclientprotocol/claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp) |
| **OpenAI Codex app / Symphony** | Symphony ties Codex agents to an external tracker (Linear) as the control plane — issue-driven dispatch, not a subagent tree inside one session | Symphony is itself an *external* orchestrator over Codex sessions — structurally the same shape as Florina's own manager pattern (DEC-018), not a competing "native nested subagent" model | [helpnetsecurity.com](https://www.helpnetsecurity.com/2026/04/28/openai-symphony-codex-orchestration-linear/); [verdent.ai/guides](https://www.verdent.ai/guides/what-is-symphony-open-source) |
| **GitHub Copilot** | Cloud agent sessions manageable from a repo's Agents tab; "lead agent" pattern (`architect.agent.md`) is a community convention, not a platform-native nested-dispatch API | Sessions are enumerable/observable via the Agents tab and API; multi-agent coordination is achieved by convention (one agent's prompt tells it to delegate), not a platform primitive | [docs.github.com/copilot/concepts/agents/cloud-agent/agent-management](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/agent-management) |

**Conclusion: no provider today exposes a stable, external, structured API
for a third-party supervisor to enumerate and control its native subagent
tree.** Every "agent view"/"subagent" feature found is either (a) internal
to one session/CLI instance, addressed to that session's own user, or (b) a
capability still in draft/experimental status. This directly informs § 3.

## 3. Brokered vs. federated — decision

**Recommendation: Brokered remains the default and only supported dispatch
path (DEC-018 stands unchanged for anything Florina dispatches). A third,
narrower state — Observed — is added for topology Florina did not dispatch
but can see.**

This gives three states per unit of provider-side execution, reusing the
adapter fidelity-tier philosophy (DEC-013):

| State | Meaning | Consequences |
|---|---|---|
| **Managed** | Florina/a manager dispatched it through `florina_spawn_task` (DEC-018) | Full journal, policy, quota accounting; eligible for auto-approval per adapter tier; counted as a Task |
| **Observed** | A provider surfaces read-only visibility into work Florina did not dispatch (e.g. a user manually ran `claude` with subagents outside Florina, and the adapter can see session metadata) | Rendered in the inspector as informational context only; never auto-approved; never counted as a Task or against quota attribution the user didn't request; explicitly labeled "not dispatched by Florina" |
| **Opaque** | No visibility at all (the common case today, per § 2's findings) | Not represented; the provider is a black box below the `Session` boundary, exactly as today |

Why not adopt full federation (Florina discovering and controlling native
subagent trees) now: § 2 shows the control surfaces required for that don't
yet exist in stable form on any provider Florina targets. Building toward a
federation model today would mean coding against draft/experimental,
single-vendor, frequently-changing surfaces (ACP's draft `subagents` field,
Gemini's "experimental as of March 2026" subagents, Claude Code's May-2026
research-preview Agent View) — high maintenance burden for low current
value, and in tension with DEC-013's "structured, stable surface first"
philosophy that already rejected PTY scraping (DEC-023) for the same reason.

Why not stay purely opaque either: as these surfaces stabilize (Gemini's
subagents graduate from experimental, ACP's `subagents` capability goes
GA), pretending there's nothing to see becomes a real product gap — a user
running Claude Code's Agent View alongside Florina would reasonably expect
Florina to at least *show* that other work exists, even without controlling
it. The Observed tier gives that without inventing a new orchestration
channel (DEC-018's core worry: "invisible to journal, policy, and quota" —
Observed items are explicitly and permanently excluded from quota/policy
accounting, so they can never be mistaken for Florina's own dispatch).

**Consequence for DEC-018**: "native provider subagents that bypass the
daemon are disallowed" is preserved for *dispatch* — Florina/managers never
gain a second way to spawn work outside `florina_spawn_task`. What's added
is a read path: an adapter *may* report Observed-tier events for
provider-native activity it can see, purely for display. This is recorded
as DEC-041 (`DECISION_LEDGER.md`).

## 4. Answering brief Key Product Questions 4 and 5

- **Q4 "What is an agent in Florina terminology?"** — Provider/runtime
  (existing usage, confirmed sufficient) + the new Agent Profile
  (role/system-prompt/tool-scope applied to a Task) + Session/Run (existing,
  unchanged). Three senses, two of which already have domain types; the
  third (profile) is the one scoped addition this research recommends.
- **Q5 "Are provider-native subagents first-class?"** — No. They are
  Managed only when Florina dispatched them (identical to any other Task),
  Observed (informational, non-authoritative) when a provider exposes
  read-only visibility into work it did not dispatch, and Opaque otherwise.
  Nothing outside the daemon's own dispatch path is ever first-class.

## 5. Non-goals of this research

This document does not specify wire-level adapter changes for the Observed
tier (that's implementation, out of scope for this milestone per brief §
30). It establishes the product-level classification so a future adapter
issue has a target to implement against.
