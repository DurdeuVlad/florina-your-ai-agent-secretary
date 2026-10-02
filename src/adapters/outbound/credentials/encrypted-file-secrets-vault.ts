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
  /**
   * Cross-process delete propagation (issue #292): name → ISO deletion
   * timestamp. A merged entry survives only when its `updatedAt` is newer
   * than the tombstone — deletes and re-adds resolve last-event-wins per
   * name instead of silently resurrecting revoked secrets.
   */
  readonly tombstones?: Record<string, string>;
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
  /**
   * Name → deletion-ISO-timestamp, persisted into the vault file so
   * deletes propagate across processes: an entry wins over a tombstone
   * only when its updatedAt is newer.
   */
  private readonly tombstones = new Map<string, string>();
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
   *
   * Refuses to regenerate when a vault file already exists but the key is
   * unreachable: writing a fresh master key over a populated vault would
   * render every stored secret permanently undecryptable — silent data
   * loss. The caller degrades to "vault unavailable" instead; deleting
   * secrets.enc is the deliberate reset path.
   */
  private getOrCreateMasterKey(): string {
    const existing = this.broker.retrieveCredential(MASTER_KEY_CREDENTIAL);
    if (existing !== null) {
      return existing;
    }
    if (fs.existsSync(this.filePath)) {
      throw new Error(
        `Secrets vault exists at ${this.filePath} but its master key is unreachable ` +
          `(OS credential store lookup failed or key was removed). Refusing to ` +
          `regenerate — that would orphan the stored secrets. Restore keychain ` +
          `access, or delete secrets.enc to reset the vault.`,
      );
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

    const parsed = this.readEntriesFromDisk();

    if (parsed) {
      this.entries = parsed.entries;
      this.adoptTombstones(parsed.tombstones);
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

  /**
   * Merge tombstones from disk, keeping the newest timestamp per name.
   * Non-parseable timestamps are ignored — a corrupt tombstone must not
   * drop live entries (lexical `<=` vs garbage) or throw on re-add.
   */
  private adoptTombstones(tombstones: Record<string, string> | undefined): void {
    for (const [name, at] of Object.entries(tombstones ?? {})) {
      if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) {
        continue;
      }
      const prior = this.tombstones.get(name);
      if (prior === undefined || at > prior) {
        this.tombstones.set(name, at);
      }
    }
  }

  /**
   * Parse the vault file's entry map, or null when missing/unreadable.
   * No quarantine side-effects — unlike load(), this never renames.
   */
  private readEntriesFromDisk(): SecretsVaultFileFormat | null {
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
        return candidate;
      }
    } catch {
      // Missing or mid-write — treated as "nothing to merge".
    }
    return null;
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

    // Cross-process merge: another daemon/CLI instance may have written
    // since our load. Union per key — entries added remotely that we
    // never touched survive; our local writes win for names we hold;
    // tombstoned deletions propagate both ways via timestamp comparison
    // (a remote re-add newer than the tombstone survives; older loses).
    const remote = this.readEntriesFromDisk();
    if (remote) {
      this.adoptTombstones(remote.tombstones);
      const merged: Record<string, EncryptedSecretEntry> = { ...remote.entries };
      for (const name of Object.keys(this.entries)) {
        const local = this.entries[name];
        const remoteEntry = Object.hasOwn(remote.entries, name) ? remote.entries[name] : undefined;
        // Per-name last-writer-wins: a stale local copy (loaded before a
        // remote write) must never shadow the newer remote entry.
        if (
          remoteEntry !== undefined &&
          remoteEntry.metadata.updatedAt > local.metadata.updatedAt
        ) {
          continue;
        }
        // defineProperty for the same __proto__ safety as storeSecret.
        Object.defineProperty(merged, name, {
          value: local,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      for (const [name, tombstonedAt] of this.tombstones) {
        const entry = Object.hasOwn(merged, name) ? merged[name] : undefined;
        if (entry !== undefined && entry.metadata.updatedAt <= tombstonedAt) {
          delete merged[name];
        }
      }
      this.entries = merged;
    }

    const payload: SecretsVaultFileFormat = {
      version: 1,
      entries: this.entries,
      tombstones: Object.fromEntries(this.tombstones),
    };

    // pid avoids a temp-name collision when two processes save in the
    // same millisecond (a clobbered temp would quarantine the vault).
    const tempPath = `${this.filePath}.${Date.now().toString(36)}.${process.pid}.tmp`;
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

    // Object.hasOwn — never the prototype chain: names like
    // '__proto__'/'hasOwnProperty' are legitimate secret names.
    const existing = Object.hasOwn(this.entries, name) ? this.entries[name] : undefined;
    // updatedAt must outrank any existing tombstone for this name — a
    // same-millisecond delete→re-add would otherwise die in the merge's
    // tombstone filter (<= loses ties) while reporting success.
    const tombstonedAt = this.tombstones.get(name);
    let now = new Date().toISOString();
    if (tombstonedAt !== undefined && now <= tombstonedAt) {
      now = new Date(Date.parse(tombstonedAt) + 1).toISOString();
    }

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

    // defineProperty, not assignment: `__proto__`-class names must become
    // own data properties, not trigger the prototype setter.
    const entry: EncryptedSecretEntry = {
      metadata,
      ciphertext: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
    };
    Object.defineProperty(this.entries, name, {
      value: entry,
      enumerable: true,
      writable: true,
      configurable: true,
    });

    try {
      this.save();
    } catch (err) {
      // Roll back the in-memory write — a secret that never reached disk
      // must not be readable as if it were stored.
      if (existing === undefined) {
        delete this.entries[name];
      } else {
        Object.defineProperty(this.entries, name, {
          value: existing,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      throw err;
    }
  }

  getSecretValue(name: string): string | null {
    const entry = Object.hasOwn(this.entries, name) ? this.entries[name] : undefined;
    if (!entry) {
      return null;
    }
    // Expired secrets are never returned (DEC-011: privileges narrow).
    // Fail closed: an unparseable expiry is treated as already expired —
    // an unreadable expiry must never widen into a live secret.
    const expiresAt = entry.metadata.expiresAt;
    if (expiresAt !== undefined) {
      const expiresMs = Date.parse(expiresAt);
      if (Number.isNaN(expiresMs) || expiresMs <= Date.now()) {
        return null;
      }
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
    const entry = Object.hasOwn(this.entries, name) ? this.entries[name] : undefined;
    return entry?.metadata ?? null;
  }

  deleteSecret(name: string): boolean {
    if (!Object.hasOwn(this.entries, name)) {
      return false;
    }
    const removed = this.entries[name];
    delete this.entries[name];
    // Timestamped tombstone: persists into the file so remote writers
    // learn the delete, and newer re-adds (updatedAt > this) still win.
    this.tombstones.set(name, new Date().toISOString());
    try {
      this.save();
    } catch (err) {
      // Roll back so in-memory state stays consistent with disk.
      Object.defineProperty(this.entries, name, {
        value: removed,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      this.tombstones.delete(name);
      throw err;
    }
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
