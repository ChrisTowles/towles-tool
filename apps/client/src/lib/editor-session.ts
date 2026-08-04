import { z } from "zod";
import { invoke } from "@/lib/tauri";

/** What a files pane remembers across an app restart (or a folder switch —
 * `FolderFilesPane` unmounts when another folder activates). One record per
 * checkout dir, stored beside the other instance state (`ide.rs`,
 * `editor-sessions.json`). Never file *content*: autosave owns that. */

const EditorSessionSchema = z.object({
  v: z.literal(1),
  tabs: z.array(z.string()),
  open: z.string().nullable(),
  wordWrap: z.boolean(),
  editable: z.boolean(),
});

export type EditorSession = z.infer<typeof EditorSessionSchema>;

/** Null on any failure — a stale or foreign shape just starts fresh. */
export async function loadEditorSession(dir: string): Promise<EditorSession | null> {
  const raw = await invoke<string | null>("ide_session_load", { dir });
  if (raw.isErr() || raw.value == null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.value);
  } catch {
    return null;
  }
  const session = EditorSessionSchema.safeParse(parsed);
  return session.success ? session.data : null;
}

const SAVE_DEBOUNCE_MS = 2000;

const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; session: EditorSession }>();

function write(dir: string, session: EditorSession): void {
  void invoke<void>("ide_session_save", { dir, json: JSON.stringify(session) });
}

/** Debounced per dir — tab churn must not write a file per click. */
export function scheduleEditorSessionSave(dir: string, session: EditorSession): void {
  const entry = pending.get(dir);
  if (entry) clearTimeout(entry.timer);
  const timer = setTimeout(() => {
    pending.delete(dir);
    write(dir, session);
  }, SAVE_DEBOUNCE_MS);
  pending.set(dir, { timer, session });
}

/** Pane unmount: a switch away must not lose the last two seconds of state. */
export function flushEditorSessionSave(dir: string): void {
  const entry = pending.get(dir);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(dir);
  write(dir, entry.session);
}
