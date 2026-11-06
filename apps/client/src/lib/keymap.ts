import * as Atom from "effect/reactivity/Atom";
import { read, write } from "@/lib/atoms/registry";

/** Which modifier the app's shortcuts take: ⌘ on a Mac, Ctrl elsewhere — and Ctrl on a
 * Mac too once `agentboard.pcKeybindings` is on. Kept free of settings I/O so the key
 * paths stay importable anywhere; `main.tsx` feeds it. The native half, for the chords
 * Cocoa takes before a page sees them, is `crates-tauri/tt-app/src/macos_keys.rs`. */

export const IS_MAC = typeof navigator !== "undefined" && /mac/i.test(navigator.platform ?? "");

/** Whether the PC keymap is on — `null` until the first settings read lands,
 * since a workbench booted on a guess reboots. */
export const pcKeymapAtom = Atom.make<boolean | null>(IS_MAC ? null : false).pipe(Atom.keepAlive);

/** ⌘ is the shortcut modifier. */
export function macKeymap(): boolean {
  return IS_MAC && read(pcKeymapAtom) !== true;
}

export function setPcKeybindings(on: boolean): void {
  if (IS_MAC) write(pcKeymapAtom, on);
}

/** A field that owns its own editing keys. */
export function isTextField(el: HTMLElement): boolean {
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}

export function isInTerminal(el: HTMLElement): boolean {
  return el.closest("[data-term-host]") != null;
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

/** Mac only. Ctrl+V needs nothing here: the native monitor hands it over as ⌘V, the only paste a
 * page cannot start itself. A terminal's keys stay its own. */
export function installPcEditKeys(): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (macKeymap() || e.defaultPrevented) return;
    const el = e.target instanceof HTMLElement ? e.target : null;
    if (!el || isInTerminal(el)) return;
    const command = pcEditCommand(
      e,
      isTextField(el),
      !(window.getSelection()?.isCollapsed ?? true),
    );
    if (command && document.execCommand(command)) e.preventDefault();
  };
  window.addEventListener("keydown", onKeyDown);
  return () => window.removeEventListener("keydown", onKeyDown);
}
