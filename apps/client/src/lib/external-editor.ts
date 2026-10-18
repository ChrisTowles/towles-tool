import { toast } from "@/lib/toast";
import { NotInTauri } from "@/lib/errors";
import { Result } from "effect";
import { invoke, runIpc } from "@/lib/tauri";
import { uiAction } from "@/lib/ui-action";

/** Open a file in `preferredEditor` (Settings → General) via `term_open_path`,
 * so per-editor goto syntax resolves in exactly one place, in Rust. `path` may
 * be relative to `cwd`. Configuration failures toast; browser dev stays quiet.
 * Every call is a user gesture, hence the `ui.action` record. */
export async function openInExternalEditor(
  path: string,
  opts: { cwd?: string; line?: number | null; where: string },
): Promise<void> {
  uiAction("editor.open_external", "agentboard", opts.where);
  const opened = await runIpc(
    invoke<void>("term_open_path", {
      path,
      cwd: opts.cwd ?? null,
      line: opts.line ?? null,
    }),
  );
  if (Result.isFailure(opened) && !NotInTauri.is(opened.failure)) {
    toast.error(`Couldn't open in your editor — ${opened.failure.message}`, {
      description: "Set the editor command in Settings → General (e.g. code, code-insiders).",
    });
  }
}
