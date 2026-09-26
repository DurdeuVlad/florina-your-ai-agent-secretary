/**
 * Preferences screen view tests (issue #128).
 *
 * `renderPrefsScreen` turns the `query-preferences` profile into a
 * RenderTree: readable rule lines, project-scope chips, Edit/Revoke
 * actions, and a separate Denied section.
 */
import { describe, expect, it } from 'vitest';

import {
  encodePrefCommand,
  renderPrefsScreen,
} from '../src/adapters/inbound/desktop/views/prefs-screen.js';
import type { PreferenceProfile } from '../src/core/application/ports/outbound/preference-profile.js';
import type { RenderTree } from '../src/adapters/inbound/desktop/views/view-types.js';
import type { UpdatePreferenceCommand } from '../src/core/application/use-cases/tasks/command-api.js';

function findAll(node: RenderTree | string, tag: string, out: RenderTree[] = []): RenderTree[] {
  if (typeof node === 'string') return out;
  if (node.tag === tag) out.push(node);
  for (const c of node.children ?? []) findAll(c, tag, out);
  return out;
}

function texts(node: RenderTree | string, out: string[] = []): string[] {
  if (typeof node === 'string') {
    out.push(node);
    return out;
  }
  for (const c of node.children ?? []) texts(c, out);
  return out;
}

const profile: PreferenceProfile = {
  rules: [
    {
      provider: 'codex',
      note: 'prefer Codex for heavy lifting',
    },
    {
      provider: 'devin',
      workTypes: ['migration'],
      projectId: 'agent-secretary',
      note: 'use Devin for migrations in this repo',
    },
    {
      provider: 'claude-code',
      model: 'sonnet',
      workTypes: ['ui'],
      note: 'Claude for frontend polish',
    },
  ],
  denied: [
    {
      provider: 'gemini',
      model: 'gemini-2.5-pro',
      projectId: 'payments-api',
      note: 'never pro models on payments-api — cost',
    },
  ],
};

describe('renderPrefsScreen', () => {
  it('renders a card per routing rule with a readable kind line', () => {
    const tree = renderPrefsScreen(profile);
    const cards = findAll(tree, 'PrefCard');
    expect(cards).toHaveLength(4); // 3 rules + 1 deny

    const all = texts(tree).join(' ');
    expect(all).toContain('codex · catch-all');
    expect(all).toContain('devin · work-type: migration');
    expect(all).toContain('claude-code/sonnet · work-type: ui');
    expect(all).toContain('"prefer Codex for heavy lifting"');
  });

  it('tags project-scoped entries with an amber project chip', () => {
    const tree = renderPrefsScreen(profile);
    const chips = findAll(tree, 'Chip');
    const amber = chips.filter((c) => c.props?.['variant'] === 'amber');
    expect(amber).toHaveLength(2); // devin rule + gemini deny
    expect(texts(amber[0]!).join('')).toBe('project:agent-secretary');
    expect(texts(amber[1]!).join('')).toBe('project:payments-api');
    // Global rule carries no chip and is labelled global scope.
    expect(texts(tree).join(' ')).toContain('global scope');
    expect(texts(tree).join(' ')).toContain('project scope');
  });

  it('renders denied entries separately with a red denied chip', () => {
    const tree = renderPrefsScreen(profile);
    const chips = findAll(tree, 'Chip');
    const denied = chips.filter((c) => texts(c).join('') === 'denied');
    expect(denied).toHaveLength(1);
    expect(denied[0]!.props?.['variant']).toBe('red');
    expect(texts(tree).join(' ')).toContain('gemini/gemini-2.5-pro');
  });

  it('encodes Revoke as a typed update-preference remove-rule command', () => {
    const tree = renderPrefsScreen(profile);
    const buttons = findAll(tree, 'Button');
    const revoke = buttons.find((b) => texts(b).join('') === 'Revoke');
    expect(revoke).toBeDefined();
    const cmd = String(revoke!.props?.['command']);
    expect(cmd.startsWith('prefcmd:')).toBe(true);
    const decoded = JSON.parse(
      decodeURIComponent(cmd.slice('prefcmd:'.length)),
    ) as UpdatePreferenceCommand;
    expect(decoded).toEqual({
      kind: 'update-preference',
      action: 'remove-rule',
      provider: 'codex',
    });
  });

  it('encodes Revoke deny with provider/model/project scope', () => {
    const tree = renderPrefsScreen(profile);
    const buttons = findAll(tree, 'Button');
    const revoke = buttons.find((b) => texts(b).join('') === 'Revoke deny');
    const decoded = JSON.parse(
      decodeURIComponent(String(revoke!.props?.['command']).slice('prefcmd:'.length)),
    ) as UpdatePreferenceCommand;
    expect(decoded).toEqual({
      kind: 'update-preference',
      action: 'remove-deny',
      provider: 'gemini',
      model: 'gemini-2.5-pro',
      projectId: 'payments-api',
    });
  });

  it('carries the full rule payload on the Edit verb for the inline form', () => {
    const tree = renderPrefsScreen(profile);
    const buttons = findAll(tree, 'Button');
    const edits = buttons.filter((b) => texts(b).join('') === 'Edit');
    expect(edits).toHaveLength(3); // rules editable, denies revoke-only
    const cmd = String(edits[1]!.props?.['command']);
    expect(cmd.startsWith('prefedit:')).toBe(true);
    const rule = JSON.parse(decodeURIComponent(cmd.slice('prefedit:'.length)));
    expect(rule).toEqual(profile.rules[1]);
  });

  it('renders empty-state hints for a fresh profile', () => {
    const tree = renderPrefsScreen({ rules: [], denied: [] });
    const all = texts(tree).join(' ');
    expect(all).toContain('no routing rules');
    expect(all).toContain('no providers denied');
  });
});

describe('encodePrefCommand', () => {
  it('round-trips an update-preference command through URI encoding', () => {
    const cmd: UpdatePreferenceCommand = {
      kind: 'update-preference',
      action: 'add-rule',
      provider: 'devin',
      note: 'unicode — em-dash ✓ works',
    };
    const encoded = encodePrefCommand(cmd);
    expect(encoded.startsWith('prefcmd:')).toBe(true);
    expect(encoded).not.toContain(' '); // fully URI-safe
    expect(JSON.parse(decodeURIComponent(encoded.slice(8)))).toEqual(cmd);
  });
});
