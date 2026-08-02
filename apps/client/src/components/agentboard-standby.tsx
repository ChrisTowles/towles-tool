// Agentboard's front page: what is stopped and waiting on you, longest wait
// first. Ranking lives in `lib/fleet-standby.ts`; this file is only how it
// reads — rows when something is blocked, display scale when nothing is.
import { statusColor, type RepoData } from "@/lib/agentboard";
import { buildStandby, type Standby, type StandbyRow } from "@/lib/fleet-standby";
import { fmtAge } from "@/lib/data";
import { cn } from "@/lib/utils";

export function AgentboardStandby({
  repos,
  now,
  onSelectFolder,
}: {
  repos: RepoData[];
  now: number;
  onSelectFolder: (dir: string) => void;
}) {
  const board = buildStandby(repos, now);

  if (board.total === 0) {
    return (
      <Centered>
        <p className="text-sm text-muted-foreground">No checkouts on the rail yet.</p>
      </Centered>
    );
  }

  if (board.rows.length === 0) return <AllQuiet board={board} now={now} />;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-2xl flex-col gap-6 px-8 py-14">
        <p className="text-sm text-muted-foreground">
          {board.rows.length} of {board.total} checkouts waiting on you
          {board.working > 0 && ` · ${board.working} working`}
        </p>
        <div className="flex flex-col gap-1">
          {board.rows.map((row) => (
            <StandbyRowView key={row.dir} row={row} onSelect={() => onSelectFolder(row.dir)} />
          ))}
        </div>
        <Inventory board={board} />
      </div>
    </div>
  );
}

/** A checkout that wants something — an unread message rather than a dashboard
 * cell, which is the honest shape for an agent sitting at a prompt. */
function StandbyRowView({ row, onSelect }: { row: StandbyRow; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="-mx-3 flex items-baseline gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-accent/50"
    >
      <span
        className={cn(
          "size-2 shrink-0 -translate-y-px rounded-full",
          statusColor(row.errored ? "error" : "waiting"),
        )}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-baseline gap-3">
          <span className="min-w-0 flex-1 truncate text-sm">
            <span className="font-mono text-[11px] text-muted-foreground/60">{row.repo} / </span>
            <span className="font-medium text-foreground">{row.title}</span>
          </span>
          <span
            className={cn(
              "shrink-0 font-mono text-[11px]",
              row.errored ? "text-red-500" : "text-blue-600 dark:text-blue-400",
            )}
          >
            {row.note}
          </span>
        </span>
        {row.said && <span className="truncate text-xs text-muted-foreground">{row.said}</span>}
      </span>
    </button>
  );
}

/** The state most mornings open in. It states the fleet's condition and stops:
 * the next move is a `+` on a repo header inches to the left, and a button here
 * that then had to ask "which repo?" would be worse than no button. */
function AllQuiet({ board, now }: { board: Standby; now: number }) {
  return (
    <Centered>
      <p className="font-heading text-3xl font-semibold tracking-tight text-foreground">
        Nobody's waiting
      </p>
      <p className="mt-3 font-mono text-xs text-muted-foreground/70">
        {board.total} checkout{board.total === 1 ? "" : "s"} ·{" "}
        {board.working > 0 ? `${board.working} working` : "nothing running"}
      </p>
      {board.lastWorkedName && board.working === 0 && (
        <p className="mt-1 font-mono text-xs text-muted-foreground/50">
          last worked in {board.lastWorkedName} {fmtAge(board.lastWorkedAt, now)}
        </p>
      )}
      <div className="mt-6">
        <Inventory board={board} />
      </div>
    </Centered>
  );
}

/** Work the fleet is holding, as counts rather than rows: the rail states both
 * per checkout and owns the affordances to act, so a list here would duplicate
 * a destructive action onto a surface with no confirm dialog. */
function Inventory({ board }: { board: Standby }) {
  const parts = [
    board.holding > 0 && `${board.holding} holding uncommitted work`,
    board.landed > 0 && `${board.landed} landed and can go`,
  ].filter((p): p is string => Boolean(p));
  if (parts.length === 0) return null;
  return <p className="font-mono text-xs text-muted-foreground/60">{parts.join(" · ")}</p>;
}

export function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      {children}
    </div>
  );
}
