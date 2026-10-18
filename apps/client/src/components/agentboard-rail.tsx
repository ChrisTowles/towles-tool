/** The rail's own chrome — what frames the repo tree rather than lives in it:
 * the collapsed icon strip and the board-wide agent tally. The tree is
 * `agentboard-repo-group` → `-folder-header` → `-session-row`/`-pane-rows`. */
import { useState } from "react";
import { FolderIcon, SidebarSimpleIcon } from "@phosphor-icons/react";
import { Hint } from "@/components/hint";
import { RollupDots } from "@/components/agentboard-bits/status-dots";
import { Popover, Tooltip } from "@cloudflare/kumo";
import { Slider } from "@/components/ui/slider";
import { repoAccentStyles, repoIcon } from "@/lib/repo-identity";
import { fire, invoke } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { isHomeRepo } from "@/lib/agentboard/folder";
import { agentRollup, collapsedLiveColor } from "@/lib/agentboard/status";
import type { FolderData, RepoData } from "@/lib/agentboard/types";
import { mouseAction } from "@/lib/shortcut-coach";

/** The rail collapsed to an icon strip, one icon per checkout — each keeps its
 * folder's live-status dot and amber needs-you count, so collapsing the rail
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
  /** The attention strip hides while collapsed; this count stands in for it. */
  attentionCount: number;
  onSelectFolder: (dir: string) => void;
  onExpand: () => void;
  /** Keyboard hint for the expand tooltip, e.g. "⌘⇧B". */
  expandHint: string;
}) {
  const allSessions = repos.flatMap((r) => r.folders.flatMap((f) => f.sessions));
  const liveColor = collapsedLiveColor(allSessions);
  const liveN = allSessions.filter((s) => s.live).length;

  const folderIcon = (repo: RepoData, folder: FolderData, home: boolean) => {
    const active = folder.dir === activeFolderDir;
    const needs = home ? repo.needs : folder.needs;
    const live = collapsedLiveColor(folder.sessions);
    const label = home ? repo.name : `${repo.name} / ${folder.name}`;
    // The collapsed strip is where a chosen icon+color earns its keep — the
    // only thing distinguishing one 36px square from the next. Status still
    // outranks it; a needs-you square never takes the calmer identity wash.
    const RepoIcon = repoIcon(repo.meta);
    const accent = repoAccentStyles(repo);
    // Attention (amber) still outranks identity. Being the active folder is a
    // ring layered on top instead, so it doesn't erase the identity wash.
    const statusOwnsEdge = needs > 0;
    return (
      <Tooltip
        key={folder.dir}
        side="right"
        content={
          <>
            {label} — ⎇ {folder.branch}
            {needs > 0 && ` · ${needs} need${needs === 1 ? "s" : ""} you`}
          </>
        }
        render={
          <button
            type="button"
            aria-label={label}
            aria-current={active || undefined}
            onClick={() => onSelectFolder(folder.dir)}
            style={statusOwnsEdge ? undefined : { ...accent.edgeStyle, ...accent.surfaceStyle }}
            className={cn(
              "relative flex size-9 shrink-0 items-center justify-center rounded-md border-l-2 border-transparent text-kumo-subtle hover:bg-kumo-tint",
              active && "border-l-agent text-kumo-default ring-1 ring-inset ring-agent/50",
              // Attention outranks focus on the accent edge (visual-design rule).
              needs > 0 && "border-l-warn",
            )}
          >
            {home ? (
              <RepoIcon className="size-4" style={accent.iconStyle} />
            ) : (
              <FolderIcon className="size-4" style={accent.iconStyle} />
            )}
            {live && <span className={cn("absolute top-1 right-1 size-2 rounded-full", live)} />}
            {needs > 0 && (
              <span className="absolute -right-1 -bottom-1 min-w-4 rounded-full border border-warn/50 bg-background px-0.5 text-center font-mono text-micro leading-[14px] text-warn">
                {needs}
              </span>
            )}
          </button>
        }
      />
    );
  };

  return (
    <div className="flex h-full w-12 shrink-0 flex-col items-center border-r bg-background py-2">
      <Tooltip
        side="right"
        content={`Expand rail (${expandHint})`}
        render={
          <button
            type="button"
            aria-label="Expand the folder rail"
            onClick={() => {
              mouseAction("ab-toggle-rail", "agentboard");
              onExpand();
            }}
            className="flex size-8 items-center justify-center rounded-md text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default"
          >
            <SidebarSimpleIcon className="size-4" />
          </button>
        }
      />
      {liveColor && (
        <Hint label={`${liveN} running session${liveN === 1 ? "" : "s"}`} side="right">
          <span className="flex items-center gap-1 py-1 font-mono text-micro text-kumo-subtle">
            <span className={cn("size-2 rounded-full", liveColor)} />
            {liveN}
          </span>
        </Hint>
      )}
      {attentionCount > 0 && (
        <Tooltip
          side="right"
          content={`${attentionCount} attention item${attentionCount === 1 ? "" : "s"} (failing PRs, imminent meeting) — expand to see`}
          render={
            <button
              type="button"
              aria-label="Expand the rail to see attention items"
              onClick={onExpand}
              className="mt-1 rounded-md border border-warn/50 bg-warn/10 px-1.5 py-0.5 font-mono text-micro text-warn hover:bg-warn/20"
            >
              {attentionCount} ⚑
            </button>
          }
        />
      )}
      <div className="my-1.5 h-px w-6 shrink-0 bg-border" />
      <div className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto">
        {repos.map((repo, i) => {
          const home = isHomeRepo(repo);
          return (
            <div key={repo.key} className="flex flex-col items-center gap-1">
              {i > 0 && <div className="my-0.5 h-px w-6 bg-border" />}
              {(home ? [repo.folders[0]] : repo.folders).map((f) => folderIcon(repo, f, home))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The agent tally pinned atop the rail: total + non-zero status buckets + a ❄
 * compact count, Agentboard settings behind the trailing ⚙. Counts the
 * *rail's* repos, not the payload's — a tally including quiet checkouts would
 * point at rows nobody can click. */
export function RollupChip({
  repos,
  compactPct,
  now,
}: {
  repos: RepoData[];
  compactPct: number;
  now: number;
}) {
  const threshold = compactPct;
  const r = agentRollup(repos, now, threshold);
  // Track the slider locally while dragging; commit on release.
  const [draft, setDraft] = useState<number | null>(null);
  const pct = draft ?? threshold;

  return (
    <div className="flex items-center gap-2.5 border-b border-kumo-hairline bg-kumo-base px-3 py-2 font-mono text-mini">
      {r.total === 0 ? (
        <span className="text-kumo-subtle">no agents running</span>
      ) : (
        <>
          <span className="text-kumo-default">
            {r.total} agent{r.total !== 1 && "s"}
          </span>
          <RollupDots r={r} bare />
          {r.expiring > 0 && (
            <Hint label="warm prompt caches about to expire — nudge them">
              <span className="text-warn">◔{r.expiring}</span>
            </Hint>
          )}
          {r.compact > 0 && (
            <Hint label="cold sessions worth compacting">
              <span className="text-info">❄{r.compact}</span>
            </Hint>
          )}
        </>
      )}
      <Popover>
        <Hint label="Agentboard settings">
          <Popover.Trigger
            render={
              <button
                type="button"
                aria-label="Agentboard settings"
                className="ml-auto text-kumo-subtle hover:text-kumo-default"
              >
                ⚙
              </button>
            }
          />
        </Hint>
        <Popover.Content align="end" className="w-72">
          <div className="flex flex-col gap-3">
            <div className="text-sm font-medium">Agentboard settings</div>
            <div className="text-xs text-kumo-subtle">
              Recommend compacting a cold session at or above{" "}
              <span className="font-mono text-info">{pct}%</span> context.
            </div>
            <Slider
              min={10}
              max={90}
              step={5}
              value={pct}
              onValueChange={(v) => setDraft(v as number)}
              onValueCommitted={(v) => {
                setDraft(null);
                fire(invoke("ab_set_compact_percent", { percent: v }));
              }}
            />
            <div className="text-mini text-kumo-subtle">
              Past this threshold, a session whose prompt cache expired shows the ❄ compact nudge.
              Stored in the shared towles-tool settings file.
            </div>
          </div>
        </Popover.Content>
      </Popover>
    </div>
  );
}
