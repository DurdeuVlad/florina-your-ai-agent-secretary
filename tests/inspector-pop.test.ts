/* ================================================================== *
 * Esc pop order on the Work inspector (issue #266)
 *
 * One Esc press pops exactly one drill level — row selection first,
 * then column focus, then leave Work for Attention. The decision is
 * pure so the sequence is covered without booting Electron.
 * ================================================================== */
import { describe, expect, it } from 'vitest';
import { escPopAction } from '../src/adapters/inbound/desktop/renderer/inspector-pop.js';

describe('escPopAction (#266)', () => {
  it('clears a row selection first, whatever column is focused', () => {
    expect(escPopAction({ sel: 3, col: 0, inspectorActive: true })).toBe('clear-row');
    expect(escPopAction({ sel: 0, col: 1, inspectorActive: true })).toBe('clear-row');
    expect(escPopAction({ sel: 7, col: 2, inspectorActive: true })).toBe('clear-row');
  });

  it('steps back a column once nothing is selected', () => {
    expect(escPopAction({ sel: -1, col: 2, inspectorActive: true })).toBe('back-col');
    expect(escPopAction({ sel: -1, col: 1, inspectorActive: true })).toBe('back-col');
  });

  it('leaves for Attention only when the drill is fully collapsed', () => {
    expect(escPopAction({ sel: -1, col: 0, inspectorActive: true })).toBe('leave-view');
  });

  it('never leaps two levels in one press', () => {
    /* selection + deep column → still just clears the selection */
    expect(escPopAction({ sel: 0, col: 2, inspectorActive: true })).toBe('clear-row');
    /* column > 0 + selection → still just clears the selection */
    expect(escPopAction({ sel: 1, col: 1, inspectorActive: true })).toBe('clear-row');
  });

  it('leaves directly on non-inspector Work tabs (Fleet/Ideas)', () => {
    /* clearing invisible drill state on a hidden panel would look like
     * Esc did nothing — pop straight out instead */
    expect(escPopAction({ sel: 2, col: 2, inspectorActive: false })).toBe('leave-view');
    expect(escPopAction({ sel: -1, col: 0, inspectorActive: false })).toBe('leave-view');
  });

  it('covers the full pop sequence: select → column → leave', () => {
    /* three presses walk: clear-row → back-col → leave-view */
    const steps = [
      escPopAction({ sel: 4, col: 1, inspectorActive: true }),
      escPopAction({ sel: -1, col: 1, inspectorActive: true }),
      escPopAction({ sel: -1, col: 0, inspectorActive: true }),
    ];
    expect(steps).toEqual(['clear-row', 'back-col', 'leave-view']);
  });
});
