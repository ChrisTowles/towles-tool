/** Release the shell's claim on the keyboard when focus moves off its pane. */
export function blurTerminal() {
  const el = document.activeElement;
  if (el instanceof HTMLElement && el.closest("[data-term-host]")) el.blur();
}

/** Someone is typing in a shell — the one thing Next up must never interrupt. */
export function terminalFocused(): boolean {
  const el = document.activeElement;
  return (
    document.hasFocus() && el instanceof HTMLElement && el.closest("[data-term-host]") !== null
  );
}
