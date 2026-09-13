import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import {
  PreferenceProfileStore,
  PreferenceProfileError,
  validatePreferenceProfile,
} from '../src/daemon/preference-profile.js';
import { createPreferenceTool } from '../src/florina/preference-tool.js';
import { ToolRegistry } from '../src/florina/tool-registry.js';
import { CapacityRouter } from '../src/daemon/capacity-router.js';
import { QuotaLedger } from '../src/daemon/quota-ledger.js';
import { writeFile } from 'node:fs/promises';

let dir: string | undefined;
afterEach(async () => {
  if (dir !== undefined) {
    await rm(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

async function tempPath(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'prefs-'));
  return join(dir, 'preferences.json');
}

describe('PreferenceProfileStore', () => {
  it('seeds an empty profile for a missing file', async () => {
    const store = await PreferenceProfileStore.load(await tempPath());
    expect(store.toProfile()).toEqual({ rules: [], denied: [] });
  });

  it('round-trips rules and denies through disk', async () => {
    const path = await tempPath();
    const store = await PreferenceProfileStore.load(path);
    store.addRule({ provider: 'claude-code', model: 'sonnet' });
    store.addRule({ provider: 'claude-code', model: 'haiku', workTypes: ['reading'] });
    store.addDeny({ provider: 'claude-code', model: 'opus' });
    await store.save();

    const reloaded = await PreferenceProfileStore.load(path);
    const profile = reloaded.toProfile();
    expect(profile.rules).toHaveLength(2);
    expect(profile.denied).toEqual([{ provider: 'claude-code', model: 'opus' }]);
    const raw = JSON.parse(await readFile(path, 'utf8')) as { rules: unknown[] };
    expect(raw.rules).toHaveLength(2);
  });

  it('rejects malformed files and mutations', async () => {
    const path = await tempPath();
    await writeFile(path, '{"rules": "nope"}', 'utf8');
    await expect(PreferenceProfileStore.load(path)).rejects.toBeInstanceOf(
      PreferenceProfileError,
    );
    await writeFile(path, 'not json', 'utf8');
    await expect(PreferenceProfileStore.load(path)).rejects.toBeInstanceOf(
      PreferenceProfileError,
    );
    expect(() => validatePreferenceProfile({ rules: [], denied: [{ provider: '' }] })).toThrow(
      PreferenceProfileError,
    );
  });

  it('dedupes denies and supports removal', async () => {
    const store = await PreferenceProfileStore.load(await tempPath());
    store.addDeny({ provider: 'claude-code', model: 'opus' });
    store.addDeny({ provider: 'claude-code', model: 'opus' });
    expect(store.toProfile().denied).toHaveLength(1);
    expect(store.removeDeny('claude-code', 'opus')).toBe(true);
    expect(store.removeDeny('claude-code', 'opus')).toBe(false);
  });
});

describe('preference tool', () => {
  it('drives the store through the tool interface', async () => {
    const path = await tempPath();
    const store = await PreferenceProfileStore.load(path);
    const registry = new ToolRegistry();
    registry.register(createPreferenceTool(store));

    const deny = await registry.execute('preference', {
      action: 'deny',
      provider: 'claude-code',
      model: 'opus',
    });
    expect(deny.isError).toBeUndefined();
    expect(store.toProfile().denied[0].model).toBe('opus');

    const rule = await registry.execute('preference', {
      action: 'add-rule',
      provider: 'claude-code',
      model: 'haiku',
      workTypes: ['reading'],
    });
    expect(rule.isError).toBeUndefined();

    const list = await registry.execute('preference', { action: 'list' });
    expect(list.content).toContain('claude-code');
    expect(list.content).toContain('deny');

    // Tool writes are durable — a fresh load sees the learned preferences.
    const reloaded = await PreferenceProfileStore.load(path);
    expect(reloaded.toProfile().denied[0].model).toBe('opus');
    expect(reloaded.toProfile().rules[0].model).toBe('haiku');

    const missing = await registry.execute('preference', {
      action: 'remove-rule',
      provider: 'nonexistent',
    });
    expect(missing.isError).toBe(true);
  });

  it('learned preferences change router decisions', async () => {
    const store = await PreferenceProfileStore.load(await tempPath());
    const registry = new ToolRegistry();
    registry.register(createPreferenceTool(store));

    // Learn: never Opus on Claude; Haiku for reading work; Codex catch-all.
    await registry.execute('preference', {
      action: 'deny',
      provider: 'claude-code',
      model: 'opus',
    });
    await registry.execute('preference', {
      action: 'add-rule',
      provider: 'claude-code',
      model: 'haiku',
      workTypes: ['reading'],
    });
    await registry.execute('preference', { action: 'add-rule', provider: 'codex' });

    const router = new CapacityRouter({
      ledger: new QuotaLedger(),
      profile: store.toProfile(),
    });

    const reading = router.route({ workType: 'reading' });
    expect(reading).toMatchObject({ kind: 'routed', provider: 'claude-code', model: 'haiku' });
    const generic = router.route({});
    expect(generic).toMatchObject({ kind: 'routed', provider: 'codex' });
  });
});
