import { z } from "zod";
import { invoke } from "@/lib/tauri";

/** A files pane's lock and wrap toggles, one record per checkout dir, stored
 * beside the other instance state (`ide.rs`, `editor-prefs.json`). Deliberately
 * not what was open: a pane mounts on the Explorer, never on a file no one
 * asked for. */

const EditorCheckoutPrefsSchema = z.object({
  v: z.literal(1),
  wordWrap: z.boolean(),
  editable: z.boolean(),
});

export type EditorCheckoutPrefs = z.infer<typeof EditorCheckoutPrefsSchema>;

/** Null on any failure — a stale or foreign shape just starts fresh. */
export async function loadEditorCheckoutPrefs(dir: string): Promise<EditorCheckoutPrefs | null> {
  const raw = await invoke<string | null>("ide_prefs_load", { dir });
  if (raw.isErr() || raw.value == null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.value);
  } catch {
    return null;
  }
  const prefs = EditorCheckoutPrefsSchema.safeParse(parsed);
  return prefs.success ? prefs.data : null;
}

const SAVE_DEBOUNCE_MS = 2000;

const pending = new Map<
  string,
  { timer: ReturnType<typeof setTimeout>; prefs: EditorCheckoutPrefs }
>();

function write(dir: string, prefs: EditorCheckoutPrefs): void {
  void invoke<void>("ide_prefs_save", { dir, json: JSON.stringify(prefs) });
}

/** Debounced per dir — toggle churn must not write a file per click. */
export function scheduleEditorCheckoutPrefsSave(dir: string, prefs: EditorCheckoutPrefs): void {
  const entry = pending.get(dir);
  if (entry) clearTimeout(entry.timer);
  const timer = setTimeout(() => {
    pending.delete(dir);
    write(dir, prefs);
  }, SAVE_DEBOUNCE_MS);
  pending.set(dir, { timer, prefs });
}

/** Pane unmount: a switch away must not lose the last two seconds of state. */
export function flushEditorCheckoutPrefsSave(dir: string): void {
  const entry = pending.get(dir);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(dir);
  write(dir, entry.prefs);
}
