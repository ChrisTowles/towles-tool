import { useEffect, useMemo, useState, type RefObject } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { keyboardScore, latestKeyboardScore, type KeyboardScore } from "@/lib/keyboard-score";
import { uiAction } from "@/lib/ui-action";
import { SCREENS, type ScreenId } from "@/lib/screens";
import { useLiveSettingRef } from "./settings";

// Data-driven shortcut registry: one definition per binding drives matching, the on-screen
// hints, and the `?` help overlay. Bindings never fire from editable targets (inputs,
// `[data-term-host]` terminals) unless they set `allowInEditable` — the terminal yields
// those chords via `matchesEditableOverride`, gated by agentboard.shortcutsWorkInTerminal.

/** A shortcut's scope: app-wide or one screen. Typed over {@link ScreenId} so a scoped
 * shortcut on a new screen needs no edit here. */
export type ShortcutScope = "global" | ScreenId;

/** A parsed key spec: modifiers + one main key. `mod` = ⌘ on mac, Ctrl elsewhere. */
type KeySpec = {
  mod: boolean;
  shift: boolean;
  alt: boolean;
  /** `KeyboardEvent.key`, lowercased ("d", ",", "?"). */
  key: string;
};

export type Shortcut = {
  id: string;
  scope: ShortcutScope;
  /** Human-readable spec, validated at definition time: "mod+shift+w", "?". */
  keys: string;
  /** What it does — shown in the help overlay. */
  description: string;
  /** Shown muted in the overlay when the action needs context. */
  when?: string;
  allowInEditable?: boolean;
  /** Matched like any other but omitted from the `?` overlay (collapses near-identical runs). */
  hideInHelp?: boolean;
  spec: KeySpec;
};

const MODIFIER_TOKENS = new Set(["mod", "shift", "alt"]);

/** Parse + validate at module-eval time — a typo'd binding fails the build, not matching. */
function parseKeys(keys: string): KeySpec {
  const tokens = keys.toLowerCase().split("+");
  const spec: KeySpec = { mod: false, shift: false, alt: false, key: "" };
  for (const t of tokens) {
    if (MODIFIER_TOKENS.has(t)) {
      spec[t as "mod" | "shift" | "alt"] = true;
    } else if (t.length > 0 && !spec.key) {
      spec.key = t;
    } else {
      throw new Error(`Invalid shortcut spec "${keys}": bad token "${t}"`);
    }
  }
  if (!spec.key) throw new Error(`Invalid shortcut spec "${keys}": no main key`);
  return spec;
}

function defineShortcuts(defs: Omit<Shortcut, "spec">[]): Record<string, Shortcut> {
  const out: Record<string, Shortcut> = {};
  for (const d of defs) {
    if (out[d.id]) throw new Error(`Duplicate shortcut id "${d.id}"`);
    out[d.id] = { ...d, spec: parseKeys(d.keys) };
  }
  return out;
}

/** The one registry. `global` is always active; a screen scope only while that tab is
 * shown (screens stay mounted when hidden — without the gate they'd fire everywhere). */
export const SHORTCUTS = defineShortcuts([
  { id: "palette", scope: "global", keys: "mod+k", description: "Command palette" },
  { id: "settings", scope: "global", keys: "mod+,", description: "Settings" },
  { id: "sidebar", scope: "global", keys: "mod+b", description: "Collapse sidebar to icons" },
  { id: "quicklog", scope: "global", keys: "mod+j", description: "Quick journal log" },
  {
    id: "zen",
    scope: "global",
    keys: "mod+shift+f",
    description: "Zen focus mode — hide chrome (Escape exits)",
  },
  {
    id: "close-tab",
    scope: "global",
    keys: "mod+w",
    description: "Close the current tab",
    when: "more than one tab is open",
  },
  // Jump to the Nth open tab — one binding per digit, validated like any other; the help
  // overlay lists only the first.
  ...Array.from({ length: 9 }, (_, i) => ({
    id: `tab-${i + 1}`,
    scope: "global" as const,
    keys: `mod+${i + 1}`,
    description: i === 0 ? "Jump to tab 1–9" : `Jump to tab ${i + 1}`,
    hideInHelp: i > 0,
  })),
  {
    id: "next-tab",
    scope: "global",
    keys: "mod+]",
    description: "Cycle to the next tab",
    when: "more than one tab is open",
  },
  {
    id: "prev-tab",
    scope: "global",
    keys: "mod+[",
    description: "Cycle to the previous tab",
    when: "more than one tab is open",
  },
  { id: "help", scope: "global", keys: "?", description: "Keyboard shortcuts (this overlay)" },
  {
    id: "board-filter",
    scope: "board",
    keys: "/",
    description: "Focus the todo filter",
  },
  {
    id: "ab-new-session",
    scope: "agentboard",
    keys: "mod+d",
    description: "New session in the focused folder",
    when: "a folder is focused",
  },
  {
    id: "ab-new-task",
    scope: "agentboard",
    keys: "mod+shift+d",
    description: "New task — goal, issues, branch",
    when: "a folder is focused",
    allowInEditable: true,
  },
  {
    id: "ab-remove-task",
    scope: "agentboard",
    keys: "mod+shift+delete",
    description: "Delete the focused worktree (confirms first)",
    when: "a worktree is focused",
    allowInEditable: true,
  },
  {
    // One id, both dialogs in the delete flow — the handler picks whichever is open (a
    // second binding on the same chord would never fire). Deliberately the same mod+shift
    // as the delete itself: one chord held down, Delete then Enter (then Enter again).
    id: "ab-confirm-close-worktree",
    scope: "agentboard",
    keys: "mod+shift+enter",
    description: "Confirm the delete-worktree dialog — again to delete anyway if it's blocked",
    when: "a delete-worktree dialog is open",
    hideInHelp: true,
  },
  {
    // Whichever pane holds the cursor takes it — a session pane loses its shell, a view pane
    // just leaves the window. One chord for "kill this tile", so the answer never depends on
    // what kind of thing you happen to be looking at.
    id: "ab-close-pane",
    scope: "agentboard",
    keys: "mod+shift+w",
    description: "Close the focused pane (a session pane kills its shell)",
    when: "a pane is focused",
    allowInEditable: true,
  },
  {
    id: "ab-toggle-diff",
    scope: "agentboard",
    keys: "mod+shift+g",
    description: "Open the focused folder's diff pane",
    when: "a folder is focused",
    allowInEditable: true,
  },
  {
    id: "ab-toggle-files",
    scope: "agentboard",
    keys: "mod+shift+e",
    description: "Open the focused folder's files pane",
    when: "a folder is focused",
    allowInEditable: true,
  },
  {
    id: "ab-toggle-rail",
    scope: "agentboard",
    keys: "mod+shift+b",
    description: "Collapse the folder rail to icons (and back)",
    allowInEditable: true,
  },
  {
    id: "ab-jump-next",
    scope: "agentboard",
    keys: "mod+shift+n",
    description: "Jump to next session needing you",
    allowInEditable: true,
  },
  {
    id: "ab-jump-prev",
    scope: "agentboard",
    keys: "mod+shift+p",
    description: "Jump to previous session needing you",
    allowInEditable: true,
  },
  {
    id: "ab-focus-up",
    scope: "agentboard",
    keys: "mod+shift+arrowup",
    description: "Move focus up — climb out of panes/windows, then previous session",
    allowInEditable: true,
  },
  {
    id: "ab-focus-down",
    scope: "agentboard",
    keys: "mod+shift+arrowdown",
    description: "Move focus down — next session, or on through the panes",
    allowInEditable: true,
  },
  {
    // Same action as ab-focus-up, for bracket muscle memory — hidden to avoid a duplicate
    // help-overlay row.
    id: "ab-focus-up-bracket",
    scope: "agentboard",
    keys: "mod+shift+[",
    description: "Move focus up — climb out of panes/windows, then previous session",
    allowInEditable: true,
    hideInHelp: true,
  },
  {
    id: "ab-focus-down-bracket",
    scope: "agentboard",
    keys: "mod+shift+]",
    description: "Move focus down — next session, or on through the panes",
    allowInEditable: true,
    hideInHelp: true,
  },
  {
    id: "ab-focus-left",
    scope: "agentboard",
    keys: "mod+shift+arrowleft",
    description: "Focus the previous pane or window — off the edge, back to the rail",
    allowInEditable: true,
  },
  {
    id: "ab-focus-right",
    scope: "agentboard",
    keys: "mod+shift+arrowright",
    description: "Focus the next pane or window — from the rail, into the panes",
    allowInEditable: true,
  },
  {
    // Bare Enter on purpose — zero ceremony. Safe because the dispatcher only calls it when
    // nothing editable owns the keystroke, and the handler declines (returns `false`) when
    // a button/link/dialog has DOM focus so the browser's native Enter runs.
    id: "ab-focus-terminal",
    scope: "agentboard",
    keys: "enter",
    description: "Jump into the focused folder's first session and start typing",
    when: "a folder is focused",
  },
  {
    id: "ab-split-session",
    scope: "agentboard",
    keys: "mod+shift+s",
    description: "Add another session as a pane in this window",
    when: "a folder is focused",
    allowInEditable: true,
  },
  {
    id: "ab-new-terminal-right",
    scope: "agentboard",
    keys: "mod+shift+o",
    description: "Open a new terminal to the right",
    when: "a folder is focused",
    allowInEditable: true,
  },
  {
    // Matched by the focused TerminalView itself (`matchesShortcut`), not window-level:
    // only the terminal owning the keystroke may open its overlay. Ctrl+F stays with the shell.
    id: "term-search",
    scope: "agentboard",
    keys: "mod+shift+f",
    description: "Search terminal scrollback",
    when: "a terminal is focused",
  },
]);

/** True on macOS — chooses ⌘ vs Ctrl for the modifier key across the app. */
export const IS_MAC = typeof navigator !== "undefined" && /mac/i.test(navigator.platform ?? "");

/** Keycaps for multi-char key names. Symbols only where the glyph is reliably in the UI
 * font — ⌦ renders as tofu in the shortcut-coach toast, so Delete/Enter spell out. */
const KEYCAP_LABELS: Record<string, string> = {
  backspace: "⌫",
  delete: "Del",
  enter: "Enter",
};

/** Per-platform keycap tokens for a shortcut id: ["⌘","⇧","W"] on mac,
 * ["Ctrl","Shift","W"] elsewhere. Feed to <Kbd> or join for a title. */
export function shortcutKeys(id: string): string[] {
  const s = SHORTCUTS[id];
  if (!s) throw new Error(`Unknown shortcut id "${id}"`);
  const caps: string[] = [];
  if (s.spec.mod) caps.push(IS_MAC ? "⌘" : "Ctrl");
  if (s.spec.shift) caps.push(IS_MAC ? "⇧" : "Shift");
  if (s.spec.alt) caps.push(IS_MAC ? "⌥" : "Alt");
  caps.push(
    KEYCAP_LABELS[s.spec.key] ?? (s.spec.key.length === 1 ? s.spec.key.toUpperCase() : s.spec.key),
  );
  return caps;
}

/** One string for tooltips/titles: "⌘⇧W" on mac, "Ctrl+Shift+W" elsewhere. */
export function shortcutHint(id: string): string {
  return shortcutKeys(id).join(IS_MAC ? "" : "+");
}

/** The binding as an `aria-keyshortcuts` value ("Meta+Shift+W") — UI Events key names,
 * not {@link shortcutHint}'s keycaps, which a screen reader can't announce. */
export function shortcutAria(id: string): string {
  const s = SHORTCUTS[id];
  if (!s) throw new Error(`Unknown shortcut id "${id}"`);
  const parts: string[] = [];
  if (s.spec.mod) parts.push(IS_MAC ? "Meta" : "Control");
  if (s.spec.shift) parts.push("Shift");
  if (s.spec.alt) parts.push("Alt");
  parts.push(s.spec.key.length === 1 ? s.spec.key.toUpperCase() : s.spec.key);
  return parts.join("+");
}

/** A label with its binding appended — `"Collapse the rail (⌘⇧B)"`. The one way a control
 * that duplicates a shortcut names its keys (no hardcoded chords); pairs with `mouseAction`
 * in `lib/shortcut-coach.ts`, which scores the click as a passed-up keystroke. */
export function withHint(label: string, id: string): string {
  return `${label} (${shortcutHint(id)})`;
}

/** The `mod+N` binding that jumps to `id`, or null: digits map to *open tabs* in order, so
 * a screen not open (or past the ninth) has no key to show. Pure over the tab list so the
 * sidebar's two variants share one unit-testable answer. */
export function tabShortcutId(openTabs: readonly ScreenId[], id: ScreenId): string | null {
  const i = openTabs.indexOf(id);
  return i >= 0 && i < 9 ? `tab-${i + 1}` : null;
}

/** Whether a keydown matches a registry shortcut — for components (the terminal view) that
 * own their keystrokes and match locally instead of via the window-level listener. */
export function matchesShortcut(id: string, e: KeyboardEvent): boolean {
  const s = SHORTCUTS[id];
  if (!s) throw new Error(`Unknown shortcut id "${id}"`);
  return matches(s.spec, e);
}

/** True when a keydown matches an `allowInEditable` shortcut — lets the terminal's own
 * keydown handler recognize a board-wide action and yield it to the window-level listener
 * instead of sending it to the shell as a control byte. */
export function matchesEditableOverride(e: KeyboardEvent): boolean {
  for (const s of Object.values(SHORTCUTS)) {
    if (s.allowInEditable && matches(s.spec, e)) return true;
  }
  return false;
}

/** Built-in default for `agentboard.shortcutsWorkInTerminal` — on, matching tt-config. */
export const DEFAULT_SHORTCUTS_WORK_IN_TERMINAL = true;

/** The `agentboard.shortcutsWorkInTerminal` preference in a ref, readable live from keydown
 * handlers without re-subscribing — re-reads on `SETTINGS_SAVED_EVENT` and window focus,
 * `useLiveSettingRef`'s shared policy. */
export function useShortcutsWorkInTerminal(): RefObject<boolean> {
  return useLiveSettingRef(
    (s) => s.agentboard?.shortcutsWorkInTerminal,
    DEFAULT_SHORTCUTS_WORK_IN_TERMINAL,
  );
}

function matches(spec: KeySpec, e: KeyboardEvent): boolean {
  const mod = IS_MAC ? e.metaKey : e.ctrlKey;
  // `?` arrives as key "?" with shiftKey set — compare shift only for
  // modifier-style specs, where shift is a deliberate chord component.
  const shiftOk = spec.mod ? e.shiftKey === spec.shift : true;
  return mod === spec.mod && shiftOk && e.altKey === spec.alt && e.key.toLowerCase() === spec.key;
}

/** True when the event originated somewhere that owns its own keystrokes: an input,
 * contenteditable, or a `[data-term-host]` terminal — where Ctrl+D is EOF. */
function isEditableTarget(e: KeyboardEvent): boolean {
  const el = e.target;
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return el.closest("[data-term-host]") != null;
}

// Bind handlers by shortcut id: a match runs the handler, eats the event, and records
// `shortcut.<id>`; `enabled` gates the whole set (scope activation for screens that stay
// mounted while hidden). A handler may return `false` to decline — that skips both
// preventDefault and the record, so native key handling (a focused button's Enter) runs.
export function useShortcuts(
  handlers: Partial<Record<string, () => boolean | void>>,
  screen: ScreenId,
  enabled = true,
): void {
  const workInTerminalRef = useShortcutsWorkInTerminal();
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      for (const [id, handler] of Object.entries(handlers)) {
        if (!handler) continue;
        const s = SHORTCUTS[id];
        if (!s) throw new Error(`Unknown shortcut id "${id}"`);
        if (!matches(s.spec, e)) continue;
        const allowed = s.allowInEditable && workInTerminalRef.current;
        if (isEditableTarget(e) && !allowed) return;
        if (handler() === false) return;
        e.preventDefault();
        uiAction(`shortcut.${id}`, screen);
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handlers, screen, enabled, workInTerminalRef]);
}

/** Human title for a scope — a screen scope reuses that screen's registered title. */
export function scopeTitle(scope: ShortcutScope): string {
  return scope === "global" ? "Everywhere" : SCREENS[scope].title;
}

/** Per-binding usage for the help overlay — fetched when the sheet opens, seeded from the
 * status bar's last poll so counts are there on first paint. */
function useShortcutUsage(open: boolean): Map<string, number> {
  const [score, setScore] = useState<KeyboardScore | null>(latestKeyboardScore);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void keyboardScore().then((r) => {
      if (alive && r.isOk()) setScore(r.value);
    });
    return () => {
      alive = false;
    };
  }, [open]);
  return useMemo(() => new Map((score?.byShortcut ?? []).map((s) => [s.id, s.shortcut])), [score]);
}

/** The `?` help overlay: every binding grouped by scope (inactive scopes muted, so the
 * sheet doubles as discovery), each row carrying its 14-day usage count — the list you
 * open to look something up also shows which bindings you never use. */
export function ShortcutHelp({
  open,
  onOpenChange,
  activeScopes,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeScopes: ShortcutScope[];
}) {
  const usage = useShortcutUsage(open);
  const byScope = useMemo(() => {
    const m = new Map<ShortcutScope, Shortcut[]>();
    for (const s of Object.values(SHORTCUTS)) {
      if (s.hideInHelp) continue;
      const list = m.get(s.scope) ?? [];
      list.push(s);
      m.set(s.scope, list);
    }
    return m;
  }, []);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Capped + scrollable: an uncapped sheet runs off both ends of a laptop window. */}
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {[...byScope.entries()].map(([scope, shortcuts]) => {
            const active = activeScopes.includes(scope);
            return (
              <div key={scope} className={active ? undefined : "opacity-50"}>
                <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {scopeTitle(scope)}
                  {!active && " — inactive here"}
                </div>
                <div className="flex flex-col gap-1">
                  {shortcuts.map((s) => (
                    <div key={s.id} className="flex items-baseline gap-3 text-sm">
                      <KbdGroup className="w-28 shrink-0 justify-start">
                        {shortcutKeys(s.id).map((cap) => (
                          <Kbd key={cap}>{cap}</Kbd>
                        ))}
                      </KbdGroup>
                      <span className="min-w-0 flex-1">
                        {s.description}
                        {s.when && <span className="text-muted-foreground"> — {s.when}</span>}
                      </span>
                      <UsageTally used={usage.get(s.id) ?? 0} />
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** How many times a binding fired in the scored window — deliberately not scolding at
 * zero: "not used yet" reads as an invitation, a red badge as a demerit. */
function UsageTally({ used }: { used: number }) {
  return (
    <span
      className={`w-20 shrink-0 text-right font-mono text-[11px] tabular-nums ${
        used > 0 ? "text-muted-foreground" : "text-muted-foreground/50"
      }`}
    >
      {used > 0 ? `${used}× / 14d` : "not used yet"}
    </span>
  );
}

/** Owns the `?` binding + the overlay's open state. Mounted once in App. */
export function ShortcutHelpHost({
  activeScopes,
  screen,
}: {
  activeScopes: ShortcutScope[];
  screen: ScreenId;
}) {
  const [open, setOpen] = useState(false);
  useShortcuts(
    useMemo(() => ({ help: () => setOpen(true) }), []),
    screen,
  );
  return <ShortcutHelp open={open} onOpenChange={setOpen} activeScopes={activeScopes} />;
}
