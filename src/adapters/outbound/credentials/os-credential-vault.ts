/**
 * Credential vault — securely stores and retrieves credentials (GitHub tokens,
 * cloud keys) so that workers never receive permanent secrets (DEC-022).
 *
 * The vault uses the OS keychain where available and falls back to an
 * encrypted local file store otherwise:
 *
 * - **Windows**: Windows Credential Manager via the `cmdkey` child process.
 *   Credentials are stored as generic credentials under the
 *   `AgentSecretary:` namespace. `cmdkey` can store and delete but cannot
 *   retrieve passwords from the command line (the wincred API is needed for
 *   that), so the encrypted file store is used as the retrieval path on
 *   Windows. A native addon would be needed for full keychain retrieval.
 * - **macOS**: the `security` command (Keychain). Generic password items in
 *   the login keychain under the `AgentSecretary` service. Full
 *   store/retrieve/delete support.
 * - **Linux / fallback**: a file-based encrypted store. Credentials are
 *   encrypted with AES-256-GCM using a key derived from machine-specific
 *   material (hostname + username + platform) via PBKDF2. The encrypted file
 *   is written with restrictive permissions. This is also the default for
 *   tests so no OS keychain is touched.
 *
 * Security notes (DEC-011):
 * - The vault is the "secret/capability broker" rung of the security
 *   hierarchy. It sits below the secretary policy rung.
 * - `retrieveCredential` is intended for internal use by the
 *   {@link CapabilityBroker} only — workers must never call it directly.
 * - `listCredentials` returns names only — never values.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import type { CredentialVaultPort } from '../../../core/application/ports/outbound/credential-vault.js';

/** The OS platform detected for backend selection. */
export type CredentialBackend = 'windows' | 'macos' | 'file';

/** Optional metadata associated with a stored credential. */
export interface CredentialMetadata {
  /** Human-readable description of the credential. */
  readonly description?: string;
  /** When the credential was stored (ISO-8601). */
  readonly storedAt?: string;
  /** Free-form tags for grouping / filtering. */
  readonly tags?: readonly string[];
}

/** A stored credential record (value is only present in the vault). */
export interface StoredCredential {
  readonly name: string;
  readonly value: string;
  readonly metadata: CredentialMetadata;
}

/** Options for constructing a {@link CredentialBroker}. */
export interface CredentialBrokerOptions {
  /**
   * Force a specific backend. When omitted, the backend is auto-detected from
   * the OS. Use `'file'` for tests.
   */
  readonly backend?: CredentialBackend;
  /**
   * Directory for the file-based fallback store. Defaults to
   * `~/.agent-secretary/credentials`.
   */
  readonly fileStoreDir?: string;
  /**
   * Override the machine-specific key material used for file-store key
   * derivation (primarily for tests).
   */
  readonly machineKeyMaterial?: string;
}

/** Prefix used to namespace credentials in OS keychains. */
const KEYCHAIN_SERVICE = 'AgentSecretary';

/** PBKDF2 iterations for file-store key derivation. */
const PBKDF2_ITERATIONS = 100_000;

/** Key length (bytes) for AES-256. */
const KEY_LENGTH = 32;

/** Salt length (bytes). */
const SALT_LENGTH = 16;

/** IV length (bytes) for AES-256-GCM. */
const IV_LENGTH = 12;

/** Auth tag length (bytes) for AES-256-GCM. */
const AUTH_TAG_LENGTH = 16;

/**
 * Detect the appropriate credential backend for the current OS.
 */
function detectBackend(): CredentialBackend {
  const platform = os.platform();
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  return 'file';
}

/**
 * Derive a machine-specific key material string. This is NOT a strong secret —
 * it binds the file-store encryption key to the local machine so a stolen
 * credential file cannot be decrypted on a different machine without
 * re-deriving the same material. For production hardening, a real OS secret
 * store or KMS should be used.
 */
function defaultMachineKeyMaterial(): string {
  return `agent-secretary:${os.hostname()}:${os.userInfo().username}:${os.platform()}:${os.arch()}`;
}

/**
 * Default directory for the file-based credential store.
 */
function defaultFileStoreDir(): string {
  return path.join(os.homedir(), '.agent-secretary', 'credentials');
}

/**
 * Credential vault — securely stores and retrieves credentials (DEC-022).
 *
 * Workers never receive raw credentials. The {@link CapabilityBroker} uses
 * this vault to retrieve a credential, execute an action with it, and return
 * only the action result.
 */
export class CredentialBroker implements CredentialVaultPort {
  private readonly backend: CredentialBackend;
  private readonly fileStoreDir: string;
  private readonly machineKeyMaterial: string;

  constructor(options: CredentialBrokerOptions = {}) {
    this.backend = options.backend ?? detectBackend();
    this.fileStoreDir = options.fileStoreDir ?? defaultFileStoreDir();
    this.machineKeyMaterial = options.machineKeyMaterial ?? defaultMachineKeyMaterial();
  }

  /** The active backend (primarily for diagnostics / tests). */
  get activeBackend(): CredentialBackend {
    return this.backend;
  }

  /**
   * Store a credential securely.
   *
   * @param name - Logical credential name (e.g. `github-token`).
   * @param value - The secret value (token, key, ...).
   * @param metadata - Optional metadata (description, tags, ...).
   */
  storeCredential(name: string, value: string, metadata: CredentialMetadata = {}): void {
    if (!name) throw new Error('Credential name must not be empty.');
    if (value === undefined || value === null) {
      throw new Error('Credential value must not be null or undefined.');
    }
    const record: StoredCredential = {
      name,
      value,
      metadata: { ...metadata, storedAt: metadata.storedAt ?? new Date().toISOString() },
    };
    switch (this.backend) {
      case 'windows':
        this.storeWindows(name, record);
        break;
      case 'macos':
        this.storeMacos(name, record);
        break;
      case 'file':
        this.storeFile(name, record);
        break;
    }
  }

  /**
   * Retrieve a credential value by name. This is intended for internal use by
   * the {@link CapabilityBroker} only — workers must never call this directly.
   *
   * @param name - Logical credential name.
   * @returns The credential value, or `null` if not found.
   */
  retrieveCredential(name: string): string | null {
    if (!name) throw new Error('Credential name must not be empty.');
    switch (this.backend) {
      case 'windows':
        // cmdkey cannot retrieve passwords from the command line; use the
        // encrypted file store as the retrieval path.
        return this.retrieveFile(name);
      case 'macos':
        return this.retrieveMacos(name);
      case 'file':
        return this.retrieveFile(name);
    }
  }

  /**
   * Delete a stored credential.
   *
   * @param name - Logical credential name.
   * @returns `true` if a credential was removed, `false` if it did not exist.
   */
  deleteCredential(name: string): boolean {
    if (!name) throw new Error('Credential name must not be empty.');
    let removed = false;
    switch (this.backend) {
      case 'windows':
        removed = this.deleteWindows(name);
        // Also remove from the file store (retrieval path).
        removed = this.deleteFile(name) || removed;
        break;
      case 'macos':
        removed = this.deleteMacos(name);
        break;
      case 'file':
        removed = this.deleteFile(name);
        break;
    }
    return removed;
  }

  /**
   * List the names of all stored credentials. Never returns credential values.
   */
  listCredentials(): string[] {
    switch (this.backend) {
      case 'windows':
        // Merge keychain presence markers with file-store index.
        return Array.from(new Set([...this.listWindows(), ...this.listFile()]));
      case 'macos':
        return this.listMacos();
      case 'file':
        return this.listFile();
    }
  }

  /* ------------------------------------------------------------------ *
   * Windows Credential Manager (cmdkey)
   * ------------------------------------------------------------------ */

  private windowsTarget(name: string): string {
    return `${KEYCHAIN_SERVICE}:${name}`;
  }

  private storeWindows(name: string, record: StoredCredential): void {
    const target = this.windowsTarget(name);
    // Delete any existing entry first (cmdkey errors if the target exists).
    try {
      execFileSync('cmdkey', [`/delete:${target}`], { stdio: 'ignore' });
    } catch {
      // Ignore — target may not exist yet.
    }
    // Store the credential. The password is base64-encoded to avoid command-
    // line parsing issues with special characters in the JSON payload.
    const encoded = Buffer.from(JSON.stringify(record), 'utf-8').toString('base64');
    execFileSync('cmdkey', [`/generic:${target}`, '/user:agent-secretary', `/pass:${encoded}`], {
      stdio: 'ignore',
    });
    // Also write to the encrypted file store (retrieval path on Windows).
    this.storeFile(name, record);
  }

  private deleteWindows(name: string): boolean {
    const target = this.windowsTarget(name);
    try {
      execFileSync('cmdkey', [`/delete:${target}`], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  private listWindows(): string[] {
    let output: string;
    try {
      output = execFileSync('cmdkey', ['/list'], { encoding: 'utf-8' });
    } catch {
      return [];
    }
    const names: string[] = [];
    const prefix = `${KEYCHAIN_SERVICE}:`;
    for (const line of output.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith(prefix)) {
        names.push(trimmed.slice(prefix.length));
      }
    }
    return names;
  }

  /* ------------------------------------------------------------------ *
   * macOS Keychain (security)
   * ------------------------------------------------------------------ */

  private storeMacos(name: string, record: StoredCredential): void {
    const payload = JSON.stringify(record);
    // Delete existing item first (security add-generic-password fails if it
    // exists).
    try {
      execFileSync('security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', name], {
        stdio: 'ignore',
      });
    } catch {
      // Ignore — item may not exist yet.
    }
    execFileSync(
      'security',
      ['add-generic-password', '-s', KEYCHAIN_SERVICE, '-a', name, '-w', payload],
      { stdio: 'ignore' },
    );
  }

  private retrieveMacos(name: string): string | null {
    let output: string;
    try {
      output = execFileSync(
        'security',
        ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', name, '-w'],
        { encoding: 'utf-8' },
      );
    } catch {
      return null;
    }
    const trimmed = output.trim();
    if (!trimmed) return null;
    try {
      const record = JSON.parse(trimmed) as StoredCredential;
      return record.value;
    } catch {
      // Legacy: stored as raw value.
      return trimmed;
    }
  }

  private deleteMacos(name: string): boolean {
    try {
      execFileSync('security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', name], {
        stdio: 'ignore',
      });
      return true;
    } catch {
      return false;
    }
  }

  private listMacos(): string[] {
    // `security dump-keychain` output is not reliably parseable across macOS
    // versions. For MVP, we maintain a companion file-store index for listing
    // while the keychain holds the secure values. A native keychain API would
    // provide direct enumeration.
    return this.listFile();
  }

  /* ------------------------------------------------------------------ *
   * File-based encrypted fallback
   * ------------------------------------------------------------------ */

  private storeFile(name: string, record: StoredCredential): void {
    this.ensureFileStoreDir();
    const indexPath = this.fileIndexPath();
    const entries = this.readFileIndex();
    const payload = this.encrypt(JSON.stringify(record));
    const entryFile = this.fileEntryPath(name);
    fs.writeFileSync(entryFile, payload, { mode: 0o600 });
    if (!entries.includes(name)) {
      entries.push(name);
      fs.writeFileSync(indexPath, JSON.stringify(entries, null, 2), { mode: 0o600 });
    }
  }

  private retrieveFile(name: string): string | null {
    const entryFile = this.fileEntryPath(name);
    if (!fs.existsSync(entryFile)) return null;
    const encrypted = fs.readFileSync(entryFile);
    try {
      const decrypted = this.decrypt(encrypted);
      const record = JSON.parse(decrypted) as StoredCredential;
      return record.value;
    } catch {
      return null;
    }
  }

  private deleteFile(name: string): boolean {
    const entryFile = this.fileEntryPath(name);
    let removed = false;
    if (fs.existsSync(entryFile)) {
      fs.unlinkSync(entryFile);
      removed = true;
    }
    const indexPath = this.fileIndexPath();
    if (fs.existsSync(indexPath)) {
      const entries = this.readFileIndex().filter((n) => n !== name);
      fs.writeFileSync(indexPath, JSON.stringify(entries, null, 2), { mode: 0o600 });
    }
    return removed;
  }

  private listFile(): string[] {
    return this.readFileIndex();
  }

  private ensureFileStoreDir(): void {
    if (!fs.existsSync(this.fileStoreDir)) {
      fs.mkdirSync(this.fileStoreDir, { recursive: true, mode: 0o700 });
    }
  }

  private fileIndexPath(): string {
    return path.join(this.fileStoreDir, 'index.json');
  }

  private fileEntryPath(name: string): string {
    // Sanitize the name into a filesystem-safe filename.
    const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_');
    return path.join(this.fileStoreDir, `${safe}.enc`);
  }

  private readFileIndex(): string[] {
    const indexPath = this.fileIndexPath();
    if (!fs.existsSync(indexPath)) return [];
    try {
      return JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as string[];
    } catch {
      return [];
    }
  }

  /* ------------------------------------------------------------------ *
   * Encryption (AES-256-GCM with PBKDF2 key derivation)
   * ------------------------------------------------------------------ */

  private deriveKey(salt: Buffer): Buffer {
    return crypto.pbkdf2Sync(
      this.machineKeyMaterial,
      salt,
      PBKDF2_ITERATIONS,
      KEY_LENGTH,
      'sha256',
    );
  }

  private encrypt(plaintext: string): Buffer {
    const salt = crypto.randomBytes(SALT_LENGTH);
    const key = this.deriveKey(salt);
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    // Layout: salt || iv || authTag || ciphertext
    return Buffer.concat([salt, iv, authTag, ciphertext]);
  }

  private decrypt(data: Buffer): string {
    const salt = data.subarray(0, SALT_LENGTH);
    const iv = data.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
    const authTag = data.subarray(
      SALT_LENGTH + IV_LENGTH,
      SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH,
    );
    const ciphertext = data.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
    const key = this.deriveKey(salt);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString('utf-8');
  }
}
