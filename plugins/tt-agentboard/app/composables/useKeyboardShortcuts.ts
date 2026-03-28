import { useMagicKeys, whenever } from "@vueuse/core";

export interface ShortcutDef {
  key: string;
  label: string;
  description: string;
  category: "general" | "card" | "navigation" | "tabs";
}

export const SHORTCUT_REGISTRY: ShortcutDef[] = [
  // General
  { key: "?", label: "?", description: "Show keyboard shortcuts", category: "general" },
  { key: "n", label: "N", description: "Create new card", category: "general" },
  { key: "r", label: "R", description: "Refresh board", category: "general" },
  { key: "d", label: "D", description: "Toggle voice dictation", category: "general" },
  { key: "/", label: "/", description: "Focus search", category: "general" },
  { key: "Escape", label: "Esc", description: "Close panel / modal", category: "general" },

  // Card actions
  { key: "a", label: "A", description: "Archive card (when review ready)", category: "card" },
  { key: "x", label: "X", description: "Retry card (when failed)", category: "card" },
  { key: "s", label: "S", description: "Start agent on card", category: "card" },
  { key: "o", label: "O", description: "Open card full page", category: "card" },
  { key: "Backspace", label: "⌫", description: "Delete card", category: "card" },

  // Navigation
  { key: "j", label: "J", description: "Select next card", category: "navigation" },
  { key: "k", label: "K", description: "Select previous card", category: "navigation" },

  // Tabs (when card panel is open)
  { key: "1", label: "1", description: "Activity tab", category: "tabs" },
  { key: "2", label: "2", description: "Terminal tab", category: "tabs" },
  { key: "3", label: "3", description: "Diff tab", category: "tabs" },
  { key: "4", label: "4", description: "Events tab", category: "tabs" },
];

export const SHORTCUT_CATEGORIES: Record<string, string> = {
  general: "General",
  card: "Card Actions",
  navigation: "Navigation",
  tabs: "Tabs",
};

interface ShortcutHandlers {
  newCard?: () => void;
  refresh?: () => void;
  closePanel?: () => void;
  dictate?: () => void;
  archive?: () => void;
  retry?: () => void;
  focusSearch?: () => void;
  toggleHelp?: () => void;
  startAgent?: () => void;
  openFullPage?: () => void;
  deleteCard?: () => void;
  nextCard?: () => void;
  prevCard?: () => void;
  switchTab?: (tab: "activity" | "terminal" | "diff" | "events") => void;
}

export function useKeyboardShortcuts(handlers: ShortcutHandlers) {
  const keys = useMagicKeys();

  // ? — Show help
  whenever(keys["shift+/"], () => {
    handlers.toggleHelp?.();
  });

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

  // s — Start agent
  whenever(keys.s, () => {
    if (isInputFocused()) return;
    handlers.startAgent?.();
  });

  // o — Open full page
  whenever(keys.o, () => {
    if (isInputFocused()) return;
    handlers.openFullPage?.();
  });

  // Backspace — Delete card
  whenever(keys.backspace, () => {
    if (isInputFocused()) return;
    handlers.deleteCard?.();
  });

  // j — Next card
  whenever(keys.j, () => {
    if (isInputFocused()) return;
    handlers.nextCard?.();
  });

  // k — Previous card
  whenever(keys.k, () => {
    if (isInputFocused()) return;
    handlers.prevCard?.();
  });

  // 1-4 — Switch tabs
  whenever(keys["1"], () => {
    if (isInputFocused()) return;
    handlers.switchTab?.("activity");
  });
  whenever(keys["2"], () => {
    if (isInputFocused()) return;
    handlers.switchTab?.("terminal");
  });
  whenever(keys["3"], () => {
    if (isInputFocused()) return;
    handlers.switchTab?.("diff");
  });
  whenever(keys["4"], () => {
    if (isInputFocused()) return;
    handlers.switchTab?.("events");
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
