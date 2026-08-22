import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CredentialBroker } from '../src/daemon/credential-broker.js';
import {
  CapabilityBroker,
  type ActionExecutor,
  type ActionContext,
} from '../src/daemon/capability-broker.js';
import { StorageDatabase, EventRepository } from '../src/storage/index.js';
import {
  AdapterFidelityTier,
  CapabilityType,
  CapabilityRiskLevel,
  buildAgent,
  buildProject,
  buildSession,
  buildTask,
} from '../src/domain/index.js';
import type { Policy } from '../src/domain/policy.js';

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Create a unique temp directory for the file-based credential store. */
function tempCredentialDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asec-cred-'));
  return path.join(dir, 'credentials');
}

/** A permissive policy that allows createPR actions. */
function allowCreatePrPolicy(): Policy {
  return {
    projectId: 'proj-1',
    allowAutoApproval: true,
    projectRules: [
      {
        name: 'allow-create-pr',
        capabilityPattern: [CapabilityType.CreatePR],
        riskLevels: [CapabilityRiskLevel.Medium],
        autoApprove: { maxRiskLevel: CapabilityRiskLevel.Medium, oneTimeOnly: false },
        decision: 'allow',
      },
    ],
    taskRules: [],
  };
}

/** A deny policy that denies all createPR actions. */
function denyCreatePrPolicy(): Policy {
  return {
    projectId: 'proj-1',
    allowAutoApproval: false,
    projectRules: [
      {
        name: 'deny-create-pr',
        capabilityPattern: [CapabilityType.CreatePR],
        decision: 'deny',
      },
    ],
    taskRules: [],
  };
}

/** An empty policy (no rules -> escalate). */
function emptyPolicy(): Policy {
  return {
    projectId: 'proj-1',
    allowAutoApproval: false,
    projectRules: [],
    taskRules: [],
  };
}

/** Set up a full DB chain (project -> task -> agent -> session) for FK-safe event inserts. */
function setupDbChain() {
  const db = new StorageDatabase({ path: ':memory:' });
  db.open();
  const raw = db.connection;
  const events = new EventRepository(raw);

  const project = buildProject({ name: 'test-project', repo: { path: '/repo' } });
  const projectRepo = new (class {
    insert(p: typeof project) {
      raw
        .prepare(
          'INSERT INTO projects (id, name, repo, policies, capsule_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
        )
        .run(
          p.id,
          p.name,
          JSON.stringify(p.repo),
          JSON.stringify(p.policies),
          p.capsuleId,
          p.createdAt,
          p.updatedAt,
        );
    }
  })();
  projectRepo.insert(project);

  const task = buildTask({ projectId: project.id, objective: 'Test task' });
  raw
    .prepare(
      'INSERT INTO tasks (id, project_id, objective, state, agent_ids, session_ids, deliverable_ids, attention_item_ids, capsule_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      task.id,
      task.projectId,
      task.objective,
      task.state,
      JSON.stringify(task.agentIds),
      JSON.stringify(task.sessionIds),
      JSON.stringify(task.deliverableIds),
      JSON.stringify(task.attentionItemIds),
      task.capsuleId,
      task.createdAt,
      task.updatedAt,
    );

  const agent = buildAgent({
    name: 'Codex',
    provider: 'codex',
    fidelityTier: AdapterFidelityTier.A,
    runtime: { kind: 'app-server' },
  });
  raw
    .prepare(
      'INSERT INTO agents (id, name, provider, fidelity_tier, runtime, created_at) VALUES (?,?,?,?,?,?)',
    )
    .run(
      agent.id,
      agent.name,
      agent.provider,
      agent.fidelityTier,
      JSON.stringify(agent.runtime),
      agent.createdAt,
    );

  const session = buildSession({ taskId: task.id, agentId: agent.id });
  raw
    .prepare(
      'INSERT INTO sessions (id, task_id, agent_id, status, started_at, event_ids, deliverable_ids, capsule_id) VALUES (?,?,?,?,?,?,?,?)',
    )
    .run(
      session.id,
      session.taskId,
      session.agentId,
      session.status,
      session.startedAt,
      JSON.stringify(session.eventIds),
      JSON.stringify(session.deliverableIds),
      session.capsuleId,
    );

  return { db, raw, events, projectId: project.id, taskId: task.id, sessionId: session.id };
}

/** Build an ActionContext for tests. */
function testContext(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    projectId: 'proj-1',
    taskId: 'task-1',
    sessionId: 'sess-1',
    task: 'Create PR for feature',
    agent: 'codex',
    destination: 'github.com/org/repo',
    workingDir: '/repo',
    ...overrides,
  };
}

/** An executor that captures the credential it receives (for test assertions). */
function capturingExecutor(): {
  executor: ActionExecutor;
  receivedCredential: string | null;
} {
  let receivedCredential: string | null = null;
  const executor: ActionExecutor = (credentialValue) => {
    receivedCredential = credentialValue;
    return {
      success: true,
      message: 'PR created successfully',
      data: { prUrl: 'https://github.com/org/repo/pull/42' },
    };
  };
  return {
    executor,
    get receivedCredential() {
      return receivedCredential;
    },
  };
}

/* ------------------------------------------------------------------ *
 * CredentialBroker — file-based fallback
 * ------------------------------------------------------------------ */

describe('CredentialBroker (file-based fallback)', () => {
  let credDir: string;
  let broker: CredentialBroker;

  beforeEach(() => {
    credDir = tempCredentialDir();
    broker = new CredentialBroker({
      backend: 'file',
      fileStoreDir: credDir,
      machineKeyMaterial: 'test-machine-key',
    });
  });

  afterEach(() => {
    const parent = path.dirname(credDir);
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it('stores and retrieves a credential correctly', () => {
    broker.storeCredential('github-token', 'ghp_abc123', { description: 'GitHub PAT' });
    const value = broker.retrieveCredential('github-token');
    expect(value).toBe('ghp_abc123');
  });

  it('returns null when retrieving a non-existent credential', () => {
    expect(broker.retrieveCredential('nonexistent')).toBeNull();
  });

  it('deleteCredential removes the credential', () => {
    broker.storeCredential('cloud-key', 'AKIA-xyz', { description: 'AWS key' });
    expect(broker.retrieveCredential('cloud-key')).toBe('AKIA-xyz');

    const removed = broker.deleteCredential('cloud-key');
    expect(removed).toBe(true);
    expect(broker.retrieveCredential('cloud-key')).toBeNull();
  });

  it('deleteCredential returns false when credential does not exist', () => {
    expect(broker.deleteCredential('never-stored')).toBe(false);
  });

  it('listCredentials returns names only, never values', () => {
    broker.storeCredential('github-token', 'ghp_secret1');
    broker.storeCredential('aws-key', 'AKIA_secret2');
    broker.storeCredential('npm-token', 'npm_secret3');

    const names = broker.listCredentials();
    expect(names).toContain('github-token');
    expect(names).toContain('aws-key');
    expect(names).toContain('npm-token');
    // Ensure no secret values leak through the list.
    const namesJson = JSON.stringify(names);
    expect(namesJson).not.toContain('ghp_secret1');
    expect(namesJson).not.toContain('AKIA_secret2');
    expect(namesJson).not.toContain('npm_secret3');
  });

  it('overwrites a credential when stored again with the same name', () => {
    broker.storeCredential('github-token', 'old-value');
    broker.storeCredential('github-token', 'new-value');
    expect(broker.retrieveCredential('github-token')).toBe('new-value');
  });

  it('persists credentials across broker instances (same file store + key material)', () => {
    broker.storeCredential('persistent-token', 'ghp_persist');
    // Create a new broker pointing at the same directory and key material.
    const broker2 = new CredentialBroker({
      backend: 'file',
      fileStoreDir: credDir,
      machineKeyMaterial: 'test-machine-key',
    });
    expect(broker2.retrieveCredential('persistent-token')).toBe('ghp_persist');
    expect(broker2.listCredentials()).toContain('persistent-token');
  });

  it('encrypted file does not contain plaintext credential value', () => {
    broker.storeCredential('github-token', 'ghp_plaintext_secret');
    // Find the encrypted entry file.
    const files = fs.readdirSync(credDir).filter((f) => f.endsWith('.enc'));
    expect(files.length).toBeGreaterThan(0);
    const content = fs.readFileSync(path.join(credDir, files[0]), 'utf-8');
    expect(content).not.toContain('ghp_plaintext_secret');
  });

  it('throws when storing with an empty name', () => {
    expect(() => broker.storeCredential('', 'value')).toThrow('empty');
  });

  it('throws when retrieving with an empty name', () => {
    expect(() => broker.retrieveCredential('')).toThrow('empty');
  });
});

/* ------------------------------------------------------------------ *
 * CapabilityBroker — policy enforcement, credential isolation, audit log
 * ------------------------------------------------------------------ */

describe('CapabilityBroker (DEC-022)', () => {
  let credDir: string;
  let credentials: CredentialBroker;
  let chain: ReturnType<typeof setupDbChain>;
  let broker: CapabilityBroker;
  let capture: ReturnType<typeof capturingExecutor>;

  beforeEach(() => {
    credDir = tempCredentialDir();
    credentials = new CredentialBroker({
      backend: 'file',
      fileStoreDir: credDir,
      machineKeyMaterial: 'test-machine-key',
    });
    chain = setupDbChain();
    capture = capturingExecutor();

    broker = new CapabilityBroker({
      credentials,
      events: chain.events,
      policyResolver: () => allowCreatePrPolicy(),
    });
    broker.registerAction({
      action: 'create_pr',
      capability: CapabilityType.CreatePR,
      riskLevel: CapabilityRiskLevel.Medium,
      executor: capture.executor,
    });
  });

  afterEach(() => {
    chain.db.close();
    const parent = path.dirname(credDir);
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it('executes an allowed action and returns the result (not the credential)', async () => {
    credentials.storeCredential('github-token', 'ghp_super_secret');

    const outcome = await broker.executeAction(
      'create_pr',
      { branch: 'feature-x', title: 'Add feature X' },
      'github-token',
      testContext({ projectId: chain.projectId, taskId: chain.taskId, sessionId: chain.sessionId }),
    );

    expect(outcome.decision).toBe('allow');
    expect(outcome.credentialUsed).toBe(true);
    expect(outcome.result).toBeDefined();
    expect(outcome.result!.success).toBe(true);
    expect(outcome.result!.data!.prUrl).toBe('https://github.com/org/repo/pull/42');
    // The executor received the credential internally.
    expect(capture.receivedCredential).toBe('ghp_super_secret');
  });

  it('workers never receive raw credentials — only action results', async () => {
    credentials.storeCredential('github-token', 'ghp_never_expose_this');

    const outcome = await broker.executeAction(
      'create_pr',
      {},
      'github-token',
      testContext({ projectId: chain.projectId, taskId: chain.taskId, sessionId: chain.sessionId }),
    );

    // The outcome object must not contain the raw credential anywhere.
    const outcomeJson = JSON.stringify(outcome);
    expect(outcomeJson).not.toContain('ghp_never_expose_this');
  });

  it('denies the action when policy says deny — credential is never accessed', async () => {
    credentials.storeCredential('github-token', 'ghp_should_not_be_used');

    const denyBroker = new CapabilityBroker({
      credentials,
      events: chain.events,
      policyResolver: () => denyCreatePrPolicy(),
    });
    denyBroker.registerAction({
      action: 'create_pr',
      capability: CapabilityType.CreatePR,
      riskLevel: CapabilityRiskLevel.Medium,
      executor: capture.executor,
    });

    const outcome = await denyBroker.executeAction(
      'create_pr',
      {},
      'github-token',
      testContext({ projectId: chain.projectId, taskId: chain.taskId, sessionId: chain.sessionId }),
    );

    expect(outcome.decision).toBe('deny');
    expect(outcome.credentialUsed).toBe(false);
    expect(outcome.result).toBeUndefined();
    // The executor was never called, so it never received the credential.
    expect(capture.receivedCredential).toBeNull();
  });

  it('escalates when no policy rule matches (never silently allow)', async () => {
    credentials.storeCredential('github-token', 'ghp_value');

    const escalateBroker = new CapabilityBroker({
      credentials,
      events: chain.events,
      policyResolver: () => emptyPolicy(),
    });
    escalateBroker.registerAction({
      action: 'create_pr',
      capability: CapabilityType.CreatePR,
      riskLevel: CapabilityRiskLevel.Medium,
      executor: capture.executor,
    });

    const outcome = await escalateBroker.executeAction(
      'create_pr',
      {},
      'github-token',
      testContext({ projectId: chain.projectId, taskId: chain.taskId, sessionId: chain.sessionId }),
    );

    expect(outcome.decision).toBe('escalate');
    expect(outcome.credentialUsed).toBe(false);
    expect(outcome.result).toBeUndefined();
  });

  it('logs every credential use to the event journal', async () => {
    credentials.storeCredential('github-token', 'ghp_audited');

    const outcome = await broker.executeAction(
      'create_pr',
      {},
      'github-token',
      testContext({ projectId: chain.projectId, taskId: chain.taskId, sessionId: chain.sessionId }),
    );

    expect(outcome.eventId).toBeDefined();

    // Verify the event was journaled.
    const events = chain.events.listByTask(chain.taskId);
    const loggedEvent = events.find((e) => e.id === outcome.eventId);
    expect(loggedEvent).toBeDefined();
    expect(loggedEvent!.kind).toBe('ToolFinished');
    expect(loggedEvent!.payload['action']).toBe('create_pr');
    expect(loggedEvent!.payload['credentialName']).toBe('github-token');
    expect(loggedEvent!.payload['success']).toBe(true);
    // The event payload must not contain the raw credential value.
    expect(JSON.stringify(loggedEvent!.payload)).not.toContain('ghp_audited');
  });

  it('logs a failure event when the credential is not found', async () => {
    // Do not store the credential — simulate missing credential.

    const outcome = await broker.executeAction(
      'create_pr',
      {},
      'missing-credential',
      testContext({ projectId: chain.projectId, taskId: chain.taskId, sessionId: chain.sessionId }),
    );

    expect(outcome.decision).toBe('allow'); // policy allowed
    expect(outcome.credentialUsed).toBe(false);
    expect(outcome.result!.success).toBe(false);
    expect(outcome.eventId).toBeDefined();

    const events = chain.events.listByTask(chain.taskId);
    const loggedEvent = events.find((e) => e.id === outcome.eventId);
    expect(loggedEvent).toBeDefined();
    expect(loggedEvent!.payload['success']).toBe(false);
    expect(loggedEvent!.payload['credentialName']).toBe('missing-credential');
  });

  it('logs a failure event when the executor throws', async () => {
    credentials.storeCredential('github-token', 'ghp_will_fail');

    const throwingBroker = new CapabilityBroker({
      credentials,
      events: chain.events,
      policyResolver: () => allowCreatePrPolicy(),
    });
    throwingBroker.registerAction({
      action: 'create_pr',
      capability: CapabilityType.CreatePR,
      riskLevel: CapabilityRiskLevel.Medium,
      executor: () => {
        throw new Error('GitHub API rate limited');
      },
    });

    const outcome = await throwingBroker.executeAction(
      'create_pr',
      {},
      'github-token',
      testContext({ projectId: chain.projectId, taskId: chain.taskId, sessionId: chain.sessionId }),
    );

    expect(outcome.result!.success).toBe(false);
    expect(outcome.result!.message).toContain('rate limited');
    expect(outcome.eventId).toBeDefined();

    const events = chain.events.listByTask(chain.taskId);
    const loggedEvent = events.find((e) => e.id === outcome.eventId);
    expect(loggedEvent!.payload['success']).toBe(false);
  });

  it('denies unknown actions (no executor registered)', async () => {
    credentials.storeCredential('github-token', 'ghp_value');

    const outcome = await broker.executeAction(
      'unknown_action',
      {},
      'github-token',
      testContext({ projectId: chain.projectId, taskId: chain.taskId, sessionId: chain.sessionId }),
    );

    expect(outcome.decision).toBe('deny');
    expect(outcome.credentialUsed).toBe(false);
    expect(outcome.result).toBeUndefined();
  });

  it('supports async executors', async () => {
    credentials.storeCredential('github-token', 'ghp_async');

    const asyncBroker = new CapabilityBroker({
      credentials,
      events: chain.events,
      policyResolver: () => allowCreatePrPolicy(),
    });
    asyncBroker.registerAction({
      action: 'create_pr',
      capability: CapabilityType.CreatePR,
      riskLevel: CapabilityRiskLevel.Medium,
      executor: async (cred) => {
        // Simulate async work.
        await new Promise((r) => setTimeout(r, 10));
        return {
          success: true,
          message: `PR created with credential length ${cred.length}`,
        };
      },
    });

    const outcome = await asyncBroker.executeAction(
      'create_pr',
      {},
      'github-token',
      testContext({ projectId: chain.projectId, taskId: chain.taskId, sessionId: chain.sessionId }),
    );

    expect(outcome.result!.success).toBe(true);
    expect(outcome.result!.message).toContain('length 9');
  });
});
