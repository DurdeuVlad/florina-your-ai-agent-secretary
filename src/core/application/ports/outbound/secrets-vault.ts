/**
 * Secrets vault port — outbound contract for secure secret storage,
 * scoped injection, and audit (issue #172, DEC-011, DEC-022).
 */
import type { EntityId } from '../../../domain/types.js';

export interface SecretScope {
  /**
   * Project this secret is scoped to; undefined = global.
   * Mirrors preference-profile scoping model (DEC-003 need-to-know).
   */
  readonly projectId?: EntityId;
  /**
   * Provider/agent kind this secret is allowed for (e.g. 'codex', 'claude-code', 'devin');
   * undefined = all providers.
   */
  readonly provider?: string;
  /**
   * Target environment variable name for injection (e.g. 'GITHUB_TOKEN', 'OPENAI_API_KEY').
   * If omitted, defaults to the secret's logical name.
   */
  readonly envVarName?: string;
}

export interface SecretMetadata {
  /** Logical unique identifier for the secret (e.g. 'github-token-payments'). */
  readonly name: string;
  /** Optional human-readable description. */
  readonly description?: string;
  /** Scoped grant definition. */
  readonly scope: SecretScope;
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string;
  /** ISO-8601 last update timestamp. */
  readonly updatedAt: string;
  /** Optional expiration timestamp. */
  readonly expiresAt?: string;
}

export interface SecretRecord extends SecretMetadata {
  /** Raw secret value (only present inside the vault or when explicitly requested). */
  readonly value: string;
}

export interface SecretCapturePrompt {
  readonly promptId: string;
  readonly secretName: string;
  readonly scope: SecretScope;
  readonly reason: string;
  /** Always true: UI must render a masked input field. */
  readonly masked: true;
  readonly createdAt: string;
}

export interface SecretsVaultPort {
  /** Store or update an encrypted secret with scope metadata. */
  storeSecret(
    name: string,
    value: string,
    scope: SecretScope,
    description?: string,
  ): Promise<void> | void;

  /** Retrieve the decrypted secret value by name. */
  getSecretValue(name: string): Promise<string | null> | string | null;

  /** List metadata for all stored secrets (NEVER reveals values). */
  listSecretMetadata(): Promise<readonly SecretMetadata[]> | readonly SecretMetadata[];

  /** Get metadata for a specific secret (NEVER reveals value). */
  getSecretMetadata(name: string): Promise<SecretMetadata | null> | SecretMetadata | null;

  /** Delete a secret from the vault. */
  deleteSecret(name: string): Promise<boolean> | boolean;

  /** List all secret values for redaction purposes. */
  listSecretValues(): Promise<readonly string[]> | readonly string[];
}
