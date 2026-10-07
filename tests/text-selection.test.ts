/**
 * Regression tests for issue #331 — text is selectable and copyable.
 *
 * DG-01 requires the raw daemon error (and by extension chat, journal,
 * and card text) to be "readable/copyable" (`desktop-app.ts`,
 * `docs/UX_GUIDELINES.md`). The renderer instead had a global
 * `-webkit-user-select: none` with zero content re-enables and no
 * context/Edit menu — nothing was copyable. These tests pin the CSS
 * contract (chrome stays click-first, view content selects) and the
 * context-menu behavior (editing roles only, never Inspect/Reload).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import {
  installCopyContextMenu,
  type CopyMenuHost,
  type CopyMenuParams,
} from '../src/adapters/inbound/desktop/electron/context-menu.js';

const INDEX_HTML = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../src/adapters/inbound/desktop/renderer/index.html',
);

describe('renderer selection CSS (issue #331)', () => {
  const source = readFileSync(INDEX_HTML, 'utf8');

  it('keeps app chrome click-first — body still disables selection', () => {
    const body = source.match(/\bbody\s*\{([^}]*)\}/)?.[1];
    expect(body).not.toBeNull();
    expect(body).toContain('user-select: none');
  });

  it('re-enables text selection on view content and editable fields', () => {
    const rule = source.match(/\.view,\s*input,\s*textarea\s*\{([^}]*)\}/)?.[1];
    expect(rule, 'missing .view/input/textarea selection rule').not.toBeNull();
    expect(rule).toContain('user-select: text');
  });

  it('keeps interactive controls inside views unselectable', () => {
    const rule = source.match(
      /\.view button,\s*\.view select,\s*\.view label,\s*\.view \.worksubtab\s*\{([^}]*)\}/,
    )?.[1];
    expect(rule, 'missing interactive-controls exclusion rule').not.toBeNull();
    expect(rule).toContain('user-select: none');
  });
});

describe('installCopyContextMenu (issue #331)', () => {
  function harness() {
    let listener: ((event: unknown, params: CopyMenuParams) => void) | null = null;
    const contents: CopyMenuHost = {
      on: (_event, cb) => {
        listener = cb;
        return undefined;
      },
    };
    const built: { role?: string }[][] = [];
    const popup = vi.fn();
    installCopyContextMenu(contents, (items) => {
      built.push(items);
      return { popup };
    });
    return { fire: (p: CopyMenuParams) => listener?.(null, p), built, popup };
  }

  const editable = (flags: { canCut?: boolean; canCopy?: boolean; canPaste?: boolean }) => ({
    isEditable: true,
    selectionText: '',
    editFlags: flags,
  });

  it('offers Copy on a plain text selection', () => {
    const { fire, built, popup } = harness();
    fire({ isEditable: false, selectionText: 'hello', editFlags: { canCopy: true } });
    expect(built).toEqual([[{ role: 'copy' }]]);
    expect(popup).toHaveBeenCalledOnce();
  });

  it('offers cut/copy/paste/select-all on editable fields, filtered by editFlags', () => {
    const { fire, built } = harness();
    fire(editable({ canCut: true, canCopy: true, canPaste: true }));
    expect(built[0]).toEqual([
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
    ]);
  });

  it('omits verbs the field cannot perform but keeps Select All', () => {
    const { fire, built } = harness();
    fire(editable({ canCopy: true }));
    expect(built[0]).toEqual([{ role: 'copy' }, { role: 'selectAll' }]);
  });

  it('does not pop a menu when there is nothing to copy', () => {
    const { fire, built, popup } = harness();
    fire({ isEditable: false, selectionText: '', editFlags: { canCopy: false } });
    fire({ isEditable: false, selectionText: '   ' });
    expect(built).toEqual([]);
    expect(popup).not.toHaveBeenCalled();
  });
});
