import { toast } from "sonner";
import { NotInTauri } from "@/lib/errors";
import { invoke } from "@/lib/tauri";
import { uiAction } from "@/lib/ui-action";

/**
 * Open a file in the editor from `preferredEditor` (Settings → General), at
 * `line` when the caller knows one — the same `term_open_path` command a
 * Ctrl/⌘-clicked terminal link takes, so the goto syntax per editor
 * (`code --goto`, `vim +line`, …) is resolved in exactly one place, in Rust.
 *
 * `path` may be absolute or relative to `cwd` (the backend joins them). The
 * failures worth surfacing are configuration ones — no editor set, a command
 * that isn't on PATH — so they toast rather than being swallowed; browser dev
 * has no backend and stays quiet.
 *
 * Every call is a user gesture (a context-menu pick), so it emits its own
 * `ui.action` record, with `where` naming the surface it was invoked from.
 */
export async function openInExternalEditor(
  path: string,
  opts: { cwd?: string; line?: number | null; where: string },
): Promise<void> {
  uiAction("editor.open_external", "agentboard", opts.where);
  const opened = await invoke<void>("term_open_path", {
    path,
    cwd: opts.cwd ?? null,
    line: opts.line ?? null,
  });
  if (opened.isErr() && !NotInTauri.is(opened.error)) {
    toast.error(`Couldn't open in your editor — ${opened.error.message}`, {
      description: "Set the editor command in Settings → General (e.g. code, code-insiders).",
    });
  }
}
