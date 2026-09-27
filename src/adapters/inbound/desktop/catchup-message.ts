/**
 * Format a catch-up digest as a chat message (issue #260, DEC-042 §9).
 * The desktop renders the digest as an ordinary journaled assistant
 * message — plain text, no special UI — so this formatter is the whole
 * presentation layer. Content mirrors `formatCatchUp` (CLI) in substance:
 * N notable / M running / K pending, one line per item.
 */
import type { CatchUpDigest } from '../../../core/application/use-cases/resumption/catchup-digest.js';
import type { ISODateString } from '../../../core/domain/types.js';

/** Compact human duration: "45m", "3h", "2d". */
function awaySpan(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 1)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * "after 3h away" qualifier — omitted when `since` is the epoch fallback
 * (no stored watermark, first-ever catch-up) or unparseable.
 */
function awayQualifier(since: ISODateString, until: ISODateString): string {
  const start = Date.parse(since);
  const end = Date.parse(until);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return '';
  if (start === Date.parse(new Date(0).toISOString())) return '';
  return ` · after ${awaySpan(end - start)} away`;
}

/** Format the digest as the body of a Secretary chat message. */
export function formatCatchUpMessage(digest: CatchUpDigest): string {
  const header = `catch-up${awayQualifier(digest.since, digest.until)}`;
  if (digest.isEmpty) {
    return `${header}\n\nnothing needs you — quiet while you were away`;
  }

  const lines: string[] = [
    header,
    '',
    `${digest.notable.length} notable · ${digest.stillRunning.length} still running · ` +
      `${digest.pendingAttention.length} need your attention`,
  ];

  if (digest.notable.length > 0) {
    lines.push('', 'notable:');
    for (const t of digest.notable) {
      lines.push(`  · [${t.state}] ${t.objective} (${t.taskId})`);
    }
  }

  if (digest.stillRunning.length > 0) {
    lines.push('', 'still running:');
    for (const t of digest.stillRunning) {
      lines.push(`  · ${t.objective} (${t.taskId})`);
    }
  }

  if (digest.pendingAttention.length > 0) {
    lines.push('', 'needs your decision:');
    for (const item of digest.pendingAttention) {
      lines.push(`  · [${item.priority}] ${item.kind} — ${item.taskId}`);
    }
  }

  if (digest.failovers.length > 0) {
    lines.push('', 'provider failovers:');
    for (const f of digest.failovers) {
      lines.push(`  · ${f.taskId}: ${f.fromProvider} → ${f.toProvider} (${f.reason})`);
    }
  }

  lines.push('', 'nothing else needs you');
  return lines.join('\n');
}
