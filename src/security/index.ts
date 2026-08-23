/**
 * Security module public entrypoint.
 *
 * Re-exports the audit-report types, the {@link SecurityAuditor}, and the
 * hardening utilities so consumers can import everything from
 * `../security/index.js`.
 */

export {
  type SecurityAuditReport,
  type SecurityFinding,
  type Severity,
  type SecurityCategory,
  type FindingStatus,
  type OverallRisk,
  SEVERITY_RANK,
  deriveOverallRisk,
  buildSummary,
} from './audit-report.js';

export { SecurityAuditor } from './auditors.js';

export {
  validateLocalhostOnly,
  sanitizeProcessInput,
  redactSecret,
  validateApiKeyFormat,
  assertNoSecretsInLogs,
  SECRET_PATTERNS,
  SecretsInLogsError,
} from './hardening.js';
