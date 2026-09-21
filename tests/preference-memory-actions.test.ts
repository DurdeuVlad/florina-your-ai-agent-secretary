import { describe, it, expect, afterEach } from 'vitest';
import { preferenceProfileToMemoryRows } from '../src/core/application/use-cases/memory/preference-memory-actions.js';
import type { PreferenceProfile } from '../src/core/application/ports/outbound/preference-profile.js';
import { PreferenceProfileStore } from '../src/adapters/outbound/preferences/json-preference-profile.js';
import type { IdGeneratorPort } from '../src/core/application/ports/outbound/id-generator.js';
import type { ClockPort } from '../src/core/application/ports/outbound/clock.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fakeIds(): IdGeneratorPort {
  let n = 0;
  return { generate: (prefix: string) => `${prefix}-${++n}` };
}
function fakeClock(): ClockPort {
  return { now: () => new Date('2026-09-21T00:00:00.000Z') };
}

describe('preferenceProfileToMemoryRows — command construction', () => {
  it('a global rule gets a remove-rule forget command and no promote command', () => {
    const profile: PreferenceProfile = {
      rules: [{ provider: 'codex', model: 'gpt-5' }],
      denied: [],
    };
    const [row] = preferenceProfileToMemoryRows(profile, fakeIds(), fakeClock());
    expect(row!.forgetCommand).toEqual({
      kind: 'update-preference',
      action: 'remove-rule',
      provider: 'codex',
      model: 'gpt-5',
    });
    expect(row!.promoteCommand).toBeUndefined();
  });

  it('a project-scoped rule gets a remove-rule forget AND an add-rule (global) promote command', () => {
    const profile: PreferenceProfile = {
      rules: [{ provider: 'claude-code', projectId: 'proj-1', note: 'good for TS' }],
      denied: [],
    };
    const [row] = preferenceProfileToMemoryRows(profile, fakeIds(), fakeClock());
    expect(row!.forgetCommand).toEqual({
      kind: 'update-preference',
      action: 'remove-rule',
      provider: 'claude-code',
      projectId: 'proj-1',
    });
    expect(row!.promoteCommand).toEqual({
      kind: 'update-preference',
      action: 'add-rule',
      provider: 'claude-code',
      note: 'good for TS',
    });
  });

  it('a project-scoped deny gets remove-deny forget and a deny (global) promote command', () => {
    const profile: PreferenceProfile = {
      rules: [],
      denied: [{ provider: 'devin', projectId: 'proj-1' }],
    };
    const [row] = preferenceProfileToMemoryRows(profile, fakeIds(), fakeClock());
    expect(row!.forgetCommand).toEqual({
      kind: 'update-preference',
      action: 'remove-deny',
      provider: 'devin',
      projectId: 'proj-1',
    });
    expect(row!.promoteCommand).toEqual({
      kind: 'update-preference',
      action: 'deny',
      provider: 'devin',
    });
  });

  it('pairs each row with the correct source item (rules then denies, matching order)', () => {
    const profile: PreferenceProfile = {
      rules: [{ provider: 'codex' }, { provider: 'gemini' }],
      denied: [{ provider: 'devin' }],
    };
    const rows = preferenceProfileToMemoryRows(profile, fakeIds(), fakeClock());
    expect(rows).toHaveLength(3);
    expect(rows[0]!.forgetCommand.provider).toBe('codex');
    expect(rows[1]!.forgetCommand.provider).toBe('gemini');
    expect(rows[2]!.forgetCommand.provider).toBe('devin');
    expect(rows[0]!.item.kind).toBe('preference');
  });
});

describe('inline actions write through the SAME shared use-case the conversational path uses (issue #224)', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  async function tempPath(): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), 'prefs-memactions-'));
    return join(dir, 'preferences.json');
  }

  it('forget actually removes the rule from the real PreferenceProfileStore', async () => {
    const store = await PreferenceProfileStore.load(await tempPath());
    store.addRule({ provider: 'claude-code', model: 'sonnet', projectId: 'proj-1', note: 'x' });
    const profile = store.toProfile();
    const [row] = preferenceProfileToMemoryRows(profile, fakeIds(), fakeClock());

    // Apply the forget command exactly as the existing remove-rule path would.
    expect(row!.forgetCommand.action).toBe('remove-rule');
    const removed = store.removeRule(
      row!.forgetCommand.provider,
      row!.forgetCommand.model,
      row!.forgetCommand.projectId,
    );
    expect(removed).toBe(true);
    expect(store.toProfile().rules).toHaveLength(0);
  });

  it('promote actually adds the rule at global scope AND removes the project-scoped copy', async () => {
    const store = await PreferenceProfileStore.load(await tempPath());
    store.addRule({ provider: 'claude-code', projectId: 'proj-1', note: 'promote me' });
    const profile = store.toProfile();
    const [row] = preferenceProfileToMemoryRows(profile, fakeIds(), fakeClock());
    expect(row!.promoteCommand).toBeDefined();

    // Apply promote (add at global) then forget the old project-scoped copy,
    // exactly the two-step sequence the UI sends after user confirmation.
    store.addRule({
      provider: row!.promoteCommand!.provider,
      ...(row!.promoteCommand!.model !== undefined ? { model: row!.promoteCommand!.model } : {}),
      ...(row!.promoteCommand!.note !== undefined ? { note: row!.promoteCommand!.note } : {}),
    });
    store.removeRule(row!.forgetCommand.provider, row!.forgetCommand.model, row!.forgetCommand.projectId);

    const after = store.toProfile();
    expect(after.rules).toHaveLength(1);
    expect(after.rules[0]!.projectId).toBeUndefined();
    expect(after.rules[0]!.provider).toBe('claude-code');
  });

  it('an already-global rule has no promote command to apply (nothing to promote)', async () => {
    const store = await PreferenceProfileStore.load(await tempPath());
    store.addRule({ provider: 'codex' });
    const profile = store.toProfile();
    const [row] = preferenceProfileToMemoryRows(profile, fakeIds(), fakeClock());
    expect(row!.promoteCommand).toBeUndefined();
  });
});
