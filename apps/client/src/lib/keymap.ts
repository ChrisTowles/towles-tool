/** Which modifier the app's shortcuts take: ⌘ on a Mac, Ctrl elsewhere — and Ctrl on a
 * Mac too once `agentboard.pcKeybindings` is on. Kept free of settings I/O so the key
 * paths stay importable anywhere; `main.tsx` feeds it. The native half, for the chords
 * Cocoa takes before a page sees them, is `crates-tauri/tt-app/src/macos_keys.rs`. */

export const IS_MAC = typeof navigator !== "undefined" && /mac/i.test(navigator.platform ?? "");

let pcKeybindings = false;
const listeners = new Set<() => void>();

/** ⌘ is the shortcut modifier. */
export function macKeymap(): boolean {
  return IS_MAC && !pcKeybindings;
}

/** Only a Mac can opt in; anywhere else this already is the keymap. */
export function pcKeymapOnMac(): boolean {
  return IS_MAC && pcKeybindings;
}

export function setPcKeybindings(on: boolean): void {
  if (on === pcKeybindings) return;
  pcKeybindings = on;
  for (const listener of listeners) listener();
}

export function subscribeKeymap(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

type EditKeyEvent = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">;

const EDIT_COMMANDS: Record<string, string> = {
  c: "copy",
  x: "cut",
  a: "selectAll",
  z: "undo",
  y: "redo",
};

/** The editing command a PC-style Ctrl chord means, where a Mac text field would read
 * it as an Emacs motion (⌃A is line start) or nothing at all. */
export function pcEditCommand(e: EditKeyEvent, editable: boolean, selected: boolean) {
  if (!e.ctrlKey || e.metaKey || e.altKey) return null;
  const key = e.key.toLowerCase();
  if (e.shiftKey) return editable && key === "z" ? "redo" : null;
  const command = EDIT_COMMANDS[key];
  if (!command) return null;
  return editable || (command === "copy" && selected) ? command : null;
}

/** Ctrl+V needs nothing here: the native monitor hands it over as ⌘V, the only paste a
 * page cannot start itself. A terminal's keys stay its own. */
export function installPcEditKeys(): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (!pcKeymapOnMac() || e.defaultPrevented) return;
    const el = e.target instanceof HTMLElement ? e.target : null;
    if (!el || el.closest("[data-term-host]")) return;
    const editable = el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA";
    const command = pcEditCommand(e, editable, !(window.getSelection()?.isCollapsed ?? true));
    if (command && document.execCommand(command)) e.preventDefault();
  };
  window.addEventListener("keydown", onKeyDown);
  return () => window.removeEventListener("keydown", onKeyDown);
}
