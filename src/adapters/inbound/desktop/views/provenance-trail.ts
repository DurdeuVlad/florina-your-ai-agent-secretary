/**
 * Provenance trail ("Prove it") component — reusable claim -> evidence
 * breadcrumb (docs/UX_FLOWS.md "Component concepts", issue #201).
 *
 * DEC-032 already gates task completion on verification evidence, but
 * that drill-down was special-cased to completion. This component is the
 * general version: any claim-bearing surface (a chat message, a card)
 * can resolve to its underlying journal evidence — claim -> journaled
 * event(s) -> adapter-reported fact -> optional raw payload — as a
 * linear breadcrumb. Purely a read-path projection over the existing
 * event journal (DEC-012); no new data model, no DOM, no framework —
 * same discipline as every other view module in this directory.
 *
 * Scope note (documented, not silently dropped): a grep of the desktop
 * renderer found no existing bespoke "verification section" in the
 * completion-digest views to refactor — `digest-view.ts`/
 * `digest-templates.ts` render `CompletionDigest`'s test/approval counts
 * directly and never surfaced `VerificationGate`'s separate `verified`
 * boolean at all. There is nothing to refactor onto this component yet;
 * wiring it into the digest view is a natural follow-up once that
 * surface exists, not a regression of prior behavior.
 */
import type { Event } from '../../../../core/domain/types.js';
import type { RenderTree } from './view-types.js';

function el(
  tag: string,
  props?: Record<string, unknown>,
  children?: readonly (RenderTree | string)[],
): RenderTree {
  return { tag, props, children };
}

/** The claim being made — what a user should be able to ask "prove it" about. */
export interface ProvenanceClaim {
  readonly text: string;
  readonly taskId: string;
}

/**
 * Render a single journal event's payload into a human-readable,
 * deterministic fact line — no LLM involved, same discipline as
 * `completion-digest.ts`'s summary fields.
 */
export function summarizeEvidence(event: Event): string {
  switch (event.kind) {
    case 'TestFinished': {
      const passed = event.payload['passed'];
      const failed = event.payload['failed'];
      return `${String(passed ?? '?')} passed, ${String(failed ?? '?')} failed`;
    }
    case 'VerificationObserved': {
      const kind = event.payload['kind'];
      const success = event.payload['success'];
      const summary = event.payload['summary'];
      return `${String(kind ?? 'check')}: ${success === true ? 'passed' : 'failed'}${summary ? ` — ${String(summary)}` : ''}`;
    }
    case 'AgentCompleted': {
      const summary = event.payload['summary'];
      return String(summary ?? 'completed');
    }
    case 'FileChanged': {
      const path = event.payload['path'];
      const changeType = event.payload['changeType'];
      return `${String(changeType ?? 'changed')}: ${String(path ?? '')}`;
    }
    default:
      return event.kind;
  }
}

/**
 * Build the claim -> event(s) -> fact -> (optional) raw payload
 * breadcrumb for a claim, given the journal events that back it
 * (typically `EventJournalPort.listByTask(claim.taskId)`, pre-filtered
 * by the caller to the relevant window/kinds — this function does not
 * itself decide relevance, matching #207's "selection vs. compilation"
 * split).
 */
export function buildProvenanceTrail(claim: ProvenanceClaim, evidence: readonly Event[]): RenderTree {
  const steps: RenderTree[] = [
    el('ProvenanceStep', { kind: 'claim' }, [claim.text]),
  ];

  if (evidence.length === 0) {
    steps.push(el('ProvenanceStep', { kind: 'unverified' }, ['No journaled evidence found for this claim.']));
    return el('ProvenanceTrail', { taskId: claim.taskId }, steps);
  }

  for (const event of evidence) {
    steps.push(
      el('ProvenanceStep', { kind: 'event', eventId: event.id, timestamp: event.timestamp }, [event.kind]),
      el('ProvenanceStep', { kind: 'fact' }, [summarizeEvidence(event)]),
    );
  }

  steps.push(
    el(
      'ProvenanceStep',
      { kind: 'transcript', command: `show-raw-events:${claim.taskId}` },
      ['View raw event payloads'],
    ),
  );

  return el('ProvenanceTrail', { taskId: claim.taskId }, steps);
}

/**
 * A "Prove it" affordance for a claim-bearing chat message — a small,
 * clickable node carrying the command to open {@link buildProvenanceTrail}
 * scoped to the message's task. Reuses the message's existing `taskId`
 * context rather than a new per-message claim-to-evidence link field
 * (no new data model, per #201's explicit constraint).
 */
export function renderProveItAffordance(taskId: string): RenderTree {
  return el('ProveIt', { command: `prove-it:${taskId}` }, ['Prove it']);
}
