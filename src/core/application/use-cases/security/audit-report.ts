/**
 * Security audit report types.
 *
 * Defines the structured shape of a {@link SecurityAuditReport} — the output
 * of running the security auditors (see `auditors.ts`) over a codebase. The
 * report is a list of {@link SecurityFinding} entries plus a human-readable
 * summary and an overall risk rating.
 *
 * Related decisions:
 * - DEC-010: Approve the underlying capability, never an LLM summary.
 * - DEC-011: Florina narrows permissions, never silently widens them.
 * - DEC-022: Credential/secret brokering model (capability broker pattern).
 */

/**
 * Severity of a security finding, ordered from most to least severe.
 *
 * The string values are deliberately stable so reports can be serialized and
 * compared across runs.
 */
export type Severity = 'Critical' | 'High' | 'Medium' | 'Low';

/**
 * The security domain a finding belongs to.
 */
export type SecurityCategory =
  | 'Authentication'
  | 'Authorization'
  | 'Injection'
  | 'DataExposure'
  | 'ProcessSandboxing'
  | 'SecretManagement'
  | 'NetworkSecurity'
  | 'InputValidation';

/**
 * Lifecycle status of a finding.
 *
 * - `Open` — the issue has been detected but not yet addressed.
 * - `Fixed` — the issue has been remediated.
 * - `Accepted` — the issue has been reviewed and the risk accepted.
 */
export type FindingStatus = 'Open' | 'Fixed' | 'Accepted';

/**
 * A single security finding produced by an auditor.
 */
export interface SecurityFinding {
  /** Stable identifier, e.g. `process-spawning/shell-true:src/foo.ts:42`. */
  id: string;
  /** Severity of the finding. */
  severity: Severity;
  /** Security domain the finding belongs to. */
  category: SecurityCategory;
  /** Human-readable description of the issue. */
  description: string;
  /** Source location as `file:line` (or `file` when the line is unknown). */
  location: string;
  /** Recommended remediation. */
  recommendation: string;
  /** Lifecycle status of the finding. */
  status: FindingStatus;
}

/**
 * Overall risk rating for an audited codebase, derived from the highest
 * severity of any open finding.
 */
export type OverallRisk = 'Critical' | 'High' | 'Medium' | 'Low' | 'None';

/**
 * A structured security audit report.
 */
export interface SecurityAuditReport {
  /** All findings, across every auditor that was run. */
  findings: SecurityFinding[];
  /** Human-readable summary of the audit. */
  summary: string;
  /** ISO-8601 timestamp the report was generated. */
  timestamp: string;
  /** Overall risk rating, derived from the open findings. */
  overallRisk: OverallRisk;
}

/**
 * Severity rank used for comparison and risk derivation. Higher number ==
 * more severe.
 */
export const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  Critical: 4,
  High: 3,
  Medium: 2,
  Low: 1,
};

/**
 * Derive the overall risk for a set of findings from the highest-severity
 * *open* finding. Findings that have been `Fixed` or `Accepted` do not raise
 * the overall risk.
 */
export function deriveOverallRisk(findings: readonly SecurityFinding[]): OverallRisk {
  let highest: OverallRisk = 'None';
  let highestRank = 0;
  for (const finding of findings) {
    if (finding.status !== 'Open') continue;
    const rank = SEVERITY_RANK[finding.severity];
    if (rank > highestRank) {
      highestRank = rank;
      highest = finding.severity;
    }
  }
  return highest;
}

/**
 * Build a short human-readable summary for a set of findings.
 */
export function buildSummary(findings: readonly SecurityFinding[]): string {
  const open = findings.filter((f) => f.status === 'Open');
  if (open.length === 0) {
    return `Audit complete: 0 open findings (of ${findings.length} total).`;
  }
  const bySeverity: Record<Severity, number> = {
    Critical: 0,
    High: 0,
    Medium: 0,
    Low: 0,
  };
  for (const f of open) bySeverity[f.severity]++;
  const parts: string[] = [];
  (['Critical', 'High', 'Medium', 'Low'] as Severity[]).forEach((sev) => {
    if (bySeverity[sev] > 0) parts.push(`${bySeverity[sev]} ${sev}`);
  });
  return `Audit complete: ${open.length} open finding(s) (${parts.join(', ')}) of ${findings.length} total.`;
}
