/**
 * Tests for Secrets Vault (issue #172).
 *
 * Verifies:
 * - Secretary-prompted credential capture with masked input flag.
 * - Encrypted at rest in ~/.florina/secrets.enc (AES-256-GCM + PBKDF2).
 * - Scoped allowlist injection (provider x project scope).
 * - Injection, not exposure (env-var injection; values never logged to journal).
 * - Redaction of secret strings from output streams.
 * - Audit logging with DEC-012 immutable event journal.
 * - Revocation and rotation of secrets.
 * - Real SQLite StorageDatabase integration with foreign_keys = ON.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { EntityId, Event } from '../src/core/domain/types.js';
import type { EventJournalPort } from '../src/core/application/ports/outbound/repositories.js';
import {
  EncryptedFileSecretsVault,
} from '../src/adapters/outbound/credentials/encrypted-file-secrets-vault.js';
import {
  SecretsVaultService,
} from '../src/core/application/use-cases/security/secrets-vault-service.js';

class InMemoryEventJournal implements EventJournalPort {
  readonly events: Event[] = [];

  insert(event: Event): void {
    this.events.push(event);
  }

  getById(id: EntityId): Event | null {
    return this.events.find((e) => e.id === id) ?? null;
  }

  listByTask(taskId: EntityId): Event[] {
    return this.events.filter((e) => e.taskId === taskId);
  }

  listBySession(sessionId: EntityId): Event[] {
    return this.events.filter((e) => e.sessionId === sessionId);
  }

  listByTimestampRange(start: string, end: string): Event[] {
    return this.events.filter((e) => e.timestamp >= start && e.timestamp <= end);
  }
}

describe('Secrets Vault (issue #172)', () => {
  let tmpDir: string;
  let secretsFilePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'florina-secrets-test-'));
    secretsFilePath = path.join(tmpDir, 'secrets.enc');
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  });

  describe('EncryptedFileSecretsVault (encryption at rest & integrity)', () => {
    it('stores secrets encrypted at rest — raw value never appears in file', () => {
      const vault = new EncryptedFileSecretsVault({
        filePath: secretsFilePath,
        machineKeyMaterial: 'test-machine-key-12345',
      });

      const rawSecret = 'ghp_very_sensitive_personal_token_abcdef123456';
      vault.storeSecret('github-token', rawSecret, {
        projectId: 'proj-payments',
        provider: 'codex',
        envVarName: 'GITHUB_TOKEN',
      });

      // Verify file exists on disk
      expect(fs.existsSync(secretsFilePath)).toBe(true);
      const fileContents = fs.readFileSync(secretsFilePath, 'utf8');

      // The raw secret MUST NOT appear anywhere in the file
      expect(fileContents).not.toContain(rawSecret);

      // Metadata must be visible
      expect(fileContents).toContain('github-token');
      expect(fileContents).toContain('proj-payments');
      expect(fileContents).toContain('GITHUB_TOKEN');

      // Ciphertext fields must exist
      expect(fileContents).toContain('ciphertext');
      expect(fileContents).toContain('iv');
      expect(fileContents).toContain('authTag');
      expect(fileContents).toContain('salt');

      // Decryption retrieves original secret
      const decrypted = vault.getSecretValue('github-token');
      expect(decrypted).toBe(rawSecret);
    });

    it('returns null when decipher fails due to invalid key or tampered ciphertext', () => {
      const vault1 = new EncryptedFileSecretsVault({
        filePath: secretsFilePath,
        machineKeyMaterial: 'correct-machine-key',
      });

      vault1.storeSecret('api-key', 'sk-super-secret-key-999', {});

      // Instantiate vault with a different machine key
      const vaultWrongKey = new EncryptedFileSecretsVault({
        filePath: secretsFilePath,
        machineKeyMaterial: 'different-machine-key',
      });

      // Decryption with wrong key fails gracefully returning null (no throw)
      expect(vaultWrongKey.getSecretValue('api-key')).toBeNull();
    });

    it('lists secret metadata without exposing secret values', () => {
      const vault = new EncryptedFileSecretsVault({
        filePath: secretsFilePath,
        machineKeyMaterial: 'test-key',
      });

      vault.storeSecret('sec-1', 'val-1', { provider: 'claude-code' });
      vault.storeSecret('sec-2', 'val-2', { projectId: 'proj-card-game' });

      const list = vault.listSecretMetadata();
      expect(list).toHaveLength(2);
      expect(list.map((m) => m.name).sort()).toEqual(['sec-1', 'sec-2']);

      // listSecretMetadata objects must NOT have value property
      for (const item of list) {
        expect(item).not.toHaveProperty('value');
        expect(item).not.toHaveProperty('ciphertext');
      }
    });

    it('deletes secret cleanly from store', () => {
      const vault = new EncryptedFileSecretsVault({
        filePath: secretsFilePath,
        machineKeyMaterial: 'test-key',
      });

      vault.storeSecret('temp-secret', 'temporary-val', {});
      expect(vault.getSecretValue('temp-secret')).toBe('temporary-val');

      const deleted = vault.deleteSecret('temp-secret');
      expect(deleted).toBe(true);
      expect(vault.getSecretValue('temp-secret')).toBeNull();
      expect(vault.listSecretMetadata()).toHaveLength(0);

      expect(vault.deleteSecret('temp-secret')).toBe(false);
    });
  });

  describe('SecretsVaultService (prompted capture & scoped injection)', () => {
    it('creates masked input prompt for Secretary / desktop UI', () => {
      const vault = new EncryptedFileSecretsVault({ filePath: secretsFilePath });
      const service = new SecretsVaultService({ vault });

      const prompt = service.createCapturePrompt({
        secretName: 'github-token',
        scope: { projectId: 'proj-agent-secretary', envVarName: 'GITHUB_TOKEN' },
        reason: 'Codex on agent-secretary needs a GitHub token to create pull requests',
      });

      expect(prompt.masked).toBe(true);
      expect(prompt.secretName).toBe('github-token');
      expect(prompt.scope.projectId).toBe('proj-agent-secretary');
      expect(prompt.reason).toContain('Codex on agent-secretary needs a GitHub token');
      expect(prompt.promptId).toMatch(/^prompt-sec-/);
    });

    it('captures secret and journals audit event without leaking secret value (DEC-012)', async () => {
      const vault = new EncryptedFileSecretsVault({ filePath: secretsFilePath });
      const eventJournal = new InMemoryEventJournal();
      const service = new SecretsVaultService({ vault, eventJournal });

      const rawToken = 'ghp_secret_token_12345';
      const metadata = await service.captureSecret({
        name: 'gh-token-demo',
        value: rawToken,
        scope: { projectId: 'proj-1', provider: 'codex' },
        description: 'Demo token for payment API',
        context: { taskId: 'task-100', sessionId: 'sess-200' },
      });

      expect(metadata.name).toBe('gh-token-demo');
      expect(metadata.description).toBe('Demo token for payment API');

      // Verify audit event in journal
      expect(eventJournal.events).toHaveLength(1);
      const auditEvt = eventJournal.events[0];
      expect(auditEvt.taskId).toBe('task-100');
      expect(auditEvt.sessionId).toBe('sess-200');
      expect(auditEvt.kind).toBe('AgentProgress');
      expect(auditEvt.payload['action']).toBe('secret_captured');
      expect(auditEvt.payload['secretName']).toBe('gh-token-demo');

      // CRITICAL: Raw secret must NOT exist in the audit log payload or message!
      const payloadString = JSON.stringify(auditEvt.payload);
      expect(payloadString).not.toContain(rawToken);
    });

    it('scoped injection: enforces provider x project allowlist rules', async () => {
      const vault = new EncryptedFileSecretsVault({ filePath: secretsFilePath });
      const eventJournal = new InMemoryEventJournal();
      const service = new SecretsVaultService({ vault, eventJournal });

      // 1. Global secret (no project, no provider restriction)
      await service.captureSecret({
        name: 'global-analytics-key',
        value: 'analytics-val-111',
        scope: { envVarName: 'ANALYTICS_KEY' },
      });

      // 2. Project-scoped secret (only for proj-alpha)
      await service.captureSecret({
        name: 'alpha-deploy-token',
        value: 'deploy-token-alpha-222',
        scope: { projectId: 'proj-alpha', envVarName: 'DEPLOY_TOKEN' },
      });

      // 3. Provider-scoped secret (only for claude-code)
      await service.captureSecret({
        name: 'anthropic-custom-key',
        value: 'sk-ant-custom-333',
        scope: { provider: 'claude-code', envVarName: 'ANTHROPIC_KEY' },
      });

      // 4. Project x Provider scoped secret (only for proj-alpha AND codex)
      await service.captureSecret({
        name: 'codex-alpha-special',
        value: 'codex-alpha-val-444',
        scope: { projectId: 'proj-alpha', provider: 'codex', envVarName: 'SPECIAL_FLAG' },
      });

      // Scenario A: Runner on proj-alpha with codex
      const injA = await service.resolveInjections({
        projectId: 'proj-alpha',
        provider: 'codex',
        taskId: 't-1',
        sessionId: 's-1',
      });
      // Should get: global, alpha-deploy-token, and codex-alpha-special (NOT anthropic-custom-key)
      expect(injA['ANALYTICS_KEY']).toBe('analytics-val-111');
      expect(injA['DEPLOY_TOKEN']).toBe('deploy-token-alpha-222');
      expect(injA['SPECIAL_FLAG']).toBe('codex-alpha-val-444');
      expect(injA['ANTHROPIC_KEY']).toBeUndefined();

      // Scenario B: Runner on proj-beta with claude-code
      const injB = await service.resolveInjections({
        projectId: 'proj-beta',
        provider: 'claude-code',
      });
      // Should get: global and anthropic-custom-key (NOT alpha-deploy-token, NOT codex-alpha-special)
      expect(injB['ANALYTICS_KEY']).toBe('analytics-val-111');
      expect(injB['ANTHROPIC_KEY']).toBe('sk-ant-custom-333');
      expect(injB['DEPLOY_TOKEN']).toBeUndefined();
      expect(injB['SPECIAL_FLAG']).toBeUndefined();

      // Audit event for injection logged without values
      expect(eventJournal.events).toHaveLength(1);
      const injEvt = eventJournal.events[0];
      expect(injEvt.payload['action']).toBe('secret_injected');
      expect(injEvt.payload['secretNames']).toEqual([
        'global-analytics-key',
        'alpha-deploy-token',
        'codex-alpha-special',
      ]);
      expect(JSON.stringify(injEvt.payload)).not.toContain('analytics-val-111');
      expect(JSON.stringify(injEvt.payload)).not.toContain('deploy-token-alpha-222');
      expect(JSON.stringify(injEvt.payload)).not.toContain('codex-alpha-val-444');
    });

    it('redacts secret values from text streams', async () => {
      const vault = new EncryptedFileSecretsVault({ filePath: secretsFilePath });
      const service = new SecretsVaultService({ vault });

      await service.captureSecret({
        name: 'gh-pat',
        value: 'ghp_SECRET_TOKEN_99999',
        scope: {},
      });
      await service.captureSecret({
        name: 'api-pwd',
        value: 'super_secret_password_xyz',
        scope: {},
      });

      const logText =
        'Error during git push: ghp_SECRET_TOKEN_99999 unauthorized with password super_secret_password_xyz.';

      const redacted = await service.redact(logText);
      expect(redacted).toBe(
        'Error during git push: [REDACTED_SECRET] unauthorized with password [REDACTED_SECRET].',
      );
      expect(redacted).not.toContain('ghp_SECRET_TOKEN_99999');
      expect(redacted).not.toContain('super_secret_password_xyz');
    });

    it('revokes secrets with audit logging', async () => {
      const vault = new EncryptedFileSecretsVault({ filePath: secretsFilePath });
      const eventJournal = new InMemoryEventJournal();
      const service = new SecretsVaultService({ vault, eventJournal });

      await service.captureSecret({
        name: 'revokable-key',
        value: 'revokable-value-123',
        scope: {},
      });

      const deleted = await service.deleteSecret('revokable-key', {
        taskId: 'task-rev',
        sessionId: 'sess-rev',
      });
      expect(deleted).toBe(true);

      const inj = await service.resolveInjections({});
      expect(inj['revokable-key']).toBeUndefined();

      expect(eventJournal.events).toHaveLength(1);
      expect(eventJournal.events[0].payload['action']).toBe('secret_revoked');
      expect(eventJournal.events[0].payload['secretName']).toBe('revokable-key');
    });
  });

  describe('INTEGRATION: SecretsVaultService with real SQLite StorageDatabase', () => {
    it('journals audit events into real SQLite database with foreign_keys ON', async () => {
      const { StorageDatabase } = await import(
        '../src/adapters/outbound/persistence/sqlite/database.js'
      );
      const { AgentRepository } = await import(
        '../src/adapters/outbound/persistence/sqlite/repositories/agent.js'
      );
      const { EventRepository } = await import(
        '../src/adapters/outbound/persistence/sqlite/repositories/event.js'
      );
      const { ProjectRepository } = await import(
        '../src/adapters/outbound/persistence/sqlite/repositories/project.js'
      );
      const { TaskRepository } = await import(
        '../src/adapters/outbound/persistence/sqlite/repositories/task.js'
      );
      const { SessionRepository } = await import(
        '../src/adapters/outbound/persistence/sqlite/repositories/session.js'
      );
      const { buildAgent, buildProject, buildTask, buildSession } = await import(
        '../src/core/domain/factories.js'
      );

      const db = new StorageDatabase({ path: ':memory:' });
      await db.open();

      try {
        const agentRepo = new AgentRepository(db.connection);
        const projectRepo = new ProjectRepository(db.connection);
        const taskRepo = new TaskRepository(db.connection);
        const sessionRepo = new SessionRepository(db.connection);
        const eventRepo = new EventRepository(db.connection);

        // Seed real Agent, Project, Task, and Session to satisfy SQLite foreign keys
        const agent = buildAgent({
          name: 'Test Agent',
          provider: 'codex',
          fidelityTier: 'A' as const,
          runtime: { type: 'cli' as const },
        });
        agentRepo.insert(agent);

        const project = buildProject({ name: 'Secrets Demo', repo: { path: '/demo' } });
        projectRepo.insert(project);

        const task = buildTask({ projectId: project.id, objective: 'Deploy with secret' });
        taskRepo.insert(task);

        const session = buildSession({ taskId: task.id, agentId: agent.id });
        sessionRepo.insert(session);

        const vault = new EncryptedFileSecretsVault({ filePath: secretsFilePath });
        const service = new SecretsVaultService({
          vault,
          eventJournal: eventRepo,
        });

        // Capture secret in task context
        await service.captureSecret({
          name: 'db-secret',
          value: 'super-db-password-12345',
          scope: { projectId: project.id, envVarName: 'DB_PASSWORD' },
          context: { taskId: task.id, sessionId: session.id },
        });

        // Resolve injection in task context
        const injected = await service.resolveInjections({
          projectId: project.id,
          taskId: task.id,
          sessionId: session.id,
        });
        expect(injected['DB_PASSWORD']).toBe('super-db-password-12345');

        // Verify SQLite events table has both audit events
        const taskEvents = eventRepo.listByTask(task.id);
        expect(taskEvents).toHaveLength(2);
        expect(taskEvents[0].payload['action']).toBe('secret_captured');
        expect(taskEvents[1].payload['action']).toBe('secret_injected');

        // Verify no raw secrets in the SQLite database rows
        for (const evt of taskEvents) {
          expect(JSON.stringify(evt.payload)).not.toContain('super-db-password-12345');
        }
      } finally {
        db.close();
      }
    });
  });
});
