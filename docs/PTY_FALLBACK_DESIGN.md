# PTY Fallback Adapter Design (DEC-023)

Status: **ACCEPTED** — see [DECISION_LEDGER.md](../DECISION_LEDGER.md) DEC-023.
Resolves: GitHub issue #13.
Depends on: #9 (Adapter base interface & fidelity tier contract, `src/adapters/base.ts`).

## Purpose

This document evaluates approaches for the **PTY fallback adapter** — the
**Tier E** adapter in the fidelity hierarchy (PRODUCT_DESIGN.md "Agent
Adapters", `src/domain/enums.ts` `AdapterFidelityTier.E`). Tier E is the
last-resort compatibility path for coding agents that expose neither a
structured API (Tier A), lifecycle hooks (Tier B), an ACP surface (Tier C),
nor a JSON CLI output mode (Tier D). The only observable surface is a
pseudo-terminal (PTY) stream of bytes.

The central problem: **how does the Secretary detect agent state —
especially permission requests — from an unstructured byte stream it does
not control?** This is inherently low-fidelity, and the design must specify
how to handle the **confidence gap**: the cases where the scraper cannot
reliably distinguish a real permission request from other terminal output.

This is a **design-only** issue. No PTY adapter is implemented in the MVP.
The recommendation (Section 5) defers implementation.

## Background & constraints

- **DEC-013**: MVP supports Codex (Tier A) and Claude Code (Tier B) only.
  A third agent is a documented _reconsideration trigger_, and the preferred
  path is a structured adapter (Tier C/D), not a PTY heuristic.
- **DEC-011**: The Secretary narrows permissions, never silently widens
  them. A low-confidence "this looks like a permission prompt" signal must
  never be treated as authorization to auto-approve.
- **DEC-010**: Approve the underlying capability, never an LLM summary.
  Structured adapter data is the trustworthy authorization basis. PTY
  output is, by definition, _not_ structured adapter data.
- **DEC-014**: The attention engine is deterministic in v1. Whatever the
  PTY adapter emits must be classifiable by rules, not by an LLM in the
  control loop.
- **Fidelity tier contract** (`src/adapters/base.ts`): Tier D–E adapters
  get **no auto-approval**. Every permission-like event requires human
  confirmation because the Secretary cannot reliably distinguish an actual
  permission request from other output.

## Approaches evaluated

Three approaches are evaluated against four dimensions:

1. **State detection** — how agent state is inferred from terminal output.
2. **Confidence-gap handling** — what happens when detection is uncertain.
3. **Attention-engine interaction** — how Tier E's no-auto-approve rule is
   enforced and how events surface to the human.
4. **Complexity, maintenance, reliability** — build/operational cost.

---

### Approach A — Generic regex matching on terminal output

Spawn the unsupported agent inside a PTY (`node-pty` or equivalent), read
the raw byte stream, strip ANSI escape sequences, and apply a library of
regular expressions to classify lines into `SupervisorEvent` candidates
(e.g. `ApprovalRequested`, `AgentCompleted`, `AgentFailed`).

#### State detection

- A curated set of regex patterns per _known_ agent CLI (e.g. patterns for
  Claude Code's `Do you want to allow...?`, Codex's `Approve? (y/n)`,
  generic `y/N` prompts).
- Line-oriented scanning with a rolling buffer to handle prompts that span
  line breaks and spinner/progress redraws.
- Best-effort extraction of structured fields (command, file path) from the
  matched line into the `ApprovalRequested` event payload.

#### Confidence-gap handling

- Every match carries a **confidence score** derived from pattern specificity
  (exact-string anchor > regex with captures > fuzzy keyword match).
- **Below a tunable threshold, the adapter does NOT emit `ApprovalRequested`.**
  Instead it emits a generic `AgentBlocked`-style event with the raw terminal
  snippet attached, classified as `AttentionCategory.RiskDetected` /
  `DecisionRequired`, and **always** routed to human confirmation.
- Because Tier E forbids auto-approve regardless, a high-confidence match
  and a low-confidence match converge on the **same outcome**: surface to
  the human. The confidence score only changes _how prominently_ the event
  is surfaced (priority), not _whether_ it can be auto-approved.
- False negatives (a real prompt that no pattern matches) are mitigated by a
  **liveness timeout** (DEC-014): if the PTY produces no new output for N
  seconds while the agent is expected to be working, emit an
  `AgentBlocked` event so the human inspects the terminal.

#### Attention-engine interaction

- Adapter declares `fidelityTier: AdapterFidelityTier.E`.
- The attention engine's auto-approve gate is **hard-disabled** for Tier E
  (enforced in the policy layer, not trusted to the adapter). Even if the
  adapter mistakenly emits `ApprovalRequested` with high confidence, the
  engine routes it to a human confirmation card — never to auto-approve.
- Approval cards for Tier E display the **raw terminal snippet** as the
  authorization basis (DEC-010: approve the underlying capability, never an
  LLM summary). The snippet is supplemental context; the human is approving
  the _observed prompt_, not a model's interpretation of it.

#### Complexity, maintenance, reliability

- **Complexity**: Moderate. PTY plumbing + ANSI stripping + a pattern
  registry + confidence scoring. No model dependency.
- **Maintenance burden**: **High and ongoing.** Every agent version that
  changes its prompt wording, colors, or layout can break patterns. Each
  new unsupported agent needs its own pattern set. This is the core
  fragility: the Secretary is reverse-engineering UI text that the agent
  author never promised to keep stable.
- **Reliability**: Low–medium. High false-positive risk on agents that
  print `y/n`-style text in their own output (test runners, interactive
  REPLs the agent drives). False negatives are bounded by the liveness
  timeout but still delay attention routing.
- **Verdict**: Pragmatic and dependency-free, but fragile. Acceptable only
  as a stopgap for one or two high-demand agents while a structured adapter
  is pursued.

---

### Approach B — PTY scrape with a vision model

Capture periodic **terminal screenshots** (rendered PTY state, or the actual
terminal emulator framebuffer) and feed them to a vision-capable LLM that
classifies the screen state: working / permission-prompt / completed /
failed, and extracts the prompt text and structured fields.

#### State detection

- A screenshot is taken on a cadence (e.g. every 1–2s) and on PTY-idle
  transitions (no new bytes for a short window — likely a prompt waiting).
- The vision model returns a structured classification plus extracted
  fields (prompt text, command, file path) which the adapter maps to
  `SupervisorEvent` candidates.
- Because the model sees rendered layout (not just byte stream), it can
  disambiguate prompts that regex would miss (boxed prompts, spinner
  states, color-coded warnings).

#### Confidence-gap handling

- The model returns a confidence score; low-confidence classifications are
  **downgraded to a generic `AgentBlocked` / `DecisionRequired` event** with
  the screenshot attached, routed to human confirmation.
- **Critical security constraint (DEC-011, DEC-010):** the vision model's
  verdict is _never_ an authorization basis. Tier E forbids auto-approve
  regardless of confidence. The model output is supplemental context for
  the human, not a permission decision. An LLM saying "this is a safe
  approval request" must not defeat the no-auto-approve rule.
- Cost/latency gating: screenshots are only sent to the model on idle
  transitions (candidate prompt) or on the liveness timeout, not on every
  byte — otherwise the per-run token cost and latency dominate.

#### Attention-engine interaction

- Same Tier E contract as Approach A: `fidelityTier: E`, auto-approve
  hard-disabled in the policy layer.
- Approval cards show the **screenshot** plus the model's extracted text as
  supplemental context. The human approves the observed prompt; the model
  interpretation is explicitly labeled as non-authoritative.
- Adds a non-deterministic component to event _generation_ (not the control
  loop). This is in tension with DEC-014 (deterministic attention engine):
  the engine stays rule-based, but its _input_ from a Tier E adapter is now
  model-derived. Debugging and audit (DEC-012) must record the screenshot
  and model output alongside the event so source events remain
  reconstructable.

#### Complexity, maintenance burden, reliability

- **Complexity**: High. PTY + screenshot rendering + vision-model client +
  prompt engineering + cost/latency management + screenshot storage for
  audit.
- **Maintenance burden**: Medium. More robust to prompt wording changes
  than regex (the model generalizes across phrasings), but introduces model
  versioning, prompt-drift, and cost drift as new maintenance surfaces.
- **Reliability**: Medium–high for _classification_ (better than regex on
  novel layouts), but **lower for trust**: a vision model can hallucinate a
  permission prompt that isn't there, or miss one that is. Hallucinated
  prompts are bounded by the no-auto-approve rule (they just create a
  spurious human confirmation — annoying, not dangerous). Missed prompts
  are bounded by the liveness timeout.
- **Cost/latency**: Per-screenshot model calls add latency and API cost to
  every Tier E run. This directly works against the product thesis
  (attention _compression_) if it generates noisy confirmation cards.
- **Verdict**: More robust detection than regex, but at high complexity and
  cost, and it imports a non-deterministic, non-auditable-by-construction
  component into event generation. Over-engineered for a last-resort path.

---

### Approach C — Omit PTY fallback entirely in early versions (recommendation)

Do not implement a PTY fallback adapter in the MVP or near-term. Unsupported
agents are simply not supervised by the Secretary until they get a
structured adapter (Tier A–D). The `AdapterFidelityTier.E` enum value and
the Tier E contract (no auto-approve) remain **defined** in
`src/domain/enums.ts` and `src/adapters/base.ts` so the attention engine
and policy layer are forward-compatible, but **no concrete Tier E adapter
is shipped.**

#### State detection

- N/A — no PTY scraping in early versions. Unsupported agents run outside
  the Secretary (the user runs them in a normal terminal; the Secretary
  does not observe them).

#### Confidence-gap handling

- The confidence gap is **eliminated by not attempting detection.** There is
  no scraper to be uncertain. This is the strongest possible
  confidence-gap strategy: refuse to claim knowledge you don't have.
- The Tier E contract is preserved in code so that _if_ a PTY adapter is
  ever added later, the no-auto-approve rule is already enforced and cannot
  be accidentally bypassed by a new adapter forgetting to opt out.

#### Attention-engine interaction

- No Tier E events are generated, so there is no auto-approve surface to
  misfire. The attention engine's Tier E branch exists but is unreached.
- The product message is honest: the Secretary supervises agents it can
  _trustfully observe_ (Tier A–D). It does not pretend to supervise agents
  it can only guess at.

#### Complexity, maintenance burden, reliability

- **Complexity**: Zero (for the adapter). Only the enum value and contract
  documentation are carried, which already exist.
- **Maintenance burden**: Zero.
- **Reliability**: N/A — no false positives or negatives because no
  detection is attempted.
- **Verdict**: Aligns with DEC-013 (MVP = Codex + Claude Code), DEC-011
  (never silently widen permissions — refusing to guess is the conservative
  choice), and the product thesis (attention compression requires
  _trustworthy_ event sources; a noisy guesser hurts ACR).

---

## Recommendation

**Adopt Approach C: omit the PTY fallback adapter in early versions.**

### Rationale

1. **Aligns with DEC-013.** The MVP deliberately supports only Codex (Tier A)
   and Claude Code (Tier B) — the two agents with the strongest structured
   supervision surfaces. A PTY fallback exists for agents _beyond_ MVP scope.
   Building it now is premature.

2. **Aligns with DEC-011.** The Secretary narrows permissions, never
   silently widens them. A PTY scraper that guesses at permission prompts
   from unstructured text is, by construction, a low-trust signal. Refusing
   to supervise agents it cannot reliably observe is the conservative,
   permission-narrowing choice. The Tier E no-auto-approve contract is the
   safety net _if_ a PTY adapter is ever added — but the safest net is not
   building the tightrope in the first place.

3. **Protects the product thesis (DEC-015, Attention Compression Ratio).**
   ACR improves when the Secretary reliably suppresses non-attention-worthy
   events and reliably surfaces real ones. A fragile scraper (Approach A)
   or a hallucination-prone vision classifier (Approach B) generates
   false-positive confirmation cards and missed prompts — both _worsen_ ACR
   by increasing human interruptions without trustworthy compression.

4. **Avoids non-determinism in event generation (DEC-014).** Approach B
   imports a vision model into the event-generation path, creating a
   non-deterministic input to an otherwise deterministic attention engine
   and complicating audit (DEC-012). Approach A is deterministic but
   fragile. Approach C avoids both.

5. **Forward-compatible.** `AdapterFidelityTier.E` and the Tier E contract
   (no auto-approve, human confirmation required) are already defined in
   `src/domain/enums.ts` and `src/adapters/base.ts`. If a high-demand agent
   emerges that has no structured surface, a PTY adapter can be added later
   under the already-enforced contract — with Approach A (regex) as the
   preferred interim over Approach B, because it keeps event generation
   deterministic and audit-friendly.

### When to reconsider

Per DEC-013's reconsideration trigger: if a third agent achieves significant
adoption, **first pursue a structured adapter** (ACP-native Tier C, or JSON
CLI Tier D). Only fall back to a PTY heuristic (Tier E) if no structured
surface exists _and_ demand justifies the maintenance burden. At that point:

- Prefer **Approach A (regex)** as the interim — deterministic, auditable,
  no model cost.
- Reserve **Approach B (vision)** for agents whose prompts are graphical
  enough that regex is hopeless, and accept the cost/audit tradeoff
  explicitly.

## Summary table

| Dimension               | A: Regex                                                     | B: Vision                                                                                    | C: Omit (recommended)    |
| ----------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ------------------------ |
| State detection         | Regex on stripped PTY stream                                 | Vision model on screenshots                                                                  | N/A (no detection)       |
| Confidence-gap handling | Scored; low-confidence → generic blocked event, always human | Scored; low-confidence → generic blocked event, always human; model verdict never authorizes | Eliminated — no guessing |
| Auto-approve            | Hard-disabled (Tier E)                                       | Hard-disabled (Tier E)                                                                       | N/A                      |
| Complexity              | Moderate                                                     | High                                                                                         | Zero                     |
| Maintenance             | High (per-agent patterns, version drift)                     | Medium (model/prompt drift, cost)                                                            | Zero                     |
| Reliability             | Low–medium (false positives/negatives)                       | Medium (hallucination risk)                                                                  | N/A                      |
| Determinism (DEC-014)   | Deterministic                                                | Non-deterministic input                                                                      | N/A                      |
| MVP fit                 | Premature                                                    | Over-engineered                                                                              | Aligned (DEC-013)        |

## References

- DEC-013 — MVP supports Codex and Claude Code only.
- DEC-011 — The Secretary narrows permissions, never silently widens them.
- DEC-010 — Approve the underlying capability, never an LLM summary.
- DEC-014 — Attention engine is initially deterministic.
- DEC-015 — North-star metric is Attention Compression Ratio.
- DEC-012 — Event journal is truth; LLM summaries are projections.
- PRODUCT_DESIGN.md — "Agent Adapters" (fidelity tiers A–E, Tier D–E no
  auto-approval).
- `src/adapters/base.ts` — `AgentAdapter` interface, `BaseAdapter`, Tier E
  contract.
- `src/domain/enums.ts` — `AdapterFidelityTier.E`.
