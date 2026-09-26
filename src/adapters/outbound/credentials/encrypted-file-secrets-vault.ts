/**
 * Encrypted file secrets vault adapter (issue #172, DEC-011, DEC-022).
 *
 * Implements SecretsVaultPort by storing secrets encrypted at rest in
 * ~/.florina/secrets.enc with AES-256-GCM and strict 0o600 permissions.
 *
 * The encryption key is a randomly generated 256-bit master key whose
 * custody is delegated to {@link CredentialBroker}: the real OS keychain
 * where available (macOS Keychain, Windows Credential Manager), otherwise
 * its machine-bound encrypted file store — see os-credential-vault.ts for
 * the documented limits of that fallback. A stolen secrets.enc cannot be
 * decrypted without the master key held by the credential vault.
 *
 * NEVER exposes raw secret values in metadata listings or to the SQLite journal.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type {
  SecretMetadata,
  SecretScope,
  SecretWriteOptions,
  SecretsVaultPort,
} from '../../../core/application/ports/outbound/secrets-vault.js';
import { CredentialBroker } from './os-credential-vault.js';

/** Credential name under which the vault master key is stored. */
const MASTER_KEY_CREDENTIAL = 'florina-secrets-vault:master-key';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;

interface EncryptedSecretEntry {
  readonly metadata: SecretMetadata;
  readonly ciphertext: string; // base64
  readonly iv: string; // base64
  readonly authTag: string; // base64
}

interface SecretsVaultFileFormat {
  readonly version: 1;
  readonly entries: Record<string, EncryptedSecretEntry>;
}

export interface EncryptedFileSecretsVaultOptions {
  /** Custom path to the encrypted secrets file (defaults to ~/.florina/secrets.enc). */
  readonly filePath?: string;
  /**
   * Master key material override (tests only). Production instances source a
   * random 256-bit key from the OS credential vault instead.
   */
  readonly masterKey?: string;
  /**
   * Credential vault used to persist the master key. Defaults to a
   * {@link CredentialBroker} on the auto-detected OS backend; tests may
   * inject a file-backed instance.
   */
  readonly credentialBroker?: CredentialBroker;
}

export class EncryptedFileSecretsVault implements SecretsVaultPort {
  private readonly filePath: string;
  private readonly broker: CredentialBroker;
  private readonly key: Buffer;
  private entries: Record<string, EncryptedSecretEntry> = {};
  /** True when the existing vault file was unreadable and could not be backed up. */
  private writeBlocked = false;

  constructor(options: EncryptedFileSecretsVaultOptions = {}) {
    this.filePath = options.filePath ?? path.join(os.homedir(), '.florina', 'secrets.enc');
    this.broker = options.credentialBroker ?? new CredentialBroker();
    const material = options.masterKey ?? this.getOrCreateMasterKey();
    this.key = crypto.createHash('sha256').update(material, 'utf8').digest();
    this.load();
  }

  /**
   * Fetch the vault master key from the OS credential vault, generating and
   * storing a fresh random key on first use.
   */
  private getOrCreateMasterKey(): string {
    const existing = this.broker.retrieveCredential(MASTER_KEY_CREDENTIAL);
    if (existing !== null) {
      return existing;
    }
    const generated = crypto.randomBytes(KEY_LENGTH).toString('base64');
    this.broker.storeCredential(MASTER_KEY_CREDENTIAL, generated, {
      description: 'AES-256 master key for ~/.florina/secrets.enc',
    });
    // Re-read: if a concurrent constructor raced us, adopt the key that
    // actually won in the broker so this instance stays consistent with
    // future instances.
    return this.broker.retrieveCredential(MASTER_KEY_CREDENTIAL) ?? generated;
  }

  private load(): void {
    this.entries = {};
    if (!fs.existsSync(this.filePath)) {
      return;
    }

    let parsed: SecretsVaultFileFormat | null = null;
    try {
      const candidate = JSON.parse(
        fs.readFileSync(this.filePath, 'utf8'),
      ) as SecretsVaultFileFormat;
      if (
        candidate &&
        candidate.version === 1 &&
        candidate.entries &&
        typeof candidate.entries === 'object'
      ) {
        parsed = candidate;
      }
    } catch {
      // Fall through — handled as an unreadable vault below.
    }

    if (parsed) {
      this.entries = parsed.entries;
      return;
    }

    // The vault is unreadable or in an unrecognized format. Preserve it for
    // manual recovery rather than silently overwriting it on the next save;
    // if it cannot be moved aside, block writes instead of destroying it.
    try {
      fs.renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now().toString(36)}`);
    } catch {
      this.writeBlocked = true;
    }
  }

  private save(): void {
    if (this.writeBlocked) {
      throw new Error(
        `Refusing to write secrets vault: existing file at ${this.filePath} could not be parsed or moved aside.`,
      );
    }
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    const payload: SecretsVaultFileFormat = {
      version: 1,
      entries: this.entries,
    };

    const tempPath = `${this.filePath}.${Date.now().toString(36)}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    fs.renameSync(tempPath, this.filePath);
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      // Best effort on platforms that don't support chmod (e.g. Windows)
    }
  }

  storeSecret(
    name: string,
    value: string,
    scope: SecretScope,
    options: SecretWriteOptions = {},
  ): void {
    if (!name || name.trim() === '') {
      throw new Error('Secret name must not be empty.');
    }
    if (value === undefined || value === null) {
      throw new Error('Secret value must not be null or undefined.');
    }

    const now = new Date().toISOString();
    const existing = this.entries[name];

    const metadata: SecretMetadata = {
      name,
      description: options.description ?? existing?.metadata.description,
      scope,
      createdAt: existing ? existing.metadata.createdAt : now,
      updatedAt: now,
      expiresAt: options.expiresAt ?? existing?.metadata.expiresAt,
    };

    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);

    this.entries[name] = {
      metadata,
      ciphertext: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
    };

    this.save();
  }

  getSecretValue(name: string): string | null {
    const entry = this.entries[name];
    if (!entry) {
      return null;
    }
    // Expired secrets are never returned (DEC-011: privileges narrow).
    const expiresAt = entry.metadata.expiresAt;
    if (expiresAt !== undefined && expiresAt <= new Date().toISOString()) {
      return null;
    }
    return this.decryptEntry(entry);
  }

  private decryptEntry(entry: EncryptedSecretEntry): string | null {
    try {
      const iv = Buffer.from(entry.iv, 'base64');
      const authTag = Buffer.from(entry.authTag, 'base64');
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAuthTag(authTag);
      return Buffer.concat([
        decipher.update(entry.ciphertext, 'base64'),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      return null;
    }
  }

  listSecretMetadata(): readonly SecretMetadata[] {
    return Object.values(this.entries).map((e) => e.metadata);
  }

  getSecretMetadata(name: string): SecretMetadata | null {
    return this.entries[name]?.metadata ?? null;
  }

  deleteSecret(name: string): boolean {
    if (!this.entries[name]) {
      return false;
    }
    delete this.entries[name];
    this.save();
    return true;
  }

  listSecretValues(): readonly string[] {
    // Deliberately bypasses the expiry check: expired values must still be
    // masked by output redaction.
    const values: string[] = [];
    for (const entry of Object.values(this.entries)) {
      const val = this.decryptEntry(entry);
      if (val !== null) {
        values.push(val);
      }
    }
    return values;
  }
}
