// One PTY session in the rail — the row that has to hold the most status in
// the least width, since a folder can have several.
import { useState } from "react";
import { MoreVertical } from "lucide-react";
import { Hint } from "@/components/hint";
import {
  CacheBadge,
  ModelBadge,
  Dot,
  Glyph,
  HotkeyBadge,
  IconBtn,
  PortDriftBadge,
} from "@/components/agentboard-bits";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  claudeTitleName,
  fmtElapsed,
  fmtWaitingAge,
  isAgent,
  sessionCatchesEye,
  sessionLabel,
  sessionStatusText,
  type Overlay,
  type SessionActions,
  type SessionData,
} from "@/lib/agentboard";

export function SessionRow({
  session,
  folderDir,
  now,
  compactPct,
  title,
  active,
  hotkey,
  renaming,
  overlay,
  actions,
  onSelect,
  onRenameCommit,
}: {
  session: SessionData;
  folderDir: string;
  now: number;
  compactPct: number;
  title?: string;
  active: boolean;
  /** 1–9 while the jump chord is held and this row is one of the first nine. */
  hotkey?: number;
  renaming: boolean;
  overlay?: Overlay;
  actions: SessionActions;
  onSelect: () => void;
  onRenameCommit: (name: string) => void;
}) {
  // Apply the optimistic lifecycle overlay (start/stop just happened) until
  // the watcher's next scan delivers ground truth.
  const eff: SessionData =
    overlay && overlay.until > Date.now()
      ? {
          ...session,
          live: true,
          agentState: {
            agent: "claude-code",
            session: "",
            ts: now,
            ...session.agentState,
            status: overlay.status,
          },
        }
      : session;
  const needs = sessionCatchesEye(eff);
  const agent = isAgent(eff);
  // Live only: a stopped PTY's last title lingers in the caller's `titles` map
  // and would label a dead shell as a running Claude.
  const label = (eff.live ? claudeTitleName(title) : null) ?? sessionLabel(eff);
  // The session's own name rides in the tooltip once a Claude title replaces
  // it on the row, so the title keeps that width.
  const hint = [eff.purpose && `✦ ${eff.purpose}`, label !== session.name && session.name]
    .filter(Boolean)
    .join(" · ");
  const age = fmtWaitingAge(eff.needsSinceMs, now);
  // JS state, not CSS `:hover` — WebKitGTK doesn't reliably update `:hover` on
  // real pointer movement, so `group-hover` never fires.
  const [hovered, setHovered] = useState(false);
  return (
    <Hint label={hint || undefined} side="right">
      <div
        role="button"
        tabIndex={0}
        aria-current={active || undefined}
        onClick={onSelect}
        onDoubleClick={() => actions.renameStart(session.id)}
        onKeyDown={(e) => e.key === "Enter" && onSelect()}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className={cn(
          "relative ml-1.5 flex cursor-pointer items-center gap-2 border-l-2 border-transparent py-1 pr-3 pl-9",
          hovered && !needs && "bg-accent",
          active && !needs && "border-l-violet-500 bg-accent",
          // Needs-you wins over hover/active for both the edge and the fill —
          // a thin 2px border alone was too easy to miss scanning the rail, so
          // the whole row washes amber, not just its left pixel.
          needs && "border-l-amber-500 bg-amber-500/10",
          needs && hovered && "bg-amber-500/15",
          // Amber already owns the edge and the fill, so focus moves to a ring
          // — otherwise a jump between two needs-you rows lands invisibly.
          active && needs && "ring-1 ring-inset ring-violet-500/70",
        )}
      >
        {hotkey === undefined ? <Glyph agent={agent} /> : <HotkeyBadge n={hotkey} />}
        <Dot session={eff} />
        {needs && <span className="size-1.5 shrink-0 rounded-full bg-amber-500" />}
        {renaming ? (
          <input
            autoFocus
            defaultValue={session.name}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => onRenameCommit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onRenameCommit((e.target as HTMLInputElement).value);
              if (e.key === "Escape") onRenameCommit(session.name);
            }}
            className="min-w-0 flex-1 rounded-sm border border-input bg-background px-1 text-sm outline-none"
          />
        ) : (
          <>
            <span
              className={cn(
                "min-w-0 flex-1 truncate",
                eff.live ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {label}
            </span>
            {/* Meta stacks into two short lines inside the row's own height,
              so the title keeps the width a single trailing line would take.
              Both lines always render (`h-3` each) so every row is the same
              height and the status column sits at one vertical offset. The
              lifecycle controls overlay it (absolute, opaque accent) instead
              of swapping it out, so hovering never reflows the row. */}
            <span className="ml-auto flex shrink-0 flex-col items-end gap-px font-mono text-[10.5px] leading-none">
              <span className="flex h-3 items-center gap-1.5">
                {eff.live && <PortDriftBadge drift={eff.portDrift ?? []} />}
                {!agent && eff.shellKind && (
                  <span className="text-muted-foreground/50">{eff.shellKind}</span>
                )}
                <ModelBadge session={eff} className="h-3" />
                <CacheBadge
                  session={eff}
                  now={now}
                  compactPct={compactPct}
                  onCompact={() => actions.compactClaude(eff)}
                />
                {age && (
                  <Hint label="how long this has been needing you">
                    <span className="text-amber-500/80">{age}</span>
                  </Hint>
                )}
              </span>
              <span className="flex h-3 items-center gap-1.5">
                {eff.live && (
                  <Hint label="running for">
                    {/* Fixed 6ch slot: elapsed is 4–7 chars ("0:04" ..
                      "1:02:30"); without a reserved width the status word
                      after it drifts per row. */}
                    <span className="inline-block w-[6ch] text-right text-muted-foreground/70">
                      {fmtElapsed(now - eff.createdAt)}
                    </span>
                  </Hint>
                )}
                {/* Fixed 7ch slot: the status word is short and uniform
                  ("Waiting", "Working", "Done"), so it lines up across rows. */}
                <span className="inline-block w-[7ch] truncate font-sans text-[11px] text-muted-foreground">
                  {sessionStatusText(eff)}
                </span>
              </span>
            </span>
            {/* Hover-only, not hover-or-active: the selected row otherwise
              carries a resting ✕/menu forever, hiding the meta it overlays. */}
            {hovered && (
              <span className="absolute inset-y-0 right-2 z-10 flex items-center gap-1 bg-accent pl-1.5">
                <RowControls session={eff} folderDir={folderDir} actions={actions} />
              </span>
            )}
          </>
        )}
      </div>
    </Hint>
  );
}

/** ✕ close stays inline as the one action every row has; the rest vary by state
 * and live behind "···" instead of crowding the row. */
function RowControls({
  session,
  folderDir,
  actions,
}: {
  session: SessionData;
  folderDir: string;
  actions: SessionActions;
}) {
  const agent = isAgent(session);
  const st = session.agentState?.status;
  // `/compact` only lands when Claude is at its prompt, not mid-turn.
  const atPrompt = st === "waiting" || st === "idle" || st === "complete";

  const items: {
    glyph: string;
    label: string;
    onSelect: () => void;
    className?: string;
  }[] = [];
  if (!session.live) {
    items.push({
      glyph: "▶",
      label: "Start shell",
      onSelect: () => actions.start(folderDir, session),
      className: "text-green-500",
    });
  }
  if (!session.live || !agent) {
    items.push({
      glyph: "✦",
      label: "Start Claude here",
      onSelect: () => actions.startClaude(folderDir, session),
      className: "text-violet-500",
    });
  }
  if (session.live && agent) {
    items.push({
      glyph: "■",
      label: "Stop Claude (shell survives)",
      onSelect: () => actions.stopClaude(session),
    });
    if (atPrompt) {
      items.push({
        glyph: "⤿",
        label: "Compact context (/compact)",
        onSelect: () => actions.compactClaude(session),
      });
    }
    items.push({
      glyph: "↻",
      label: "Start over — fresh Claude session",
      onSelect: () => actions.restartClaude(folderDir, session),
    });
  }
  items.push({ glyph: "✎", label: "Rename", onSelect: () => actions.renameStart(session.id) });

  return (
    <>
      <IconBtn
        title="close session"
        onClick={() => actions.close(session.id)}
        className="hover:text-red-500"
      >
        ✕
      </IconBtn>
      <DropdownMenu>
        <Hint label="More actions">
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="icon-xs"
              aria-label="More actions"
              className="text-muted-foreground"
              onClick={(e) => e.stopPropagation()}
            >
              <MoreVertical className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
        </Hint>
        <DropdownMenuContent align="end" className="w-auto min-w-48">
          {items.map((item) => (
            <DropdownMenuItem
              key={item.label}
              onSelect={item.onSelect}
              className="whitespace-nowrap"
            >
              <span className={cn("w-4 text-center font-mono text-xs", item.className)}>
                {item.glyph}
              </span>
              {item.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
