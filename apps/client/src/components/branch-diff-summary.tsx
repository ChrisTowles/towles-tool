import { useEffect, useState } from "react";
import { CommitStatRow } from "@/components/agentboard-bits/diff-chips";
import { comparedBaseLabel } from "@/lib/agentboard/folder";
import type { BranchDiff, BranchDiffFile } from "@/lib/agentboard/types";
import { invoke } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { fmtDiffLines } from "@/lib/format";

/** Enough to see the shape of a branch; the files pane has the rest. */
const MAX_FILES = 40;

const STATUS_TONE: Record<string, string> = {
  A: "text-ok",
  D: "text-danger",
  "?": "text-warn",
};

/** `git diff --stat` of a checkout against its base, fetched when shown —
 * the last look at what a delete would leave behind on the branch or destroy.
 * Commits and files are listed only for a landed branch; otherwise the
 * one-line difference from the base is the whole story. */
export function BranchDiffSummary({
  dir,
  baseBranch,
  full,
}: {
  dir: string;
  baseBranch?: string | null;
  full: boolean;
}) {
  // Keyed by dir so a reopen for another worktree never flashes the last one's diff.
  const [loaded, setLoaded] = useState<{ dir: string; diff: BranchDiff | null } | null>(null);
  useEffect(() => {
    let live = true;
    void invoke<BranchDiff | null>("ab_get_branch_diff", {
      dir,
      baseBranch: baseBranch?.trim() || null,
    }).then((r) => {
      if (live) setLoaded({ dir, diff: r.unwrapOr(null) });
    });
    return () => {
      live = false;
    };
  }, [dir, baseBranch]);

  if (loaded?.dir !== dir) {
    return <p className="text-xs text-kumo-subtle">reading the branch's diff…</p>;
  }
  const diff = loaded.diff;
  if (diff == null) {
    return <p className="text-xs text-kumo-subtle">Not a git checkout — no diff to show.</p>;
  }

  const base = comparedBaseLabel(diff);
  const added = diff.files.reduce((n, f) => n + f.linesAdded, 0);
  const removed = diff.files.reduce((n, f) => n + f.linesRemoved, 0);
  const uncommitted = diff.files.filter((f) => f.uncommitted).length;
  const shown = diff.files.slice(0, MAX_FILES);

  return (
    <div className="flex flex-col gap-2 rounded-md border border-kumo-hairline bg-kumo-recessed p-3">
      <div className="flex flex-wrap items-baseline gap-x-2 font-mono text-mini">
        <span className="min-w-0 truncate font-semibold text-kumo-default">
          {diff.branch || "detached HEAD"} → {base}
        </span>
        <span className="text-kumo-subtle">
          {diff.commits.length} commit{diff.commits.length === 1 ? "" : "s"} · {diff.files.length}
          {diff.capped ? "+" : ""} file{diff.files.length === 1 ? "" : "s"}
        </span>
        <span className="text-ok">+{fmtDiffLines(added)}</span>
        <span className="text-danger">−{fmtDiffLines(removed)}</span>
        {uncommitted > 0 && <span className="text-warn">{uncommitted} uncommitted</span>}
      </div>
      {diff.files.length === 0 && (
        <p className="text-xs text-kumo-subtle">Nothing differs from {base}.</p>
      )}
      {full && diff.files.length > 0 && (
        <div className="flex max-h-56 flex-col gap-2 overflow-auto">
          {diff.commits.length > 0 && (
            <div className="flex flex-col gap-1">
              {diff.commits.map((c) => (
                <CommitStatRow key={c.sha} commit={c} />
              ))}
            </div>
          )}
          <div className="flex flex-col gap-0.5 border-t border-kumo-hairline pt-2">
            {shown.map((f) => (
              <FileRow key={f.path} file={f} />
            ))}
            {diff.files.length > shown.length && (
              <span className="font-mono text-mini text-kumo-subtle">
                …and {diff.files.length - shown.length} more
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function FileRow({ file }: { file: BranchDiffFile }) {
  return (
    <div className="flex items-center gap-2 font-mono text-mini leading-tight">
      <span className={cn("w-3 shrink-0", STATUS_TONE[file.status] ?? "text-kumo-subtle")}>
        {file.status}
      </span>
      <span className="min-w-0 flex-1 truncate text-kumo-default" title={file.path}>
        {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
      </span>
      {file.uncommitted && <span className="shrink-0 text-warn">uncommitted</span>}
      {file.binary ? (
        <span className="shrink-0 text-kumo-subtle">bin</span>
      ) : (
        file.status !== "?" && (
          <>
            <span className="shrink-0 text-ok">+{fmtDiffLines(file.linesAdded)}</span>
            <span className="shrink-0 text-danger">−{fmtDiffLines(file.linesRemoved)}</span>
          </>
        )
      )}
    </div>
  );
}
