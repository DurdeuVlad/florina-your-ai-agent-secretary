/**
 * `preference` tool — how the Secretary writes learned routing preferences
 * as durable User-scope memories (DEC-020/029, issue #65).
 *
 * When the user states a preference in conversation ("never Opus on
 * Claude", "Haiku for repeatable reading"), the Secretary records it here:
 * a routing rule or a model-level deny. Denies are machine-enforced by the
 * daemon — a prompt preference can never be prompt-engineered around.
 * Every mutation is persisted immediately so learned preferences survive
 * restarts.
 */
import {
  PreferenceProfileError,
  type PreferenceProfilePort,
} from '../../ports/outbound/preference-profile.js';
import type { ToolDefinition, ToolResult } from './tool-registry.js';

function render(store: PreferenceProfilePort): string {
  const { rules, denied } = store.toProfile();
  const lines = [
    ...rules.map(
      (r, i) =>
        `rule[${i}]: ${r.provider}${r.model !== undefined ? `/${r.model}` : ''}` +
        (r.workTypes !== undefined ? ` for work=[${r.workTypes.join(',')}]` : ' (catch-all)'),
    ),
    ...denied.map(
      (d) => `deny: ${d.provider}${d.model !== undefined ? `/${d.model}` : ''}`,
    ),
  ];
  return lines.length === 0 ? 'no preferences recorded' : lines.join('\n');
}

/**
 * Build the `preference` tool bound to `store`.
 *
 * Actions: `list`, `add-rule {provider, model?, workTypes?}`,
 * `deny {provider, model?}`, `remove-rule {provider, model?}`,
 * `remove-deny {provider, model?}`.
 */
export function createPreferenceTool(store: PreferenceProfilePort): ToolDefinition {
  return {
    name: 'preference',
    description:
      'Record and inspect the user\'s durable provider/model routing preferences. ' +
      'Use when the user states a preference ("never use Opus", "Codex for heavy lifting") ' +
      'so it persists as a User-scope memory rather than a one-off instruction.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'add-rule', 'deny', 'remove-rule', 'remove-deny'],
        },
        provider: { type: 'string', description: 'Provider id (e.g. claude-code, devin).' },
        model: { type: 'string', description: 'Model pin (optional).' },
        workTypes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Work-type tags the rule applies to (optional).',
        },
      },
      required: ['action'],
    },
    async execute(args): Promise<ToolResult> {
      const action = args['action'];
      const provider = args['provider'];
      const model = args['model'];
      const workTypes = args['workTypes'];
      const needProvider = (): string => {
        if (typeof provider !== 'string' || provider.length === 0) {
          throw new PreferenceProfileError('"provider" is required');
        }
        return provider;
      };
      if (typeof model !== 'undefined' && typeof model !== 'string') {
        throw new PreferenceProfileError('"model" must be a string');
      }
      if (
        workTypes !== undefined &&
        (!Array.isArray(workTypes) || workTypes.some((w) => typeof w !== 'string'))
      ) {
        throw new PreferenceProfileError('"workTypes" must be an array of strings');
      }

      switch (action) {
        case 'list':
          return { content: render(store) };
        case 'add-rule':
          store.addRule({
            provider: needProvider(),
            model: model as string | undefined,
            workTypes: workTypes as string[] | undefined,
          });
          await store.save();
          return { content: `rule added\n${render(store)}` };
        case 'deny':
          store.addDeny({ provider: needProvider(), model: model as string | undefined });
          await store.save();
          return { content: `deny added\n${render(store)}` };
        case 'remove-rule': {
          const removed = store.removeRule(needProvider(), model as string | undefined);
          if (!removed) {
            return { content: 'no matching rule', isError: true };
          }
          await store.save();
          return { content: `rule removed\n${render(store)}` };
        }
        case 'remove-deny': {
          const removed = store.removeDeny(needProvider(), model as string | undefined);
          if (!removed) {
            return { content: 'no matching deny', isError: true };
          }
          await store.save();
          return { content: `deny removed\n${render(store)}` };
        }
        default:
          throw new PreferenceProfileError(`unknown action "${String(action)}"`);
      }
    },
  };
}
