/** Rows that stand for rows the rail isn't showing. Each one is a count and a
 * way back: nothing the rail folds may become unreachable. */
import { FolderGit2 } from "lucide-react";
import { Chevron } from "@/components/agentboard-bits";
import { Hint } from "@/components/hint";

/** A repo with nothing left to show, demoted to one dim row rather than removed
 * — folding is a view setting, so nothing it touches vanishes. It says which
 * kind of fold emptied the repo, since the two are undone separately. */
export function FoldedRepoStub({
  name,
  idle,
  unmanaged,
  onToggle,
}: {
  name: string;
  idle: number;
  unmanaged: number;
  onToggle?: () => void;
}) {
  return (
    <Hint label="Nothing going on here right now — click to show">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 border-b bg-card px-3 py-1.5 text-left text-muted-foreground/60 hover:bg-accent/40 hover:text-muted-foreground"
      >
        <Chevron collapsed />
        <FolderGit2 className="size-3.5 shrink-0 opacity-60" />
        <span className="min-w-0 truncate text-sm">{name}</span>
        <span className="ml-auto shrink-0 font-mono text-[10px]">
          {foldedRepoLabel(idle, unmanaged)}
        </span>
      </button>
    </Hint>
  );
}

/** "idle" / "3 unmanaged" / "8 hidden" — never a count under a noun that only
 * half of it answers to. */
export function foldedRepoLabel(idle: number, unmanaged: number): string {
  if (unmanaged === 0) return idle === 1 ? "idle" : `${idle} idle`;
  if (idle === 0) return `${unmanaged} unmanaged`;
  return `${idle + unmanaged} hidden`;
}

/** The stub under a repo's visible folders: "N idle" / "hide N idle", and the
 * same shape for the worktrees agents made for themselves. */
export function FoldToggleRow({
  count,
  noun,
  hint,
  revealed,
  onToggle,
}: {
  count: number;
  noun: "idle" | "unmanaged";
  hint: string;
  revealed: boolean;
  onToggle?: () => void;
}) {
  return (
    <Hint label={hint}>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 py-1 pr-3 pl-6 text-left font-mono text-[10.5px] text-muted-foreground/50 hover:text-muted-foreground"
      >
        <Chevron collapsed={!revealed} />
        {revealed ? `hide ${count} ${noun}` : `${count} ${noun}`}
      </button>
    </Hint>
  );
}
