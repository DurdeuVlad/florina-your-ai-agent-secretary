# Agent / System Flows (Mermaid)

Machine-side sequence and flow diagrams for brief § 16. Companion to
`docs/UX_FLOWS.md` (human-facing) and `docs/RULES_MEMORY_AND_SUPERVISION.md`
(mechanism detail behind each box).

## 1. Intent -> rule resolution -> execution brief -> delegation

```mermaid
flowchart LR
    A[User request] --> B[Tag-match candidate rules]
    B --> C[Scope filter: global + this project]
    C --> D[Deterministic conflict resolution]
    D --> E[Union hard policies]
    E --> F[Compile Execution Brief]
    F --> G[CapacityRouter selects provider]
    G --> H[florina_spawn_task]
    H --> I[Manager / Worker receives Brief]
```

## 2. Florina -> project manager -> worker delegation hierarchy

```mermaid
flowchart TD
    U[Vlad] --> F[Florina: user model, global rules, priorities]
    F --> M1[Manager: project A]
    F --> M2[Manager: project B]
    M1 --> W1[Worker / Session]
    M1 --> W2[Worker / Session]
    M2 --> W3[Worker / Session]
```

## 3. Worker event -> deterministic supervision -> reasoning escalation

```mermaid
flowchart LR
    E[Worker emits SupervisorEvent] --> L0{L0 deterministic classify}
    L0 -->|normal| J[Journal only]
    L0 -->|ambiguous| L1{L1 cheap classification}
    L1 -->|routine| J
    L1 -->|anomaly| L2[Manager reasoning]
    L2 -->|resolved in scope| J
    L2 -->|needs cross-project view| L3[Florina reasoning]
    L3 -->|resolved silently, journaled| J
    L3 -->|genuine judgment needed| L4[Attention Item -> Human]
```

## 4. Worker question -> manager -> Florina -> human escalation

```mermaid
sequenceDiagram
    participant W as Worker
    participant M as Manager
    participant Fl as Florina
    participant U as User
    W->>M: blocked, needs input
    M->>M: check project capsule / policy
    alt resolvable in project scope
        M-->>W: answer, unblock
    else needs cross-project / global judgment
        M->>Fl: escalate
        Fl->>Fl: check user memory/grants (DEC-031)
        alt resolvable silently
            Fl-->>M: answer, journaled
            M-->>W: unblock
        else genuine ambiguity
            Fl->>U: Attention Item (Decision)
            U->>Fl: answer
            Fl-->>M: answer, journaled
            M-->>W: unblock
        end
    end
```

## 5. Completion claim -> verification -> accepted/rejected completion

```mermaid
flowchart TD
    C[Worker claims done] --> V{Verification evidence attached?}
    V -->|no| R[Route back: verification objective]
    R --> C
    V -->|yes| D[Manager compiles Completion Digest]
    D --> A[Attention: ready for review]
    A --> H{Human reviews}
    H -->|accept| Done[Deliverable accepted]
    H -->|changes requested| F[New follow-up Task]
    H -->|send back| R
```

## 6. Provider failure/quota exhaustion -> rerouting/failover

```mermaid
flowchart LR
    Q[QuotaLedger: exhaustion detected] --> P{Preferred provider with capacity?}
    P -->|yes| S[Freeze session]
    S --> T[Resume Task in same worktree, primed from Task Capsule]
    T --> N[New provider session]
    N --> J1[Journal: provider transition, both providers named]
    P -->|no| K[Park task]
    K --> W[Schedule resume at earliest resets_at]
```

## 7. User correction -> memory extraction -> candidate/learned rule

```mermaid
flowchart TD
    C1[User correction, turn 1] --> Cand[Candidate rule, provenance=inferred-single]
    C1b[User correction, turn 2, same direction] --> Prop[Proposed rule, provenance=inferred-repeated]
    Prop --> Ask{Next time rule would apply}
    Ask --> Confirm[Florina asks once: make this standing?]
    Confirm -->|yes| Active[Active rule]
    Confirm -->|no / narrow| Narrowed[Active, narrower scope, or declined]
    Cand -->|never repeats| Stale[Stays candidate, never applied]
```

## 8. Rule retrieval/resolution/conflict handling

```mermaid
flowchart TD
    Req[Request + topic tags] --> Match[Tag-match memory store]
    Match --> Scope[Scope filter: global + project]
    Scope --> Rank[Rank: hard policy > explicit > inferred-repeated-confirmed > project-over-global > recency]
    Rank --> Conf{Unresolved topic conflict?}
    Conf -->|yes| Hold[Mark conflict, surface as Decision next relevant turn]
    Conf -->|no| Brief[Included in Execution Brief]
```

## 9. Return-from-inactivity -> state reconstruction -> catch-up digest

```mermaid
sequenceDiagram
    participant U as User
    participant Fl as Florina
    participant J as Event Journal
    U->>Fl: opens app / "catch me up"
    Fl->>J: query since last_active_at
    J-->>Fl: completed, running, attention-pending, failovers
    Fl->>Fl: compile digest (deterministic facts first, narrative layered on top)
    Fl->>U: digest rendered in thread, each line drill-down capable
    U->>Fl: (delivery confirmed)
    Fl->>Fl: advance last_active_at watermark
```

## 10. User asks "why?" -> provenance/evidence reconstruction

```mermaid
flowchart LR
    Q["Why did you send this to Gemini?"] --> Lookup[Load Task's Execution Brief]
    Lookup --> Show[Render provider/worker rationale field]
    Q2["Prove it"] --> Chain[Claim -> journaled event -> adapter fact -> raw transcript]
    Chain --> Render[Provenance trail, linear breadcrumb]
```

## 11. Native provider subagent discovered/managed/opaque flow

```mermaid
flowchart TD
    Ev[Adapter reports activity] --> Disp{Did Florina dispatch it?}
    Disp -->|yes, via florina_spawn_task| Managed[Managed: full journal/policy/quota]
    Disp -->|no, but provider exposes read visibility| Observed[Observed: display-only, never auto-approved, excluded from quota]
    Disp -->|no visibility exposed| Opaque[Opaque: not represented]
```

## 12. Project context + global context merging

```mermaid
flowchart LR
    G[User-scope capsule: global rules, preferences, facts] --> Merge
    P[Project-scope capsule: project rules, repo knowledge] --> Merge
    Merge[Execution Brief compiler] --> Out[Compiled Brief: project rules win ties on shared topic]
```
