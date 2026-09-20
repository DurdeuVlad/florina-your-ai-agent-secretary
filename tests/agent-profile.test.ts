import { describe, it, expect } from 'vitest';
import { buildTask } from '../src/core/domain/index.js';
import { BUILT_IN_MANAGER_PROFILE_ID, type AgentProfile } from '../src/core/domain/agent-profile.js';
import type { AgentProfileStorePort } from '../src/core/application/ports/outbound/agent-profile-store.js';

class InMemoryAgentProfileStore implements AgentProfileStorePort {
  private readonly rows = new Map<string, AgentProfile>();
  insert(profile: AgentProfile): void {
    this.rows.set(profile.id, profile);
  }
  getById(id: string): AgentProfile | null {
    return this.rows.get(id) ?? null;
  }
  listAll(): readonly AgentProfile[] {
    return [...this.rows.values()];
  }
  update(profile: AgentProfile): void {
    this.rows.set(profile.id, profile);
  }
}

describe('AgentProfile', () => {
  it('round-trips through an in-memory store', () => {
    const store = new InMemoryAgentProfileStore();
    const profile: AgentProfile = {
      id: 'profile-1',
      name: 'Security reviewer',
      role: 'Reviews auth/credential-adjacent diffs before merge',
      toolScope: ['read_file', 'grep'],
      defaultProvider: 'claude-code',
      defaultModel: 'opus',
      createdAt: '2026-09-21T00:00:00.000Z',
      updatedAt: '2026-09-21T00:00:00.000Z',
    };
    store.insert(profile);
    expect(store.getById('profile-1')).toEqual(profile);
    expect(store.listAll()).toHaveLength(1);
  });

  it('returns null for an unknown id', () => {
    expect(new InMemoryAgentProfileStore().getById('nope')).toBeNull();
  });
});

describe('Task.agentProfileId', () => {
  it('is undefined by default — no forced migration for existing callers', () => {
    const task = buildTask({ projectId: 'proj-1', objective: 'do the thing' });
    expect(task.agentProfileId).toBeUndefined();
  });

  it('can reference an Agent Profile, including the built-in manager profile', () => {
    const task = buildTask({
      projectId: 'proj-1',
      objective: 'coordinate the workstream',
      agentProfileId: BUILT_IN_MANAGER_PROFILE_ID,
    });
    expect(task.agentProfileId).toBe(BUILT_IN_MANAGER_PROFILE_ID);
  });
});
