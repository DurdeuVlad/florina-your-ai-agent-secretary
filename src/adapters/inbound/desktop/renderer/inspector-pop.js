/**
 * Esc-on-Work pop order (issue #266): the inspector drill-down pops one
 * level per press — clear the row selection, then step back a column,
 * then leave Work for Attention. A single Esc never leaps two levels;
 * with nothing open it keeps the old "inspector → back to inbox"
 * recovery (DG-01 §4).
 *
 * Drill state lives outside this module (`inspSel`/`inspCol` in app.js)
 * — the pure decision is extracted for the keyboard-sequence test.
 *
 * @param {{ sel: number, col: number, inspectorActive: boolean }} state
 *   sel: selected row index in the focused column (-1 = none)
 *   col: focused inspector column (0 tasks, 1 timeline, 2 detail)
 *   inspectorActive: whether the Tasks sub-panel (the drill surface) is
 *   the visible Work tab — on Fleet/Ideas Esc leaves directly instead of
 *   clearing state the user can't see.
 * @returns {'clear-row' | 'back-col' | 'leave-view'}
 */
export function escPopAction(state) {
  if (!state.inspectorActive) return 'leave-view';
  if (state.sel >= 0) return 'clear-row';
  if (state.col > 0) return 'back-col';
  return 'leave-view';
}
