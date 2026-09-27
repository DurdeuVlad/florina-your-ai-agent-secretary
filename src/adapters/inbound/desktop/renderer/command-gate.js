/**
 * Shared confirm gate (issue #261, DEC-011): a command element may carry
 * `data-confirm="<prompt text>"`. Cancelling the prompt blocks dispatch
 * entirely — nothing reaches the daemon; confirming sends exactly the
 * encoded command. Uses native `confirm()`, consistent with the existing
 * chat-clear and memory-promote prompts.
 *
 * @param {HTMLElement} el element carrying data-confirm (or not)
 * @param {(prompt: string) => boolean} [confirmFn] injected for tests
 * @returns {boolean} true when the command may dispatch
 */
export function confirmGate(el, confirmFn) {
  const prompt = el && el.dataset ? el.dataset.confirm : undefined;
  if (prompt === undefined || prompt === '') return true;
  const ask = confirmFn ?? ((p) => window.confirm(p));
  return ask(prompt);
}
