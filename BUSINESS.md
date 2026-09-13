# Florina: Business Case

## Problem

As coding agents become capable of handling meaningful implementation tasks independently, the primary constraint on development speed has shifted from agent capability to human supervision capacity. When a developer runs 3-5+ concurrent coding agent sessions, they spend more time managing agents than doing productive work. 

The core issue is that execution can be parallelized, but human attention cannot. Developers face a severe bottleneck: watching token streams, switching terminal tabs, reading long agent conversations, repeatedly asking for status, remembering what each agent is doing, reviewing raw diffs before knowing if they matter, tracking which agent needs approval, deciding which deliverable deserves attention next, and mentally maintaining context across unrelated projects. 

OpenAI's Symphony work independently validated this phenomenon: once coding work was parallelized across multiple agents, engineers became constrained by context switching rather than agent capability. The bottleneck is human attention, not agent intelligence.

## Target User

The target user is an early adopter developer who:
- Uses coding agents heavily (Codex, Claude Code, etc.)
- Runs several sessions in parallel (3-5+)
- Works across multiple repositories or worktrees
- Is comfortable delegating meaningful implementation tasks
- Feels that supervising agents is becoming a full-time activity

## Current Workflow

Without Florina, the current workflow is fragmented and manual:
- Managing numerous terminal tabs, IDE windows, and agent session switching
- Manually checking Git and reading raw diffs to understand progress
- Mentally remembering the state and context of each agent
- Checking PRs and waiting on approvals
- Repeatedly polling sessions for status updates
- Paying a heavy context-switching tax between unrelated projects

## Pain

The cognitive cost of this fragmented workflow includes:
- Severe context switching tax
- High status tracking overhead
- An interruption-driven workflow
- Monitoring fatigue and agent babysitting
- Losing track of parallel work
- Reviewing execution details rather than evaluating outcomes

The critical insight is that *agent state is not the same as attention state*. An agent may be running but deserve attention (e.g., repeated test failures), or waiting but not urgent (e.g., a question answerable by a project policy). 

## Value Proposition

Florina moves the developer from supervising conversations and processes to supervising work, outcomes, and decisions.

The core concept: An open-source attention broker for coding agents: one inbox that lets developers delegate work, monitors heterogeneous agent sessions, suppresses routine noise, and interrupts only when a human decision is genuinely needed.

Mental models:
- The control room for your coding agents
- An attention router above coding agents
- supervisord for coding agents + an intelligent inbox

## High-Level Product Flows

### Delegate Work
The user asks the Florina to assign or start work. The Florina selects or is told which agent/session/provider should perform it. The work becomes a tracked Task.

### Ongoing Supervision
The agent works independently. The Florina consumes events without constantly interrupting the developer. Most activity is batched.

### Attention Request
Something genuinely requiring the user occurs. The Florina interrupts or surfaces it as an Attention Item with enough context to decide.

### Completion
The agent finishes. The Florina summarizes the Deliverable rather than replaying the session. It produces an executive digest with observed facts (files, tests, diff stats) and model-inferred insights (risk hotspots, behavior changes).

### Review
The user asks questions about the result, diff, tests, trade-offs, and risks. Relevant Task context is loaded from the Context Capsule.

### Approval or Continuation
The user provides Approval, rejects, redirects, asks for changes, or delegates a follow-up Task.

## Business Differentiation

Florina is uniquely positioned because it is NOT:
- Another coding agent: it doesn't write code; it supervises agents that do.
- Another agent framework: it doesn't orchestrate agent reasoning; it supervises independent agent runtimes.
- Another terminal multiplexer: it adds semantic understanding and attention routing, not just tab management.
- Another task manager / Kanban: the home screen is an attention inbox, not a board (dashboards are not the wedge).
- Another PR reviewer: dedicated tools like Open Code Review exist; PR review is a feature here, not the product.
- Another voice assistant: voice is the interaction surface; the attention model is the core product.
- Another generic multi-agent system: it works WITH existing coding agents through adapters, it doesn't replace them.

The defensible center is the cross-agent event model, universal approval model, attention policy engine, evidence-backed work digest, and secure voice/remote decision interface.

## Validation Assumptions

For Florina to succeed, the following assumptions must hold true:
- Developers run enough concurrent agents to create an attention bottleneck
- They prefer a supervisory layer to individually interacting with every agent
- Deliverable-first summaries are sufficient for most routine supervision
- Voice materially improves supervisory throughput
- Users trust a system that mediates between them and coding agents
- Context isolation can be made reliable enough for many simultaneous projects
- Structured agent protocols (ACP, Codex app-server, Claude hooks) provide sufficient supervision surface
- An attention model can correctly distinguish what needs a human from what doesn't

## MVP Success Criteria

Success is measured by behavioral changes:
- User successfully supervises several simultaneous agent tasks through the Florina
- User can identify everything requiring attention without opening individual sessions
- The majority of routine task supervision occurs through Florina summaries rather than terminal inspection
- User can move between unrelated projects without contextual contamination
- User voluntarily returns to the Florina instead of reverting to agent terminals

**North-star metric:** Attention Compression Ratio (ACR) = total classifiable agent events processed by the attention engine / actual human interruptions surfaced

**Supplemental metrics:** 
- Human interventions per agent-hour
- Mean blocked time awaiting developer
- Completion-to-review latency
- Minutes of human review per completed task
- Percentage of attention items resolved without opening agent terminal
- False-negative attention rate
- False-positive interruption rate
- Incorrect approval representation rate (security-critical, must be ~zero)
