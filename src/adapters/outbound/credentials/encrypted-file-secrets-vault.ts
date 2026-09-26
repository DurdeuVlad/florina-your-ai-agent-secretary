/**
 * Encrypted file secrets vault adapter (issue #172, DEC-011, DEC-022).
 *
 * Implements SecretsVaultPort by storing secrets encrypted at rest
 * using AES-256-GCM with PBKDF2 key derivation from machine-bound
 * material in ~/.florina/secrets.enc with strict 0o600 permissions.
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
  SecretsVaultPort,
} from '../../../core/application/ports/outbound/secrets-vault.js';

interface EncryptedSecretEntry {
  readonly metadata: SecretMetadata;
  readonly ciphertext: string; // base64
  readonly iv: string; // base64
  readonly authTag: string; // base64
  readonly salt: string; // base64
}

interface SecretsVaultFileFormat {
  readonly version: 1;
  readonly entries: Record<string, EncryptedSecretEntry>;
}

export interface EncryptedFileSecretsVaultOptions {
  /** Custom path to the encrypted secrets file (defaults to ~/.florina/secrets.enc). */
  readonly filePath?: string;
  /** Custom machine key material override (useful for tests). */
  readonly machineKeyMaterial?: string;
}

const PBKDF2_ITERATIONS = 100_000;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;

function defaultMachineKey(): string {
  return `florina-secrets:${os.hostname()}:${os.userInfo().username}:${os.platform()}:${os.arch()}`;
}

export class EncryptedFileSecretsVault implements SecretsVaultPort {
  private readonly filePath: string;
  private readonly machineKey: string;
  private entries: Record<string, EncryptedSecretEntry> = {};

  constructor(options: EncryptedFileSecretsVaultOptions = {}) {
    this.filePath =
      options.filePath ?? path.join(os.homedir(), '.florina', 'secrets.enc');
    this.machineKey = options.machineKeyMaterial ?? defaultMachineKey();
    this.load();
  }

  private deriveKey(salt: Buffer): Buffer {
    return crypto.pbkdf2Sync(
      this.machineKey,
      salt,
      PBKDF2_ITERATIONS,
      KEY_LENGTH,
      'sha256',
    );
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) {
      this.entries = {};
      return;
    }
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as SecretsVaultFileFormat;
      if (parsed && parsed.version === 1 && typeof parsed.entries === 'object') {
        this.entries = parsed.entries;
      } else {
        this.entries = {};
      }
    } catch {
      // Degrades gracefully on unreadable or corrupt file
      this.entries = {};
    }
  }

  private save(): void {
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
    description?: string,
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
      description: description ?? existing?.metadata.description,
      scope,
      createdAt: existing ? existing.metadata.createdAt : now,
      updatedAt: now,
    };

    const salt = crypto.randomBytes(SALT_LENGTH);
    const iv = crypto.randomBytes(IV_LENGTH);
    const key = this.deriveKey(salt);

    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(value, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    const authTag = cipher.getAuthTag();

    this.entries[name] = {
      metadata,
      ciphertext: encrypted,
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      salt: salt.toString('base64'),
    };

    this.save();
  }

  getSecretValue(name: string): string | null {
    const entry = this.entries[name];
    if (!entry) {
      return null;
    }

    try {
      const salt = Buffer.from(entry.salt, 'base64');
      const iv = Buffer.from(entry.iv, 'base64');
      const authTag = Buffer.from(entry.authTag, 'base64');
      const key = this.deriveKey(salt);

      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);
      let decrypted = decipher.update(entry.ciphertext, 'base64', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
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
    const values: string[] = [];
    for (const name of Object.keys(this.entries)) {
      const val = this.getSecretValue(name);
      if (val !== null) {
        values.push(val);
      }
    }
    return values;
  }
}
