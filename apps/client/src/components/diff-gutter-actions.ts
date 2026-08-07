/** VS Code's diff-gutter staging surface (its git extension's
 * `git.diff.stageHunk`), pointed at our IPC: the gutter hands each action the
 * synthesized "original + this hunk" text, which — the uncommitted view's
 * original side being the *index* — is exactly the new index content. Discard
 * needs nothing here: the built-in "Revert Block" edits the buffer (undoable)
 * and autosave persists it. The `when` clauses key off our URI schemes, so no
 * other diff editor in the app grows these buttons. */

import { toast } from "sonner";
import { errorMessage } from "@/lib/errors";
import { revertLineRange, type LineRangeLite } from "@/lib/diff-staging";
import { invoke } from "@/lib/tauri";
import { uiAction } from "@/lib/ui-action";

export type StageTarget = {
  dir: string;
  /** Repo-relative path of the file this modified-side model renders. */
  path: string;
  /** Both sides' current text, for the unstage splice. Null once disposed. */
  readSides: () => { original: string; modified: string } | null;
  /** After a successful index write: refresh models + the pane's file list. */
  onStaged: () => void;
};

/** Modified-model URI → how to stage against it. Registered by the multi-diff
 * while its models are alive; actions ignore editors nobody registered. */
const targets = new Map<string, StageTarget>();

export function registerStageTarget(modifiedUri: string, target: StageTarget): () => void {
  targets.set(modifiedUri, target);
  return () => {
    if (targets.get(modifiedUri) === target) targets.delete(modifiedUri);
  };
}

/** The context the gutter toolbars pass to `run` (see gutterFeature.ts). */
type HunkContext = {
  mapping: { original: LineRangeLite; modified: LineRangeLite };
  originalWithModifiedChanges: string;
  originalUri: { toString(): string };
  modifiedUri: { toString(): string };
};

async function stageBuffer(target: StageTarget, content: string, action: string): Promise<void> {
  uiAction(action, "agentboard", target.path);
  const result = await invoke<void>("ab_stage_buffer", {
    dir: target.dir,
    path: target.path,
    content,
  });
  if (result.isErr()) {
    toast.error(
      `Couldn't ${action.includes("unstage") ? "unstage" : "stage"} — ${errorMessage(result.error)}`,
    );
    return;
  }
  target.onStaged();
}

/** Stage: the gutter already synthesized index+hunk for us. */
function runStage(context: HunkContext | undefined, action: string): void {
  const target = context && targets.get(context.modifiedUri.toString());
  if (!target) return;
  void stageBuffer(target, context.originalWithModifiedChanges, action);
}

/** Unstage: splice the hunk's HEAD lines back over the index lines. */
function runUnstage(context: HunkContext | undefined, action: string): void {
  const target = context && targets.get(context.modifiedUri.toString());
  if (!target) return;
  const sides = target.readSides();
  if (!sides) return;
  const next = revertLineRange(
    sides.original,
    sides.modified,
    context.mapping.original,
    context.mapping.modified,
  );
  void stageBuffer(target, next, action);
}

let installed = false;

/** Register the four actions once. Called from the multi-diff's build (the
 * monaco modules are already loaded there); safe to call repeatedly. */
export async function ensureDiffGutterActions(): Promise<void> {
  if (installed) return;
  installed = true;
  const [actions, contextkey, codicons] = await Promise.all([
    import("@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions"),
    import("@codingame/monaco-vscode-api/vscode/vs/platform/contextkey/common/contextkey"),
    import("@codingame/monaco-vscode-api/vscode/vs/base/common/codicons"),
  ]);
  const { Action2, MenuId, registerAction2 } = actions;
  const { ContextKeyExpr } = contextkey;
  const { Codicon } = codicons;
  // The index is the original side only in the uncommitted view; HEAD only in
  // the staged view. Same gate vscode's git extension uses (its `ref:"~"` regex).
  const overIndex = ContextKeyExpr.regex("diffEditorOriginalUri", /^tt-diff-index:/);
  const overHead = ContextKeyExpr.regex("diffEditorOriginalUri", /^tt-diff-head:/);

  const define = (
    id: string,
    title: string,
    icon: { id: string },
    menuId: unknown,
    when: unknown,
    run: (context: HunkContext | undefined) => void,
  ) => {
    registerAction2(
      class extends Action2 {
        constructor() {
          super({
            id,
            title,
            icon,
            f1: false,
            menu: [{ id: menuId as never, when: when as never, group: "primary", order: 10 }],
          });
        }
        override run(_accessor: unknown, context?: HunkContext): void {
          run(context);
        }
      },
    );
  };

  define(
    "tt.diff.stageHunk",
    "Stage Block",
    Codicon.plus,
    MenuId.DiffEditorHunkToolbar,
    overIndex,
    (c) => runStage(c, "diff.stage_hunk"),
  );
  define(
    "tt.diff.stageSelection",
    "Stage Selection",
    Codicon.plus,
    MenuId.DiffEditorSelectionToolbar,
    overIndex,
    (c) => runStage(c, "diff.stage_selection"),
  );
  define(
    "tt.diff.unstageHunk",
    "Unstage Block",
    Codicon.remove,
    MenuId.DiffEditorHunkToolbar,
    overHead,
    (c) => runUnstage(c, "diff.unstage_hunk"),
  );
  define(
    "tt.diff.unstageSelection",
    "Unstage Selection",
    Codicon.remove,
    MenuId.DiffEditorSelectionToolbar,
    overHead,
    (c) => runUnstage(c, "diff.unstage_selection"),
  );
}
