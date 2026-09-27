/* ================================================================== *
 * tree-renderer DOM projection (issue #265)
 *
 * The renderer is a plain ESM walker over `document`; these tests stub
 * the tiny DOM surface it touches (createElement/createTextNode, class,
 * dataset, style, appendChild) so the icon map and c-* class emission
 * are covered without a browser environment.
 * ================================================================== */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

interface FakeNode {
  kind: 'el' | 'text';
  tagName?: string;
  className: string;
  textContent: string;
  dataset: Record<string, string>;
  style: Record<string, string>;
  children: FakeNode[];
  classList: {
    add(c: string): void;
    toggle(c: string, on: boolean): void;
    remove(c: string): void;
  };
  appendChild(c: FakeNode): void;
  replaceChildren(...cs: FakeNode[]): void;
}

function fakeEl(tagName: string): FakeNode {
  const el: FakeNode = {
    kind: 'el',
    tagName,
    className: '',
    textContent: '',
    dataset: {},
    style: {},
    children: [],
    classList: {
      add: (c) => {
        el.className = [el.className, c].filter(Boolean).join(' ');
      },
      toggle: (c, on) => {
        const set = new Set(el.className.split(' ').filter(Boolean));
        if (on) set.add(c);
        else set.delete(c);
        el.className = [...set].join(' ');
      },
      remove: (c) => {
        el.className = el.className
          .split(' ')
          .filter((x) => x && x !== c)
          .join(' ');
      },
    },
    appendChild: (c) => {
      el.children.push(c);
    },
    replaceChildren: (...cs) => {
      el.children = cs;
    },
  };
  return el;
}

vi.stubGlobal('document', {
  createElement: (tag: string) => fakeEl(tag),
  createTextNode: (t: string): FakeNode => ({
    kind: 'text',
    className: '',
    textContent: t,
    dataset: {},
    style: {},
    children: [],
    classList: { add: () => {}, toggle: () => {}, remove: () => {} },
    appendChild: () => {},
    replaceChildren: () => {},
  }),
});

const { mount } = await import('../src/adapters/inbound/desktop/renderer/tree-renderer.js');

function render(tree: unknown): FakeNode {
  const container = fakeEl('div');
  mount(tree as never, container as never);
  return container.children[0]!;
}

/* Every icon name the views emit — kept in sync with views/*.ts
 * `el('Icon', { name: … })` usage (#265). Some entries additionally
 * arrive via `icon:` props on non-Icon tags (RiskBadge/PttButton/…),
 * which the DOM renderer currently ignores — the map covers them so a
 * future Icon emit never falls back to '·' (#265 review). */
const EMITTED_ICON_NAMES = [
  'flame',
  'arrow-up',
  'minus',
  'arrow-down',
  'search',
  'memory',
  'crown',
  'dot',
  'circle',
  'diff',
  'file',
  'folder',
  'archive',
  'bookmark',
  'chevron-left',
  'chevron-right',
  'pencil',
  'git-pull-request',
  'sparkles',
  'spinner',
  'warning',
  'bolt',
  'waveform',
  'power-off',
  'mic-on',
  'speaker',
  'shield',
  'alert',
  'branch',
  'pause',
  'clock',
  'document',
  'gauge',
  'info',
  'check',
  'check-circle',
];

describe('tree-renderer icon map (#265)', () => {
  it('renders a real glyph for every icon name the views emit', () => {
    for (const name of EMITTED_ICON_NAMES) {
      const el = render({ tag: 'Icon', props: { name }, children: [] });
      expect(el.textContent, `icon "${name}" should not fall back to ·`).not.toBe('·');
      expect(el.textContent.length).toBeGreaterThan(0);
    }
  });

  it('priority icons are pairwise distinct', () => {
    const glyphs = ['flame', 'arrow-up', 'minus', 'arrow-down'].map(
      (name) => render({ tag: 'Icon', props: { name }, children: [] }).textContent,
    );
    expect(new Set(glyphs).size).toBe(4);
  });

  it('unknown names still degrade to ·', () => {
    const el = render({ tag: 'Icon', props: { name: 'no-such-icon' }, children: [] });
    expect(el.textContent).toBe('·');
  });
});

describe('tree-renderer c-* color classes (#265)', () => {
  it('emits c-{color} on non-chip tags', () => {
    const el = render({
      tag: 'KindLabel',
      props: { color: 'red' },
      children: ['Journal gap'],
    });
    expect(el.className.split(' ')).toContain('c-red');
  });

  it('severity names pass through as c-* classes (InspRowTitle)', () => {
    const el = render({
      tag: 'InspRowTitle',
      props: { color: 'error' },
      children: ['boom'],
    });
    expect(el.className.split(' ')).toContain('c-error');
    /* color is class-driven now — no inline style duplication */
    expect(el.style.color ?? '').not.toContain('var(--red)');
  });

  it('does not emit c-* on chip tags — the chip palette class is emitted instead', () => {
    /* Production emits { color, priority } (#265 P2) — the priority name
     * is the class the .chip.<Priority> stylesheet rules key on. */
    const el = render({
      tag: 'PriorityLabel',
      props: { color: 'blue', priority: 'Medium' },
      children: ['Medium'],
    });
    expect(el.className).not.toContain('c-blue');
    expect(el.className.split(' ')).toEqual(expect.arrayContaining(['chip', 'Medium']));
  });

  it('every emitted chip class has a stylesheet rule (tokens.css)', () => {
    /* Classes without rules render as muted gray — the exact regression
     * this issue fixes. Couple the emission to the stylesheet text. */
    const css = readFileSync(
      new URL('../src/adapters/inbound/desktop/renderer/tokens.css', import.meta.url),
      'utf8',
    );
    for (const cls of ['Critical', 'High', 'Medium', 'Low', 'blue', 'slate']) {
      expect(css, `.chip.${cls} should exist`).toContain(`.chip.${cls}`);
    }
    for (const cls of [
      'red',
      'error',
      'amber',
      'warn',
      'green',
      'success',
      'orange',
      'blue',
      'purple',
      'slate',
      'info',
      'gray',
      'yellow',
      'muted',
    ]) {
      expect(css, `.c-${cls} should exist`).toContain(`.c-${cls}`);
    }
  });

  it('Icon color uses the token channel (inline var) in addition to c-*', () => {
    const el = render({ tag: 'Icon', props: { name: 'alert', color: 'amber' }, children: [] });
    expect(el.style.color).toBe('var(--amber)');
  });
});
