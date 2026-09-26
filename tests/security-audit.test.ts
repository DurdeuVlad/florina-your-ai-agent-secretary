import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SecurityAuditor,
  validateLocalhostOnly,
  sanitizeProcessInput,
  redactSecret,
  validateApiKeyFormat,
  assertNoSecretsInLogs,
  SecretsInLogsError,
  deriveOverallRisk,
  buildSummary,
  type SecurityFinding,
} from '../src/security/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoSrc = join(here, '..', 'src');

describe('SecurityHardening utilities', () => {
  describe('validateLocalhostOnly', () => {
    it('accepts loopback URLs and hosts', () => {
      expect(validateLocalhostOnly('ws://127.0.0.1:17419')).toBe(true);
      expect(validateLocalhostOnly('http://127.0.0.1:8080')).toBe(true);
      expect(validateLocalhostOnly('127.0.0.1')).toBe(true);
      expect(validateLocalhostOnly('127.0.0.1:17419')).toBe(true);
      expect(validateLocalhostOnly('localhost')).toBe(true);
      expect(validateLocalhostOnly('localhost:3000')).toBe(true);
      expect(validateLocalhostOnly('::1')).toBe(true);
      expect(validateLocalhostOnly('ws://[::1]:8080')).toBe(true);
    });

    it('rejects network-exposed bindings', () => {
      expect(validateLocalhostOnly('0.0.0.0')).toBe(false);
      expect(validateLocalhostOnly('ws://0.0.0.0:17419')).toBe(false);
      expect(validateLocalhostOnly('192.168.1.10')).toBe(false);
      expect(validateLocalhostOnly('http://example.com:8080')).toBe(false);
      expect(validateLocalhostOnly('::')).toBe(false);
      expect(validateLocalhostOnly('')).toBe(false);
    });
  });

  describe('sanitizeProcessInput', () => {
    it('wraps plain input in single quotes', () => {
      expect(sanitizeProcessInput('hello')).toBe("'hello'");
    });

    it('escapes embedded single quotes', () => {
      // The exact escape sequence is `'\''` — the input `'` becomes `'\''`.
      expect(sanitizeProcessInput("it's")).toBe("'it'\\''s'");
    });

    it('neutralizes shell metacharacters', () => {
      const dangerous = '; rm -rf /';
      const sanitized = sanitizeProcessInput(dangerous);
      // The sanitized form is a single quoted token: the dangerous content is
      // wrapped in single quotes so the shell treats it as a literal argument
      // rather than interpreting the semicolon as a command separator.
      expect(sanitized.startsWith("'")).toBe(true);
      expect(sanitized.endsWith("'")).toBe(true);
      expect(sanitized).toBe("'; rm -rf /'");
    });
  });

  describe('redactSecret', () => {
    it('shows the first 4 characters plus ***', () => {
      expect(redactSecret('sk-abcd1234567890')).toBe('sk-a***');
    });

    it('fully masks very short values', () => {
      expect(redactSecret('abc')).toBe('***');
      expect(redactSecret('ab')).toBe('***');
    });

    it('masks empty input', () => {
      expect(redactSecret('')).toBe('***');
    });
  });

  describe('validateApiKeyFormat', () => {
    it('accepts well-formed OpenAI keys', () => {
      expect(validateApiKeyFormat('sk-' + 'a'.repeat(40))).toBe(true);
      expect(validateApiKeyFormat('sk-proj-1234567890abcdefghijklmn')).toBe(true);
    });

    it('rejects malformed keys', () => {
      expect(validateApiKeyFormat('not-a-key')).toBe(false);
      expect(validateApiKeyFormat('sk-short')).toBe(false);
      expect(validateApiKeyFormat('')).toBe(false);
      expect(validateApiKeyFormat('pk-12345678901234567890')).toBe(false);
    });
  });

  describe('assertNoSecretsInLogs', () => {
    it('passes for clean text', () => {
      expect(() => assertNoSecretsInLogs('starting daemon on port 17419')).not.toThrow();
    });

    it('throws when an OpenAI key is present', () => {
      expect(() => assertNoSecretsInLogs('using key sk-' + 'a'.repeat(40))).toThrow(
        SecretsInLogsError,
      );
    });

    it('throws when a Bearer token is present', () => {
      expect(() =>
        assertNoSecretsInLogs('Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456'),
      ).toThrow(SecretsInLogsError);
    });

    it('throws when a PEM private key is present', () => {
      expect(() => assertNoSecretsInLogs('-----BEGIN RSA PRIVATE KEY-----')).toThrow(
        SecretsInLogsError,
      );
    });

    it('throws when a GitHub token is present', () => {
      expect(() => assertNoSecretsInLogs('token ghp_1234567890abcdefghijklmn')).toThrow(
        SecretsInLogsError,
      );
    });
  });
});

describe('audit-report helpers', () => {
  it('deriveOverallRisk returns the highest open severity', () => {
    const findings: SecurityFinding[] = [
      {
        id: 'a',
        severity: 'Low',
        category: 'InputValidation',
        description: '',
        location: 'f:1',
        recommendation: '',
        status: 'Open',
      },
      {
        id: 'b',
        severity: 'High',
        category: 'NetworkSecurity',
        description: '',
        location: 'f:2',
        recommendation: '',
        status: 'Open',
      },
    ];
    expect(deriveOverallRisk(findings)).toBe('High');
  });

  it('deriveOverallRisk ignores Fixed/Accepted findings', () => {
    const findings: SecurityFinding[] = [
      {
        id: 'a',
        severity: 'Critical',
        category: 'SecretManagement',
        description: '',
        location: 'f:1',
        recommendation: '',
        status: 'Fixed',
      },
      {
        id: 'b',
        severity: 'Low',
        category: 'InputValidation',
        description: '',
        location: 'f:2',
        recommendation: '',
        status: 'Accepted',
      },
    ];
    expect(deriveOverallRisk(findings)).toBe('None');
  });

  it('buildSummary mentions open finding counts', () => {
    const findings: SecurityFinding[] = [
      {
        id: 'a',
        severity: 'Critical',
        category: 'SecretManagement',
        description: '',
        location: 'f:1',
        recommendation: '',
        status: 'Open',
      },
      {
        id: 'b',
        severity: 'Low',
        category: 'InputValidation',
        description: '',
        location: 'f:2',
        recommendation: '',
        status: 'Open',
      },
      {
        id: 'c',
        severity: 'High',
        category: 'NetworkSecurity',
        description: '',
        location: 'f:3',
        recommendation: '',
        status: 'Fixed',
      },
    ];
    const summary = buildSummary(findings);
    expect(summary).toContain('2 open');
    expect(summary).toContain('1 Critical');
    expect(summary).toContain('1 Low');
  });
});

describe('SecurityAuditor', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'flor-audit-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeFile(rel: string, content: string): void {
    const abs = join(tmp, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }

  describe('auditProcessSpawning', () => {
    it('flags shell:true as Critical', () => {
      writeFile(
        'spawn.ts',
        "import { spawn } from 'node:child_process';\nspawn('ls', [], { shell: true });\n",
      );
      const auditor = new SecurityAuditor(tmp);
      const findings = auditor.auditProcessSpawning();
      const shellFinding = findings.find((f) => f.id.startsWith('process-shell-true'));
      expect(shellFinding).toBeDefined();
      expect(shellFinding?.severity).toBe('Critical');
      expect(shellFinding?.category).toBe('ProcessSandboxing');
      expect(shellFinding?.location).toContain('spawn.ts:2');
    });

    it('flags unquoted interpolation in exec as High', () => {
      writeFile(
        'exec.ts',
        "import { execSync } from 'node:child_process';\nexecSync(`git ${branch}`);\n",
      );
      const auditor = new SecurityAuditor(tmp);
      const findings = auditor.auditProcessSpawning();
      const interp = findings.find((f) => f.id.startsWith('process-unquoted-interpolation'));
      expect(interp).toBeDefined();
      expect(interp?.severity).toBe('High');
      expect(interp?.category).toBe('Injection');
    });

    it('does not flag shell-quoted interpolation', () => {
      writeFile(
        'safe.ts',
        "import { execSync } from 'node:child_process';\nexecSync(`git ${args.map(shellQuote).join(' ')}`);\n",
      );
      const auditor = new SecurityAuditor(tmp);
      const findings = auditor.auditProcessSpawning();
      expect(
        findings.find((f) => f.id.startsWith('process-unquoted-interpolation')),
      ).toBeUndefined();
    });
  });

  describe('auditSecretHandling', () => {
    it('flags hardcoded OpenAI API keys as Critical', () => {
      writeFile('config.ts', "const KEY = 'sk-" + 'a'.repeat(40) + "';\n");
      const auditor = new SecurityAuditor(tmp);
      const findings = auditor.auditSecretHandling();
      const key = findings.find((f) => f.id.startsWith('secret-hardcoded-apikey'));
      expect(key).toBeDefined();
      expect(key?.severity).toBe('Critical');
      expect(key?.category).toBe('SecretManagement');
    });

    it('flags hardcoded GitHub tokens as Critical', () => {
      writeFile('gh.ts', "const token = 'ghp_1234567890abcdefghijklmn';\n");
      const auditor = new SecurityAuditor(tmp);
      const findings = auditor.auditSecretHandling();
      const tok = findings.find((f) => f.id.startsWith('secret-hardcoded-github-token'));
      expect(tok).toBeDefined();
      expect(tok?.severity).toBe('Critical');
    });

    it('flags logging of a secret-named variable as High', () => {
      writeFile('log.ts', "console.log('token is', token);\n");
      const auditor = new SecurityAuditor(tmp);
      const findings = auditor.auditSecretHandling();
      const leak = findings.find((f) => f.id.startsWith('secret-leaked-in-log'));
      expect(leak).toBeDefined();
      expect(leak?.severity).toBe('High');
      expect(leak?.category).toBe('DataExposure');
    });
  });

  describe('auditNetworkSurface', () => {
    it('flags a non-localhost host binding as High', () => {
      writeFile('server.ts', "new WebSocketServer({ host: '0.0.0.0', port: 8080 });\n");
      const auditor = new SecurityAuditor(tmp);
      const findings = auditor.auditNetworkSurface();
      const bind = findings.find(
        (f) =>
          f.id.startsWith('network-non-localhost-bind') || f.id.startsWith('network-exposed-bind'),
      );
      expect(bind).toBeDefined();
      expect(bind?.severity).toBe('High');
      expect(bind?.category).toBe('NetworkSecurity');
    });

    it('does not flag a localhost binding', () => {
      writeFile('server.ts', "new WebSocketServer({ host: '127.0.0.1', port: 17419 });\n");
      const auditor = new SecurityAuditor(tmp);
      const findings = auditor.auditNetworkSurface();
      expect(findings).toHaveLength(0);
    });

    it('flags a wildcard address literal', () => {
      writeFile('server.ts', "server.listen(8080, '0.0.0.0');\n");
      const auditor = new SecurityAuditor(tmp);
      const findings = auditor.auditNetworkSurface();
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.every((f) => f.category === 'NetworkSecurity')).toBe(true);
    });
  });

  describe('auditInputValidation', () => {
    it('flags raw process.argv indexing as Medium', () => {
      writeFile('cli.ts', 'const arg = process.argv[2];\n');
      const auditor = new SecurityAuditor(tmp);
      const findings = auditor.auditInputValidation();
      const argv = findings.find((f) => f.id.startsWith('input-unvalidated-argv'));
      expect(argv).toBeDefined();
      expect(argv?.severity).toBe('Medium');
      expect(argv?.category).toBe('InputValidation');
    });

    it('flags JSON.parse of env data as Medium', () => {
      writeFile('parse.ts', 'const cfg = JSON.parse(process.env.CONFIG);\n');
      const auditor = new SecurityAuditor(tmp);
      const findings = auditor.auditInputValidation();
      const parse = findings.find((f) => f.id.startsWith('input-unvalidated-json-parse'));
      expect(parse).toBeDefined();
      expect(parse?.severity).toBe('Medium');
    });
  });

  describe('auditPermissionModel (DEC-011)', () => {
    it('flags silent permission widening as High', () => {
      writeFile('policy.ts', 'widenPermissions(task);\n');
      const auditor = new SecurityAuditor(tmp);
      const findings = auditor.auditPermissionModel();
      const widen = findings.find((f) => f.id.startsWith('permission-silent-widen'));
      expect(widen).toBeDefined();
      expect(widen?.severity).toBe('High');
      expect(widen?.category).toBe('Authorization');
    });

    it('flags LLM-as-authority as High', () => {
      writeFile('approve.ts', 'if (llmSafe(action)) grantPermission(action);\n');
      const auditor = new SecurityAuditor(tmp);
      const findings = auditor.auditPermissionModel();
      const llm = findings.find((f) => f.id.startsWith('permission-llm-authority'));
      expect(llm).toBeDefined();
      expect(llm?.severity).toBe('High');
    });

    it('does not flag approval-gated widening', () => {
      writeFile('policy.ts', 'widenPermissions(task, { approved: true });\n');
      const auditor = new SecurityAuditor(tmp);
      const findings = auditor.auditPermissionModel();
      expect(findings.find((f) => f.id.startsWith('permission-silent-widen'))).toBeUndefined();
    });
  });

  describe('auditAll', () => {
    it('assembles a full SecurityAuditReport', () => {
      writeFile(
        'bad.ts',
        "spawn('x', [], { shell: true });\nconst k = 'sk-" + 'a'.repeat(40) + "';\n",
      );
      const auditor = new SecurityAuditor(tmp);
      const report = auditor.auditAll();
      expect(report.findings.length).toBeGreaterThanOrEqual(2);
      expect(report.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(['Critical', 'High', 'Medium', 'Low']).toContain(report.overallRisk);
      expect(report.summary).toContain('open');
    });
  });
});

describe('actual codebase security audit', () => {
  // Audit the real `src/` tree. The acceptance criteria require that the
  // audit of the actual codebase shows no Critical findings.
  let report: ReturnType<SecurityAuditor['auditAll']>;

  beforeEach(() => {
    const auditor = new SecurityAuditor(repoSrc);
    report = auditor.auditAll();
  });

  it('has no Critical findings', () => {
    const critical = report.findings.filter((f) => f.severity === 'Critical');
    if (critical.length > 0) {
      // Print the locations to aid triage.
      console.error(
        'Critical findings:',
        critical.map((f) => f.location),
      );
    }
    expect(critical).toHaveLength(0);
  });

  it('binds network servers to localhost only', () => {
    const network = report.findings.filter((f) => f.category === 'NetworkSecurity');
    if (network.length > 0) {
      console.error(
        'Network findings:',
        network.map((f) => f.location),
      );
    }
    expect(network).toHaveLength(0);
  });

  it('has no hardcoded secrets', () => {
    const secrets = report.findings.filter(
      (f) => f.category === 'SecretManagement' && f.severity === 'Critical',
    );
    expect(secrets).toHaveLength(0);
  });

  it('has no LLM-as-authority findings (DEC-010/DEC-011)', () => {
    const llmAuth = report.findings.filter((f) => f.id.startsWith('permission-llm-authority'));
    if (llmAuth.length > 0) {
      console.error(
        'LLM-authority findings:',
        llmAuth.map((f) => f.location),
      );
    }
    expect(llmAuth).toHaveLength(0);
  });
});
