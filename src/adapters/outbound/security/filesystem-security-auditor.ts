/**
 * Security auditors.
 *
 * {@link SecurityAuditor} scans a codebase (a directory of TypeScript source
 * files) for common security issues and returns structured
 * {@link SecurityFinding} entries. Each auditor focuses on one security
 * domain; {@link SecurityAuditor.auditAll} runs every auditor and assembles a
 * full {@link SecurityAuditReport}.
 *
 * The auditors are intentionally conservative: they flag *potential* issues
 * based on source patterns, and each finding includes a concrete `file:line`
 * location and a remediation recommendation so a human can triage quickly.
 *
 * Related decisions:
 * - DEC-010: Approve the underlying capability, never an LLM summary.
 * - DEC-011: Florina narrows permissions, never silently widens them.
 * - DEC-022: Credential/secret brokering model.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

import {
  buildSummary,
  deriveOverallRisk,
  type SecurityAuditReport,
  type SecurityCategory,
  type SecurityFinding,
} from '../../../core/application/use-cases/security/audit-report.js';

/**
 * A single source file loaded by the auditor, with its absolute path and
 * split lines (1-indexed via index + 1).
 */
interface SourceFile {
  /** Absolute path of the file. */
  path: string;
  /** Path relative to the audit root, used in finding locations. */
  relativePath: string;
  /** Raw file contents. */
  content: string;
  /** Lines of the file (no trailing newlines). */
  lines: string[];
}

/**
 * Scans a codebase for common security issues.
 *
 * Construct with the root directory to audit (typically the `src/` directory)
 * and call {@link auditAll} (or individual auditors) to obtain findings.
 */
export class SecurityAuditor {
  private readonly files: SourceFile[];

  /**
   * @param root Absolute path of the directory to audit. The directory is
   *   walked recursively for `.ts` files at construction time.
   */
  constructor(root: string) {
    this.files = collectSourceFiles(root);
  }

  /** Number of source files discovered during the walk. */
  get fileCount(): number {
    return this.files.length;
  }

  /**
   * Run every auditor and assemble a full {@link SecurityAuditReport}.
   */
  auditAll(): SecurityAuditReport {
    const findings: SecurityFinding[] = [
      ...this.auditProcessSpawning(),
      ...this.auditSecretHandling(),
      ...this.auditNetworkSurface(),
      ...this.auditInputValidation(),
      ...this.auditPermissionModel(),
    ];
    const timestamp = new Date().toISOString();
    return {
      findings,
      summary: buildSummary(findings),
      timestamp,
      overallRisk: deriveOverallRisk(findings),
    };
  }

  /**
   * Audit for unsafe child-process spawning.
   *
   * Flags:
   * - `shell: true` in spawn/exec options (Critical) — enables shell
   *   metacharacter injection.
   * - `execSync`/`exec` calls that interpolate variables into the command
   *   string without an adjacent `shellQuote`/`sanitize` call (High).
   */
  auditProcessSpawning(): SecurityFinding[] {
    const findings: SecurityFinding[] = [];
    const shellTrueRe = /shell\s*:\s*true/;
    // exec/execSync/spawn with a template-literal command that interpolates.
    const execInterpRe = /(?:exec|execSync|spawn)\s*\(\s*`[^`]*\$\{/;

    for (const file of this.files) {
      if (isSecurityModule(file)) continue;
      file.lines.forEach((line, idx) => {
        const lineNo = idx + 1;
        if (shellTrueRe.test(line)) {
          findings.push(
            this.finding(
              'process-shell-true',
              'Critical',
              'ProcessSandboxing',
              file,
              lineNo,
              '`shell: true` enables shell metacharacter injection; pass arguments as an array with `shell: false` instead.',
              'Avoid `shell: true`. Pass arguments as an array and set `shell: false`.',
            ),
          );
        }
        if (execInterpRe.test(line) && !/shellQuote|sanitize|quote/.test(line)) {
          findings.push(
            this.finding(
              'process-unquoted-interpolation',
              'High',
              'Injection',
              file,
              lineNo,
              'Child-process command interpolates a variable without shell-quoting; this can allow argument injection.',
              'Quote/escape interpolated arguments (e.g. via `shellQuote` or `sanitizeProcessInput`) or pass an argument array.',
            ),
          );
        }
      });
    }
    return findings;
  }

  /**
   * Audit for hardcoded secrets and secret leakage.
   *
   * Flags:
   * - OpenAI-style API keys (`sk-...`) appearing in source (Critical).
   * - GitHub tokens (`ghp_...` etc.) in source (Critical).
   * - Logging statements that reference variables named like secrets
   *   (`token`, `secret`, `apiKey`, `password`, `credential`) (High).
   */
  auditSecretHandling(): SecurityFinding[] {
    const findings: SecurityFinding[] = [];
    const apiKeyRe = /\bsk-[A-Za-z0-9_-]{20,}\b/;
    const githubTokenRe = /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/;
    // Logging of a likely-secret variable name.
    const secretLogRe =
      /(?:console\.(log|error|warn|info|debug)|logger\.(log|info|warn|error|debug))\s*\([^)]*\b(?:token|secret|apiKey|api_key|password|passwd|credential)\b/i;

    for (const file of this.files) {
      // Skip the security module itself — it legitimately references these
      // patterns in detection logic and tests.
      if (isSecurityModule(file)) continue;

      file.lines.forEach((line, idx) => {
        const lineNo = idx + 1;
        if (apiKeyRe.test(line)) {
          findings.push(
            this.finding(
              'secret-hardcoded-apikey',
              'Critical',
              'SecretManagement',
              file,
              lineNo,
              'Hardcoded OpenAI API key (`sk-...`) detected in source.',
              'Move the key to an environment variable or the credential vault (DEC-022); never commit secrets to source.',
            ),
          );
        }
        if (githubTokenRe.test(line)) {
          findings.push(
            this.finding(
              'secret-hardcoded-github-token',
              'Critical',
              'SecretManagement',
              file,
              lineNo,
              'Hardcoded GitHub token detected in source.',
              'Move the token to the credential vault (DEC-022); never commit secrets to source.',
            ),
          );
        }
        if (secretLogRe.test(line)) {
          findings.push(
            this.finding(
              'secret-leaked-in-log',
              'High',
              'DataExposure',
              file,
              lineNo,
              'Logging statement references a likely-secret variable; secrets must never be written to logs.',
              'Redact the value with `redactSecret` before logging, or avoid logging it entirely.',
            ),
          );
        }
      });
    }
    return findings;
  }

  /**
   * Audit the network surface.
   *
   * Flags:
   * - `WebSocketServer` / `listen()` bound to a non-localhost host (High).
   * - Bindings to `0.0.0.0` or `::` (High) — these expose the control plane
   *   to the network, violating the localhost-only invariant.
   */
  auditNetworkSurface(): SecurityFinding[] {
    const findings: SecurityFinding[] = [];
    // A host option that is not localhost.
    const hostOptionRe = /host\s*:\s*['"]([^'"]+)['"]/;
    // A bare 0.0.0.0 / :: binding. The `*` wildcard is only flagged when it
    // appears in a `host`/`hostname`/`bind`/`listen` option context — not in
    // unrelated matcher/glob patterns (e.g. Claude Code hooks `matcher: '*'`).
    const exposedHostRe = /['"](?:0\.0\.0\.0|::)['"]/;
    const wildcardHostRe = /(?:host|hostname|bind|listen)\s*:\s*['"]\*['"]/;

    for (const file of this.files) {
      file.lines.forEach((line, idx) => {
        const lineNo = idx + 1;
        const hostMatch = hostOptionRe.exec(line);
        if (hostMatch) {
          const host = hostMatch[1];
          if (!isLocalhostHost(host)) {
            findings.push(
              this.finding(
                'network-non-localhost-bind',
                'High',
                'NetworkSecurity',
                file,
                lineNo,
                `Network server bound to non-localhost host '${host}'; the control plane must be localhost-only.`,
                'Bind to `127.0.0.1` (or `localhost`) only. The daemon must never be exposed to the network in the MVP.',
              ),
            );
          }
        }
        if (exposedHostRe.test(line) || wildcardHostRe.test(line)) {
          findings.push(
            this.finding(
              'network-exposed-bind',
              'High',
              'NetworkSecurity',
              file,
              lineNo,
              'Network server bound to a wildcard address (`0.0.0.0` / `::`); this exposes the control plane to all network interfaces.',
              'Bind to `127.0.0.1` only.',
            ),
          );
        }
      });
    }
    return findings;
  }

  /**
   * Audit for unvalidated external input.
   *
   * Flags:
   * - Use of `process.argv` without an obvious validation/parsing helper
   *   (Medium) — raw argv values should be parsed/validated before use.
   * - `JSON.parse` of external-looking data (`process.env`, `readFileSync`)
   *   without a schema check (Medium).
   *
   * This is necessarily heuristic; the goal is to surface candidates for
   * human review, not to prove absence of input-validation bugs.
   */
  auditInputValidation(): SecurityFinding[] {
    const findings: SecurityFinding[] = [];
    const rawArgvRe = /process\.argv\[/;
    const jsonParseEnvRe = /JSON\.parse\s*\(\s*(?:process\.env|readFileSync)/;

    for (const file of this.files) {
      file.lines.forEach((line, idx) => {
        const lineNo = idx + 1;
        if (rawArgvRe.test(line) && !/parse|validate|schema|zod|joi/.test(line)) {
          findings.push(
            this.finding(
              'input-unvalidated-argv',
              'Medium',
              'InputValidation',
              file,
              lineNo,
              'Direct indexing of `process.argv` without an obvious validation/parse step; raw CLI input should be validated before use.',
              'Parse and validate argv through a dedicated CLI argument parser before use.',
            ),
          );
        }
        if (jsonParseEnvRe.test(line)) {
          findings.push(
            this.finding(
              'input-unvalidated-json-parse',
              'Medium',
              'InputValidation',
              file,
              lineNo,
              '`JSON.parse` of external data without a schema check; malformed or hostile input can crash or confuse the process.',
              'Validate the parsed structure against an expected schema before use.',
            ),
          );
        }
      });
    }
    return findings;
  }

  /**
   * Audit for DEC-011 compliance: Florina must narrow permissions, never
   * silently widen them.
   *
   * Flags:
   * - Code that appears to *widen* or *expand* permissions without an
   *   approval gate (High) — e.g. `widen`, `expand`, `escalate` near
   *   `permission`/`capability` without `approve`/`approval`.
   * - Use of an LLM risk assessment as the authorization basis (High) —
   *   e.g. `llmSafe`, `modelSaysSafe`, `aiApproved` gating a permission grant.
   *
   * DEC-011 requires that an LLM "safe" verdict can never defeat a lower-level
   * restriction; approvals must be based on structured adapter data (DEC-010).
   */
  auditPermissionModel(): SecurityFinding[] {
    const findings: SecurityFinding[] = [];
    // Silent permission widening: either a function whose name contains a
    // widen-word + permission/capability/scope, or a widen-word call whose
    // arguments mention permission/capability/scope.
    const widenRe =
      /\b(?:widen|expand|escalate|broaden)\w*(?:permission|capability|scope)\w*\s*\(|\b(?:widen|expand|escalate|broaden)\w*\s*\([^)]*(?:permission|capability|scope)/i;
    // LLM-as-authority: an LLM verdict gating a permission grant.
    const llmAuthRe = /\b(?:llm|model|ai|gpt|claude)\w*(?:safe|approve|authoriz|allow|permit)/i;

    for (const file of this.files) {
      // Skip the security module itself (it references these patterns in
      // detection logic) and the decision-ledger docs.
      if (isSecurityModule(file)) continue;

      file.lines.forEach((line, idx) => {
        const lineNo = idx + 1;
        if (widenRe.test(line) && !/approve|approval|deny|narrow|consent/i.test(line)) {
          findings.push(
            this.finding(
              'permission-silent-widen',
              'High',
              'Authorization',
              file,
              lineNo,
              'Code appears to widen permissions without an approval gate; DEC-011 forbids silently widening permissions.',
              'Require an explicit human/structured-data approval before widening any permission.',
            ),
          );
        }
        if (llmAuthRe.test(line)) {
          findings.push(
            this.finding(
              'permission-llm-authority',
              'High',
              'Authorization',
              file,
              lineNo,
              'An LLM risk assessment appears to be used as the authorization basis; DEC-010/DEC-011 require structured adapter data, not LLM text, as the authorization basis.',
              'Base approvals on structured adapter data only; treat LLM assessments as supplemental, never authoritative.',
            ),
          );
        }
      });
    }
    return findings;
  }

  /**
   * Build a single {@link SecurityFinding}.
   */
  private finding(
    slug: string,
    severity: SecurityFinding['severity'],
    category: SecurityCategory,
    file: SourceFile,
    line: number,
    description: string,
    recommendation: string,
  ): SecurityFinding {
    return {
      id: `${slug}:${file.relativePath.replace(/\\/g, '/')}:${line}`,
      severity,
      category,
      description,
      location: `${file.relativePath.replace(/\\/g, '/')}:${line}`,
      recommendation,
      status: 'Open',
    };
  }
}

/**
 * Recursively collect all `.ts` files under `root` (excluding `node_modules`
 * and `dist`), returning them as {@link SourceFile} entries.
 */
function collectSourceFiles(root: string): SourceFile[] {
  const out: SourceFile[] = [];
  walk(root, (abs) => {
    if (extname(abs) !== '.ts') return;
    let content: string;
    try {
      content = readFileSync(abs, 'utf8');
    } catch {
      return;
    }
    out.push({
      path: abs,
      relativePath: relative(root, abs),
      content,
      lines: content.split(/\r?\n/),
    });
  });
  return out;
}

/**
 * Recursive directory walk. Invokes `cb` for every file (not directory)
 * encountered, skipping `node_modules` and `dist`.
 */
function walk(dir: string, cb: (absPath: string) => void): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const abs = join(dir, entry);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(abs, cb);
    } else if (st.isFile()) {
      cb(abs);
    }
  }
}

/**
 * Return whether a {@link SourceFile} lives inside the `security/` module.
 *
 * The security module legitimately references the patterns the auditors look
 * for (it contains the detection logic), so it is skipped to avoid
 * self-flagging. Works for both top-level files (`security/foo.ts`) and
 * nested ones (`bar/security/baz.ts`) on either platform separator.
 */
function isSecurityModule(file: SourceFile): boolean {
  const normalized = file.relativePath.replace(/\\/g, '/');
  return (
    normalized === 'security/index.ts' ||
    normalized.startsWith('security/') ||
    normalized.includes('/security/')
  );
}

/**
 * Return whether a host string is a loopback/localhost host.
 */
function isLocalhostHost(host: string): boolean {
  const lower = host.toLowerCase();
  return (
    lower === '127.0.0.1' || lower === '::1' || lower === 'localhost' || lower === '0:0:0:0:0:0:0:1'
  );
}
