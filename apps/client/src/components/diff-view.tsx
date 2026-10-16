// The quick diff: a checkout's branch against its base, file by file, without
// booting a VS Code workbench. Read-only — editing is the Files pane's job.
import { useEffect, useRef, useState } from "react";
import { Dialog } from "@cloudflare/kumo";
import { GitDiffIcon } from "@phosphor-icons/react";
import { comparedBaseLabel } from "@/lib/agentboard/folder";
import type { BranchDiff, BranchDiffFile } from "@/lib/agentboard/types";
import {
  type FilePatch,
  closeDiffView,
  patchRows,
  useDiffView,
  type DiffViewTarget,
} from "@/lib/diff-view";
import { fmtDiffLines } from "@/lib/format";
import { invoke } from "@/lib/tauri";
import { uiAction } from "@/lib/ui-action";
import { cn } from "@/lib/utils";

const ROW_TONE = {
  add: "bg-ok/10 text-kumo-default",
  del: "bg-danger/10 text-kumo-default",
  ctx: "text-kumo-subtle",
} as const;

const SIGIL = { add: "+", del: "−", ctx: " " } as const;

export function DiffView() {
  const target = useDiffView();
  return (
    <Dialog.Root open={target != null} onOpenChange={(open) => !open && closeDiffView()}>
      <Dialog
        size="xl"
        className="flex h-[80vh] w-[min(72rem,calc(100vw-2rem))] max-w-none flex-col gap-3 p-5"
      >
        {target && <DiffBody key={target.dir} target={target} />}
      </Dialog>
    </Dialog.Root>
  );
}

function DiffBody({ target }: { target: DiffViewTarget }) {
  const [diff, setDiff] = useState<BranchDiff | null | undefined>(undefined);
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void invoke<BranchDiff | null>("ab_get_branch_diff", {
      dir: target.dir,
      baseBranch: target.baseBranch,
    }).then((r) => {
      if (!live) return;
      const d = r.unwrapOr(null);
      setDiff(d);
      setPicked(d?.files.find((f) => f.status !== "?")?.path ?? d?.files[0]?.path ?? null);
    });
    return () => {
      live = false;
    };
  }, [target.dir, target.baseBranch]);

  const files = diff?.files ?? [];
  const file = files.find((f) => f.path === picked);

  function step(by: 1 | -1) {
    const i = files.findIndex((f) => f.path === picked);
    const next = files[Math.min(files.length - 1, Math.max(0, i + by))];
    if (next) setPicked(next.path);
  }

  return (
    <>
      <Dialog.Title className="flex items-baseline gap-2 text-base font-semibold">
        <GitDiffIcon className="size-4 self-center" />
        <span className="min-w-0 truncate">{target.label}</span>
        {diff && (
          <span className="font-mono text-mini font-normal text-kumo-subtle">
            {diff.branch || "detached HEAD"} → {comparedBaseLabel(diff)} · {files.length}
            {diff.capped ? "+" : ""} file{files.length === 1 ? "" : "s"}
          </span>
        )}
      </Dialog.Title>
      <Dialog.Description className="sr-only">
        Read-only diff of this checkout against its base. Arrow keys move between files.
      </Dialog.Description>
      {diff === undefined ? (
        <p className="text-xs text-kumo-subtle">reading the branch's diff…</p>
      ) : diff === null ? (
        <p className="text-xs text-kumo-subtle">Not a git checkout — no diff to show.</p>
      ) : files.length === 0 ? (
        <p className="text-xs text-kumo-subtle">Nothing differs from {comparedBaseLabel(diff)}.</p>
      ) : (
        <div
          className="flex min-h-0 flex-1 gap-3"
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              step(e.key === "ArrowDown" ? 1 : -1);
            }
          }}
        >
          <ul
            aria-label="Changed files"
            className="flex w-72 shrink-0 flex-col gap-px overflow-auto rounded-md border border-kumo-hairline bg-kumo-recessed p-1"
          >
            {files.map((f) => (
              <li key={f.path}>
                <FileButton
                  file={f}
                  active={f.path === picked}
                  onPick={() => {
                    setPicked(f.path);
                    uiAction("diff_view.file", "agentboard");
                  }}
                />
              </li>
            ))}
          </ul>
          <div className="min-w-0 flex-1 overflow-auto rounded-md border border-kumo-hairline">
            {file && <FilePatchView key={file.path} target={target} file={file} />}
          </div>
        </div>
      )}
    </>
  );
}

function FileButton({
  file,
  active,
  onPick,
}: {
  file: BranchDiffFile;
  active: boolean;
  onPick: () => void;
}) {
  const slash = file.path.lastIndexOf("/");
  // Focus follows the arrow keys, so the list scrolls to the file shown.
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (active) ref.current?.focus();
  }, [active]);
  return (
    <button
      ref={ref}
      type="button"
      aria-current={active || undefined}
      onClick={onPick}
      title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
      className={cn(
        "flex w-full items-center gap-2 rounded px-1.5 py-0.5 text-left font-mono text-mini",
        active ? "bg-kumo-tint text-kumo-default" : "text-kumo-subtle hover:bg-kumo-tint",
      )}
    >
      <span className="min-w-0 flex-1 truncate">
        {file.path.slice(slash + 1)}
        {slash > 0 && <span className="opacity-60"> {file.path.slice(0, slash)}</span>}
      </span>
      {file.uncommitted && (
        <span className="size-1.5 shrink-0 rounded-full bg-warn" title="uncommitted" />
      )}
      {!file.binary && file.status !== "?" && (
        <span className="shrink-0">
          <span className="text-ok">+{fmtDiffLines(file.linesAdded)}</span>{" "}
          <span className="text-danger">−{fmtDiffLines(file.linesRemoved)}</span>
        </span>
      )}
    </button>
  );
}

function FilePatchView({ target, file }: { target: DiffViewTarget; file: BranchDiffFile }) {
  const [patch, setPatch] = useState<FilePatch | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void invoke<FilePatch | null>("ab_get_file_patch", {
      dir: target.dir,
      baseBranch: target.baseBranch,
      path: file.path,
      oldPath: file.oldPath,
    }).then((r) => {
      if (live) setPatch(r.unwrapOr(null));
    });
    return () => {
      live = false;
    };
  }, [target.dir, target.baseBranch, file.path, file.oldPath]);

  if (patch === undefined) return <Note>reading {file.path}…</Note>;
  if (patch === null) return <Note>Couldn't read this file's diff.</Note>;
  if (patch.binary) return <Note>Binary file — no text diff.</Note>;
  if (patch.hunks.length === 0) return <Note>No line changes (mode or rename only).</Note>;
  return (
    <table className="w-full border-collapse font-mono text-mini leading-snug">
      {patch.hunks.map((hunk) => (
        <tbody key={`${hunk.oldStart}:${hunk.newStart}`}>
          <tr className="bg-kumo-recessed text-kumo-subtle">
            <td colSpan={3} className="px-2 py-0.5">
              @@ −{hunk.oldStart} +{hunk.newStart} @@
            </td>
          </tr>
          {patchRows(hunk).map((row, i) => (
            <tr key={i} className={ROW_TONE[row.kind]}>
              <td className="w-10 pr-1 text-right align-top text-kumo-subtle/60 select-none">
                {row.oldNo ?? ""}
              </td>
              <td className="w-10 pr-2 text-right align-top text-kumo-subtle/60 select-none">
                {row.newNo ?? ""}
              </td>
              <td className="pr-2 whitespace-pre-wrap break-all">
                <span className="select-none opacity-60">{SIGIL[row.kind]}</span>
                {row.text}
              </td>
            </tr>
          ))}
        </tbody>
      ))}
      {patch.truncated && (
        <tbody>
          <tr>
            <td colSpan={3} className="px-2 py-1 text-kumo-subtle">
              …cut short — open the Files pane for the rest.
            </td>
          </tr>
        </tbody>
      )}
    </table>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="p-3 text-xs text-kumo-subtle">{children}</p>;
}
