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
  private readonly now: () => string;

  constructor(options: SecretsVaultServiceOptions) {
    this.vault = options.vault;
    this.eventJournal = options.eventJournal;
    this.eventBus = options.eventBus;
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
      throw new Error(`Failed to retrieve stored secret metadata for ${input.name}`);
    }

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
    const injectedNames: string[] = [];

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
        injections[envKey] = val;
        injectedNames.push(secret.name);
      }
    }

    // DEC-012 Audit log: record injection event without exposing values
    if (injectedNames.length > 0 && context.taskId && context.sessionId) {
      const timestamp = this.now();
      const message = `Injected ${injectedNames.length} scoped secret(s): ${injectedNames.join(', ')}`;
      this.recordAuditEvent(
        {
          id: `event_${randomId()}`,
          taskId: context.taskId,
          sessionId: context.sessionId,
          timestamp,
          kind: 'AgentProgress',
          payload: {
            message,
            action: 'secret_injected',
            secretNames: injectedNames,
            projectId: context.projectId,
            provider: context.provider,
          },
        },
        message,
      );
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
    const deleted = await this.vault.deleteSecret(name);
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
   * Defensive audit event recording. Safely inserts into eventJournal
   * and broadcasts onto eventBus without bubbling unhandled exceptions
   * if foreign key constraints or uncommitted context IDs fail.
   */
  private recordAuditEvent(event: Event, message: string): void {
    if (this.eventJournal) {
      try {
        this.eventJournal.insert(event);
      } catch {
        // Defensive: guard against SQLite foreign key or uncommitted context errors
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
