import { useMagicKeys, whenever } from "@vueuse/core";

interface ShortcutHandlers {
  newCard?: () => void;
  refresh?: () => void;
  closePanel?: () => void;
  dictate?: () => void;
  archive?: () => void;
  retry?: () => void;
  focusSearch?: () => void;
}

export function useKeyboardShortcuts(handlers: ShortcutHandlers) {
  const keys = useMagicKeys();

  // n — New card
  whenever(keys.n, () => {
    if (isInputFocused()) return;
    handlers.newCard?.();
  });

  // r — Refresh
  whenever(keys.r, () => {
    if (isInputFocused()) return;
    handlers.refresh?.();
  });

  // Escape — Close panel
  whenever(keys.escape, () => {
    handlers.closePanel?.();
  });

  // d — Dictate
  whenever(keys.d, () => {
    if (isInputFocused()) return;
    handlers.dictate?.();
  });

  // a — Archive selected card
  whenever(keys.a, () => {
    if (isInputFocused()) return;
    handlers.archive?.();
  });

  // x — Retry failed card
  whenever(keys.x, () => {
    if (isInputFocused()) return;
    handlers.retry?.();
  });

  // / — Focus search (future)
  whenever(keys["/"], () => {
    if (isInputFocused()) return;
    handlers.focusSearch?.();
  });
}

/** Don't fire shortcuts when typing in inputs */
function isInputFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  return (
    tag === "input" ||
    tag === "textarea" ||
    tag === "select" ||
    (el as HTMLElement).isContentEditable
  );
}
