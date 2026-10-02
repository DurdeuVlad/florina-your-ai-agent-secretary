/**
 * Secrets vault service — Secretary-brokered credential capture,
 * scoped environment injection, and audit (issue #172, DEC-011, DEC-012, DEC-022).
 *
 * Implements mini-Infisical:
 * 1. Prompted secret capture with masked input field.
 * 2. Scoped grants: allowlist of provider/agent kind x project scope (DEC-003 need-to-know).
 * 3. Injection, not exposure: env-var injection at spawn time; values never echoed to journals.
 * 4. Audit: every capture, grant, injection, and revocation is journaled (who/what/when/scope — never values).
 * 5. Redaction: text stream redaction masks secret values.
 * 6. Revocation: revoke grants or delete secrets.
 */
import type { AgentProgressEvent } from '../../../domain/events.js';
import type { EntityId, Event } from '../../../domain/types.js';
import type { EventPublisherPort } from '../../ports/outbound/event-stream.js';
import type { EventJournalPort } from '../../ports/outbound/repositories.js';
import type {
  SecretCapturePrompt,
  SecretMetadata,
  SecretScope,
  SecretsVaultPort,
} from '../../ports/outbound/secrets-vault.js';

export interface SecretsVaultServiceOptions {
  readonly vault: SecretsVaultPort;
  readonly eventJournal?: EventJournalPort;
  readonly eventBus?: EventPublisherPort;
  readonly now?: () => string;
  /**
   * Sink for audit-write failures (issue #264) — a dropped audit row is
   * a provenance gap, not a soft fail. Receives the error and the exact
   * journal row that failed to insert so the caller can retain it for
   * inspection/retry. MUST NOT throw.
   */
  readonly onJournalFailure?: (err: unknown, row: Event) => void;
  /**
   * Vault-local audit ledger (issue #292): called on every capture and
   * delete with metadata only (`name`, `scope`, timestamp — NEVER the
   * value). The event journal only audits task-scoped operations (its
   * schema requires task+session FKs); user-scope operations from the
   * `secrets-*` commands have no such context, so the composition root
   * wires this sink to an append-only file. MUST NOT throw — the caller
   * wraps invocations defensively.
   */
  readonly auditSink?: (entry: VaultAuditEntry) => void;
}

/** One vault-audit ledger entry (metadata only — never a value). */
export interface VaultAuditEntry {
  readonly action: 'secret_captured' | 'secret_revoked' | 'secret_resolved' | 'secret_denied';
  readonly name: string;
  readonly scope: SecretScope;
  readonly at: string;
  /**
   * Consumer/dispatch context for resolution entries (issue #293).
   * `secret_resolved` is emitted when a value is read out for a consumer
   * — dispatch env or a named consumer like the chat model. The ledger
   * says "resolved for", not "injected into": adapters that cannot apply
   * per-run env (connect-time spawns, remote transports) may drop the
   * vars, and the audit record must not assert an event that did not
   * provably occur.
   */
  readonly context?: {
    readonly taskId?: EntityId;
    readonly sessionId?: EntityId;
    readonly projectId?: EntityId;
    readonly provider?: string;
  };
  /**
   * On `secret_denied` entries: the env var the injection was refused
   * for (recorded because a denylisted target is usually reachable only
   * via a derived name — `name: 'path'` denies PATH — so the auditor
   * should not have to re-derive it).
   */
  readonly targetEnvVar?: string;
}

export interface CaptureSecretInput {
  readonly name: string;
  readonly value: string;
  readonly scope: SecretScope;
  readonly description?: string;
  /** Optional ISO-8601 expiration; expired secrets are never injected. */
  readonly expiresAt?: string;
  readonly context?: {
    readonly taskId?: EntityId;
    readonly sessionId?: EntityId;
  };
}

export interface ResolveInjectionsContext {
  readonly projectId?: EntityId;
  readonly provider?: string;
  readonly taskId?: EntityId;
  readonly sessionId?: EntityId;
}

export class SecretsVaultService {
  private readonly vault: SecretsVaultPort;
  private readonly eventJournal?: EventJournalPort;
  private readonly eventBus?: EventPublisherPort;
  private readonly onJournalFailure?: (err: unknown, row: Event) => void;
  private readonly auditSink?: (entry: VaultAuditEntry) => void;
  private readonly now: () => string;

  constructor(options: SecretsVaultServiceOptions) {
    this.vault = options.vault;
    this.eventJournal = options.eventJournal;
    this.eventBus = options.eventBus;
    this.onJournalFailure = options.onJournalFailure;
    this.auditSink = options.auditSink;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /**
   * Create a structured prompt for the user/desktop UI requesting a secret capture.
   * Renders as a masked input field (never echoed into chat history or logs).
   */
  createCapturePrompt(request: {
    readonly secretName: string;
    readonly scope: SecretScope;
    readonly reason: string;
  }): SecretCapturePrompt {
    const timestamp = this.now();
    const promptId = `prompt-sec-${randomId()}`;
    return {
      promptId,
      secretName: request.secretName,
      scope: request.scope,
      reason: request.reason,
      masked: true,
      createdAt: timestamp,
    };
  }

  /**
   * Capture and store a secret securely in the vault.
   * Journals an immutable audit event (who/what/when/scope — never the value).
   */
  async captureSecret(input: CaptureSecretInput): Promise<SecretMetadata> {
    if (!input.name || input.name.trim() === '') {
      throw new Error('Secret name must not be empty.');
    }
    if (input.value === undefined || input.value === null || input.value === '') {
      throw new Error('Secret value must not be empty.');
    }

    await this.vault.storeSecret(input.name, input.value, input.scope, {
      description: input.description,
      expiresAt: input.expiresAt,
    });

    const metadata = await this.vault.getSecretMetadata(input.name);
    if (!metadata) {
      // Honest about the partial commit: the write already landed, so a
      // bare "failed" would mislead the user into retrying/storing twice.
      throw new Error(
        `Secret "${input.name}" was written but its metadata could not be read back — ` +
          'check `keys list` before retrying to avoid a duplicate write.',
      );
    }

    // Vault-local audit ledger (issue #292): every capture is recorded —
    // metadata only. Complements the task-scoped journal path below,
    // which only fires when task/session context exists.
    this.emitVaultAudit({ action: 'secret_captured', name: input.name, scope: input.scope });

    // DEC-012 Audit log: journal capture event if valid task/session context is present
    if (input.context?.taskId && input.context?.sessionId) {
      const timestamp = this.now();
      const message = `Secret "${input.name}" captured with scope ${JSON.stringify(input.scope)}`;
      this.recordAuditEvent(
        {
          id: `event_${randomId()}`,
          taskId: input.context.taskId,
          sessionId: input.context.sessionId,
          timestamp,
          kind: 'AgentProgress',
          payload: {
            message,
            action: 'secret_captured',
            secretName: input.name,
            scope: input.scope,
          },
        },
        message,
      );
    }

    return metadata;
  }

  /**
   * Resolve secret injections for an agent run context.
   * Matches against scoped allowlists (projectId x provider).
   *
   * Scoping rule:
   * - If secret.scope.projectId is set, it MUST match context.projectId.
   * - If secret.scope.provider is set, it MUST match context.provider.
   * - More specific scopes override broader scopes for the same environment variable name.
   *
   * Returns a map of ENV_VAR_NAME -> secret_value.
   * Raw values are only returned to the process environment spawner, NEVER to event streams.
   */
  async resolveInjections(context: ResolveInjectionsContext): Promise<Record<string, string>> {
    const allMetadata = await this.vault.listSecretMetadata();
    const injections: Record<string, string> = {};
    const injected: { name: string; scope: SecretScope }[] = [];

    // Sort secrets ascending by scope specificity so that more specific scopes
    // (e.g. project+provider or project-specific) override broader ones (e.g. global)
    // for the same environment variable name.
    const sortedSecrets = [...allMetadata].sort(
      (a, b) => scopeSpecificity(a.scope) - scopeSpecificity(b.scope),
    );

    for (const secret of sortedSecrets) {
      const scope = secret.scope;

      // Project scope check: if scoped to a project, context must match
      if (scope.projectId && scope.projectId !== context.projectId) {
        continue;
      }

      // Provider scope check: if scoped to a provider, context must match
      if (scope.provider && scope.provider !== context.provider) {
        continue;
      }

      const val = await this.vault.getSecretValue(secret.name);
      if (val !== null) {
        const envKey = scope.envVarName ?? toEnvVarName(secret.name);
        // The injection boundary enforces the denylist on the FINAL env
        // name — a derived name (secret named `path` → PATH) bypasses
        // wire-level validation, so it is checked here too (issue #292).
        const denyReason = injectionEnvVarError(envKey);
        if (denyReason !== null) {
          // A refused injection is a security-relevant audit event — the
          // ledger records the attempt, the target var, and the dispatch
          // context (issue #293).
          this.emitVaultAudit({
            action: 'secret_denied',
            name: secret.name,
            scope,
            targetEnvVar: envKey,
            context: {
              taskId: context.taskId,
              sessionId: context.sessionId,
              projectId: context.projectId,
              provider: context.provider,
            },
          });
          continue;
        }
        injections[envKey] = val;
        injected.push({ name: secret.name, scope });
      }
    }

    // Provenance (issue #293): resolution runs before the session row
    // exists (adapter-first dispatch — no DB mutation before a run
    // starts), so the event journal's session FK cannot be satisfied
    // here. The vault-local ledger records `secret_resolved` with the
    // dispatch context instead — and says "resolved for", not "injected
    // into": transports that cannot apply per-run env may drop the vars,
    // and the audit trail must not assert an event it cannot verify.
    // Metadata only — never values.
    for (const entry of injected) {
      this.emitVaultAudit({
        action: 'secret_resolved',
        name: entry.name,
        scope: entry.scope,
        context: {
          taskId: context.taskId,
          sessionId: context.sessionId,
          projectId: context.projectId,
          provider: context.provider,
        },
      });
    }

    return injections;
  }

  /**
   * Delete / revoke a secret from the vault.
   * Emits audit event if task/session context is provided.
   */
  async deleteSecret(
    name: string,
    context?: { taskId?: EntityId; sessionId?: EntityId },
  ): Promise<boolean> {
    // Fetch scope before the delete so the audit entry records real
    // provenance, not an empty scope.
    const prior = await this.vault.getSecretMetadata(name);
    const deleted = await this.vault.deleteSecret(name);
    if (deleted) {
      this.emitVaultAudit({
        action: 'secret_revoked',
        name,
        scope: prior?.scope ?? {},
      });
    }
    if (deleted && context?.taskId && context?.sessionId) {
      const timestamp = this.now();
      const message = `Secret "${name}" deleted/revoked from vault`;
      this.recordAuditEvent(
        {
          id: `event_${randomId()}`,
          taskId: context.taskId,
          sessionId: context.sessionId,
          timestamp,
          kind: 'AgentProgress',
          payload: {
            message,
            action: 'secret_revoked',
            secretName: name,
          },
        },
        message,
      );
    }
    return deleted;
  }

  /**
   * Redact known secret values from output streams and logs.
   * Replaces occurrences of raw secret strings with `[REDACTED_SECRET]`.
   * Sorts secret values descending by length to prevent shorter prefix substrings
   * from corrupting or leaking trailing suffixes of longer secrets.
   */
  async redact(text: string): Promise<string> {
    if (!text || text.length === 0) {
      return text;
    }

    const secretValues = await this.vault.listSecretValues();
    let redacted = text;

    const sortedValues = [...secretValues]
      .filter((val): val is string => typeof val === 'string' && val.length >= 3)
      .sort((a, b) => b.length - a.length);

    for (const val of sortedValues) {
      if (redacted.includes(val)) {
        redacted = redacted.replaceAll(val, '[REDACTED_SECRET]');
      }
    }

    return redacted;
  }

  /**
   * List all stored secret metadata (never returns secret values).
   */
  async listSecrets(): Promise<readonly SecretMetadata[]> {
    return this.vault.listSecretMetadata();
  }

  /**
   * Resolve the best stored credential value for a named consumer (issue
   * #293) — e.g. the Secretary chat model looking for
   * `FLORINA_LITELLM_KEY`/`OPENAI_API_KEY` or a `litellm`-scoped secret.
   *
   * A secret matches when its scope's `envVarName` (or the env var derived
   * from its name) is in `envVarNames`, or its `provider` is in
   * `providers`. Scope restrictions are hard constraints: project-scoped
   * secrets never feed a global consumer, and a `provider`-scoped secret
   * only resolves when that provider is on the caller's list — a
   * `claude-code` grant cannot leak into the chat model. When several
   * secrets match, the most recently updated wins — the user's newest
   * credential input reflects current intent.
   *
   * Returns the decrypted value, or `null` when nothing matches or the
   * match is expired. A resolved read is recorded in the vault-local
   * audit ledger (metadata only, never the value).
   */
  async resolveProviderCredential(match: {
    readonly envVarNames?: readonly string[];
    readonly providers?: readonly string[];
  }): Promise<string | null> {
    const envNames = new Set(match.envVarNames ?? []);
    const providers = new Set(match.providers ?? []);
    const allMetadata = await this.vault.listSecretMetadata();
    const candidates = allMetadata
      // A project-scoped secret must never feed a global consumer.
      .filter((m) => m.scope.projectId === undefined)
      // Provider scope is a restriction, not just a label: a secret
      // granted to `claude-code` must not resolve for the chat model.
      // `providers` therefore acts as a constraint — a set provider must
      // be on the consumer's list — not an alternate match key alone.
      .filter((m) => m.scope.provider === undefined || providers.has(m.scope.provider))
      .filter((m) => {
        if (m.scope.provider !== undefined && providers.has(m.scope.provider)) {
          return true;
        }
        // Match on the declared env var OR the derived one — a secret
        // named `openai-api-key` injects as OPENAI_API_KEY for agent envs,
        // so the credential resolver honors the same name mapping.
        return (
          (m.scope.envVarName !== undefined && envNames.has(m.scope.envVarName)) ||
          envNames.has(toEnvVarName(m.name))
        );
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    for (const candidate of candidates) {
      const value = await this.vault.getSecretValue(candidate.name);
      if (value !== null) {
        this.emitVaultAudit({
          action: 'secret_resolved',
          name: candidate.name,
          scope: candidate.scope,
        });
        return value;
      }
    }
    return null;
  }

  /**
   * Emit a vault-audit ledger entry (issue #292). The sink is expected to
   * be non-throwing; a throwing sink is contained anyway — a provenance
   * write failure must never break the vault operation it records.
   */
  private emitVaultAudit(entry: Omit<VaultAuditEntry, 'at'>): void {
    if (this.auditSink === undefined) {
      return;
    }
    try {
      this.auditSink({ ...entry, at: this.now() });
    } catch {
      /* audit must never break vault operations */
    }
  }

  /**
   * Defensive audit event recording. Safely inserts into eventJournal
   * and broadcasts onto eventBus without bubbling unhandled exceptions
   * if foreign key constraints or uncommitted context IDs fail.
   */
  private recordAuditEvent(event: Event, message: string): void {
    if (this.eventJournal) {
      try {
        this.eventJournal.insert(event);
      } catch (err) {
        // Defensive: guard against SQLite foreign key or uncommitted
        // context errors — but surface the drop as an attention item
        // (#264) rather than silently losing provenance.
        try {
          this.onJournalFailure?.(err, event);
        } catch {
          /* the sink itself must never break vault operations */
        }
      }
    }
    if (this.eventBus) {
      try {
        const supervisorEvent: AgentProgressEvent = {
          type: 'AgentProgress',
          timestamp: event.timestamp,
          taskId: event.taskId,
          sessionId: event.sessionId,
          agentId: 'secretary',
          adapterFidelityTier: 'B',
          message,
        };
        this.eventBus.publish(supervisorEvent);
      } catch {
        // Defensive: bus publish errors should never crash vault operations
      }
    }
  }
}

/** Generate a short random id (no crypto dependency needed for event ids). */
function randomId(): string {
  return `${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

/**
 * Derive a conventional env var name from a secret's logical name when no
 * explicit `envVarName` scope is set (`gh-token` -> `GH_TOKEN`).
 */
function toEnvVarName(name: string): string {
  const sanitized = name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return /^[0-9]/.test(sanitized) ? `_${sanitized}` : sanitized;
}

/**
 * Env vars whose injection would subvert the spawned process or its
 * traffic — loader paths, shell startup hooks, interpreter knobs, proxy
 * and CA overrides (issue #292). Checked case-insensitively at BOTH the
 * capture surface and the injection boundary so no path bypasses it.
 */
const DENIED_ENV_VAR_NAMES: ReadonlySet<string> = new Set([
  'PATH',
  'HOME',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_EXTRA_CA_CERTS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'LD_DEBUG',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'BASH_ENV',
  'ENV',
  'PROMPT_COMMAND',
  'PS1',
  'PS2',
  'PS3',
  'PS4',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'PYTHONINSPECT',
  'RUBYOPT',
  'RUBYLIB',
  'PERL5OPT',
  'PERL5DB',
  'GIT_SSH_COMMAND',
  'GIT_SSH',
  // git-config injection (issue #293): GIT_CONFIG_* can redirect
  // core.hooksPath or alias commands — code exec inside the agent's own
  // worktree. COMSPEC/PATHEXT/CDPATH redirect Windows shell resolution;
  // SSH_AUTH_SOCK hands an agent the user's ssh-agent.
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_COUNT',
  'COMSPEC',
  'PATHEXT',
  'CDPATH',
  'SSH_AUTH_SOCK',
  'JAVA_TOOL_OPTIONS',
  '_JAVA_OPTIONS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'SSL_CERT_FILE',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
]);

const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Validate a target env-var name for secret injection. Returns a readable
 * error, or null when the name is safe to inject. Shared by the command
 * surface (capture-time rejection) and resolveInjections (final-name
 * enforcement so derived names can't bypass the denylist).
 */
export function injectionEnvVarError(name: string): string | null {
  if (!ENV_VAR_NAME_PATTERN.test(name)) {
    return `envVarName '${name}' must match [A-Za-z_][A-Za-z0-9_]*`;
  }
  if (DENIED_ENV_VAR_NAMES.has(name.toUpperCase())) {
    return `envVarName '${name}' is a loader/shell/proxy variable and cannot be injected`;
  }
  return null;
}

/**
 * Calculate scope specificity score:
 * - Global (no provider, no projectId): 0
 * - Provider-only: 1
 * - Project-only: 2
 * - Project + Provider: 3
 */
function scopeSpecificity(scope: SecretScope): number {
  let score = 0;
  if (scope.provider) {
    score += 1;
  }
  if (scope.projectId) {
    score += 2;
  }
  return score;
}
