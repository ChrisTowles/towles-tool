/** VS Code's diff-gutter staging surface (its git extension's
 * `git.diff.stageHunk`), pointed at our IPC: the gutter hands each action the
 * synthesized "original + this hunk" text, which — the uncommitted view's
 * original side being the *index* — is exactly the new index content. Discard
 * needs nothing here: the built-in "Revert Block" edits the buffer (undoable)
 * and autosave persists it. The `when` clauses key off our URI schemes, so no
 * other diff editor in the app grows these buttons. */

import { toast } from "sonner";
import { errorMessage } from "@/lib/errors";
import {
  revertLineRange,
  revertRangeMappings,
  type LineRangeLite,
  type RangeMappingLite,
} from "@/lib/diff-staging";
import { invoke } from "@/lib/tauri";
import { uiAction } from "@/lib/ui-action";

export type StageTarget = {
  dir: string;
  /** Repo-relative path of the file this modified-side model renders. */
  path: string;
  /** Both sides' current text — the unstage splice and the write's
   * expected-index token. `original` is null when the file has no side there
   * (an added/untracked file); the whole read is null once disposed. */
  readSides: () => { original: string | null; modified: string } | null;
  /** After the index write, success or refused-as-stale alike: refresh the
   * models + the pane's file list, so a retry starts from what's really there. */
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

/** The context the gutter toolbars pass to `run` (see gutterFeature.ts). The
 * selection toolbar's `innerChanges` carry only the *selected* changes; the
 * hunk toolbar's is one mapping spanning the whole hunk. */
type HunkContext = {
  mapping: {
    original: LineRangeLite;
    modified: LineRangeLite;
    innerChanges?: RangeMappingLite[] | null;
  };
  originalWithModifiedChanges: string;
  originalUri: { toString(): string };
  modifiedUri: { toString(): string };
};

async function stageBuffer(
  target: StageTarget,
  content: string,
  expectedIndex: string | null,
  action: string,
): Promise<void> {
  uiAction(action, "agentboard", target.path);
  const result = await invoke<void>("ab_stage_buffer", {
    dir: target.dir,
    path: target.path,
    content,
    expectedIndex,
  });
  if (result.isErr()) {
    toast.error(
      `Couldn't ${action.includes("unstage") ? "unstage" : "stage"} — ${errorMessage(result.error)}`,
    );
  }
  // Refresh even on a refused write: the usual refusal is the expected-index
  // guard, and the retry needs the models it was computed from replaced first.
  target.onStaged();
}

/** Stage: the gutter already synthesized index+hunk for us. The original side
 * (the index) is the base that synthesis started from — the write's guard. */
function runStage(context: HunkContext | undefined, action: string): void {
  const target = context && targets.get(context.modifiedUri.toString());
  if (!target) return;
  const sides = target.readSides();
  if (!sides) return;
  void stageBuffer(target, context.originalWithModifiedChanges, sides.original, action);
}

/** Unstage: put the mapped HEAD spans back over the index spans. Char-precise
 * via `innerChanges` — the outer line-range hull would also revert unselected
 * changes lying between two selected ones. */
function runUnstage(context: HunkContext | undefined, action: string): void {
  const target = context && targets.get(context.modifiedUri.toString());
  if (!target) return;
  const sides = target.readSides();
  if (!sides) return;
  const inner = context.mapping.innerChanges;
  const next = inner?.length
    ? revertRangeMappings(sides.original ?? "", sides.modified, inner)
    : revertLineRange(
        sides.original ?? "",
        sides.modified,
        context.mapping.original,
        context.mapping.modified,
      );
  void stageBuffer(target, next, sides.modified, action);
}

let installed: Promise<void> | null = null;

/** Register the four actions once. Called from the multi-diff's build (the
 * monaco modules are already loaded there); safe to call repeatedly. A failed
 * chunk load resets, so the next pane build retries instead of leaving the
 * staging buttons off for the rest of the session. */
export function ensureDiffGutterActions(): Promise<void> {
  installed ??= installDiffGutterActions().catch((e) => {
    installed = null;
    console.error("diff gutter actions failed to install", e);
  });
  return installed;
}

async function installDiffGutterActions(): Promise<void> {
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
