/**
 * The rail's own chrome — the two things that frame the repo tree rather than
 * live in it: the collapsed icon strip, and the board-wide agent tally pinned
 * above it. The tree itself is `agentboard-repo-group` → `-folder-header` →
 * `-session-row` / `-pane-rows`, and the pieces every one of them shares are
 * in `agentboard-bits`.
 */
import { useState } from "react";
import { Folder, PanelLeftOpen } from "lucide-react";
import { Hint } from "@/components/hint";
import { DotCount } from "@/components/agentboard-bits";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Slider } from "@/components/ui/slider";
import { repoAccentStyles, repoIcon } from "@/lib/repo-identity";
import { invoke } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import {
  agentRollup,
  collapsedLiveColor,
  isSoloRepo,
  type FolderData,
  type RepoData,
  type StatePayload,
} from "@/lib/agentboard";
import { mouseAction } from "@/lib/shortcut-coach";

/** The whole rail collapsed to a narrow icon strip: an expand toggle, a live
 * session tally, then one icon per checkout (FolderGit2 for a solo repo,
 * Folder per checkout of a multi-checkout repo, repos separated by hairlines).
 * Each icon keeps the signals a collapsed folder header shows — the ambient
 * live-status dot and the amber needs-you count — so collapsing the rail
 * never hides work waiting on you. Clicking an icon focuses that folder. */
export function RailIconStrip({
  repos,
  activeFolderDir,
  attentionCount,
  onSelectFolder,
  onExpand,
  expandHint,
}: {
  repos: RepoData[];
  activeFolderDir: string | null;
  /** Items in the rail's attention strip (failing PRs, imminent meeting) —
   * hidden while collapsed, so the strip surfaces the count instead. */
  attentionCount: number;
  onSelectFolder: (dir: string) => void;
  onExpand: () => void;
  /** Keyboard hint for the expand tooltip, e.g. "⌘⇧B". */
  expandHint: string;
}) {
  const allSessions = repos.flatMap((r) => r.folders.flatMap((f) => f.sessions));
  const liveColor = collapsedLiveColor(allSessions);
  const liveN = allSessions.filter((s) => s.live).length;

  const folderIcon = (repo: RepoData, folder: FolderData, solo: boolean) => {
    const active = folder.dir === activeFolderDir;
    const needs = solo ? repo.needs : folder.needs;
    const live = collapsedLiveColor(folder.sessions);
    const label = solo ? repo.name : `${repo.name} / ${folder.name}`;
    // Repo identity: the collapsed strip is where a chosen icon+color earns
    // its keep — it's the only thing distinguishing one 36px square from the
    // next. Status still outranks it: the violet active edge and the amber
    // needs-you edge/badge keep the border, and a needs-you square never
    // takes the calmer identity wash.
    const RepoIcon = repoIcon(repo.meta);
    const accent = repoAccentStyles(repo.meta);
    // Attention (amber) still outranks identity. Being the active folder is a
    // ring layered on top instead, so it doesn't erase the identity wash.
    const statusOwnsEdge = needs > 0;
    return (
      <Tooltip key={folder.dir}>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={label}
            aria-current={active || undefined}
            onClick={() => onSelectFolder(folder.dir)}
            style={statusOwnsEdge ? undefined : { ...accent.edgeStyle, ...accent.surfaceStyle }}
            className={cn(
              "relative flex size-9 shrink-0 items-center justify-center rounded-md border-l-2 border-transparent text-muted-foreground hover:bg-accent/50",
              active && "border-l-violet-500 text-foreground ring-1 ring-inset ring-violet-500/50",
              // Attention outranks focus on the accent edge (folder-rail rule).
              needs > 0 && "border-l-amber-500",
            )}
          >
            {solo ? (
              <RepoIcon className="size-4" style={accent.iconStyle} />
            ) : (
              <Folder className="size-4" style={accent.iconStyle} />
            )}
            {live && <span className={cn("absolute top-1 right-1 size-2 rounded-full", live)} />}
            {needs > 0 && (
              <span className="absolute -right-1 -bottom-1 min-w-4 rounded-full border border-amber-500/50 bg-background px-0.5 text-center font-mono text-[9px] leading-[14px] text-amber-500">
                {needs}
              </span>
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">
          {label} — ⎇ {folder.branch}
          {needs > 0 && ` · ${needs} need${needs === 1 ? "s" : ""} you`}
        </TooltipContent>
      </Tooltip>
    );
  };

  return (
    <div className="flex h-full w-12 shrink-0 flex-col items-center border-r bg-background py-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="Expand the folder rail"
            onClick={() => {
              mouseAction("ab-toggle-rail", "agentboard");
              onExpand();
            }}
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          >
            <PanelLeftOpen className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">Expand rail ({expandHint})</TooltipContent>
      </Tooltip>
      {liveColor && (
        <Hint label={`${liveN} running session${liveN === 1 ? "" : "s"}`} side="right">
          <span className="flex items-center gap-1 py-1 font-mono text-[10px] text-muted-foreground/70">
            <span className={cn("size-2 rounded-full", liveColor)} />
            {liveN}
          </span>
        </Hint>
      )}
      {attentionCount > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Expand the rail to see attention items"
              onClick={onExpand}
              className="mt-1 rounded-md border border-amber-500/50 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px] text-amber-500 hover:bg-amber-500/20"
            >
              {attentionCount} ⚑
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">
            {attentionCount} attention item{attentionCount === 1 ? "" : "s"} (failing PRs, imminent
            meeting) — expand to see
          </TooltipContent>
        </Tooltip>
      )}
      <div className="my-1.5 h-px w-6 shrink-0 bg-border" />
      <div className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto">
        {repos.map((repo, i) => {
          const solo = isSoloRepo(repo);
          return (
            <div key={repo.key} className="flex flex-col items-center gap-1">
              {i > 0 && <div className="my-0.5 h-px w-6 bg-border" />}
              {(solo ? [repo.folders[0]] : repo.folders).map((f) => folderIcon(repo, f, solo))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The board-wide agent tally pinned atop the rail: total + non-zero status
 * buckets + a ❄ compact count, with the Agentboard settings (compact
 * threshold) behind the trailing ⚙. Quiet when the board is at rest. */
export function RollupChip({ state, now }: { state: StatePayload; now: number }) {
  const threshold = state.compactRecommendPercent;
  const r = agentRollup(state.repos, now, threshold);
  // Track the slider locally while dragging; commit on release.
  const [draft, setDraft] = useState<number | null>(null);
  const pct = draft ?? threshold;

  return (
    <div className="flex items-center gap-2.5 border-b bg-card px-3 py-2 font-mono text-[11px]">
      {r.total === 0 ? (
        <span className="text-muted-foreground/60">no agents running</span>
      ) : (
        <>
          <span className="text-foreground">
            {r.total} agent{r.total !== 1 && "s"}
          </span>
          {r.busy > 0 && <DotCount status="busy" n={r.busy} />}
          {r.waiting > 0 && <DotCount status="waiting" n={r.waiting} />}
          {r.error > 0 && <DotCount status="error" n={r.error} />}
          {r.expiring > 0 && (
            <Hint label="warm prompt caches about to expire — nudge them">
              <span className="text-amber-500">◔{r.expiring}</span>
            </Hint>
          )}
          {r.compact > 0 && (
            <Hint label="cold sessions worth compacting">
              <span className="text-sky-500">❄{r.compact}</span>
            </Hint>
          )}
        </>
      )}
      <Popover>
        <Hint label="Agentboard settings">
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="Agentboard settings"
              className="ml-auto text-muted-foreground/60 hover:text-foreground"
            >
              ⚙
            </button>
          </PopoverTrigger>
        </Hint>
        <PopoverContent align="end" className="w-72">
          <div className="flex flex-col gap-3">
            <div className="text-sm font-medium">Agentboard settings</div>
            <div className="text-xs text-muted-foreground">
              Recommend compacting a cold session at or above{" "}
              <span className="font-mono text-sky-500">{pct}%</span> context.
            </div>
            <Slider
              min={10}
              max={90}
              step={5}
              value={[pct]}
              onValueChange={([v]) => setDraft(v)}
              onValueCommit={([v]) => {
                setDraft(null);
                void invoke("ab_set_compact_percent", { percent: v });
              }}
            />
            <div className="text-[11px] text-muted-foreground/70">
              Past this threshold, a session whose prompt cache expired shows the ❄ compact nudge.
              Stored in the shared towles-tool settings file.
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
