// One PTY session inline on its checkout's line. Status, needs-you and focus
// stay on the chip; model, cache and context live in the pane header.
import { memo, useState } from "react";
import { DotsThreeVerticalIcon, EnvelopeSimpleIcon } from "@phosphor-icons/react";
import { Hint } from "@/components/hint";
import { Glyph, HotkeyBadge, IconBtn } from "@/components/agentboard-bits/primitives";
import { Dot } from "@/components/agentboard-bits/status-dots";
import { Button, DropdownMenu } from "@cloudflare/kumo";
import { cn } from "@/lib/utils";
import { noteChip, useInbox } from "@/lib/inbox";
import type { SessionActions } from "@/lib/agentboard/actions";
import {
  claudeTitleName,
  fmtWaitingAge,
  isAgent,
  sessionCatchesEye,
  sessionLabel,
  sessionStatusText,
} from "@/lib/agentboard/session";
import type { SessionData } from "@/lib/agentboard/types";
import { fmtElapsed } from "@/lib/format";

/** Memoised: with the snapshot structurally shared, a chip whose session and
 * props held is skipped when a sibling's status moves. */
export const SessionChip = memo(function SessionChip({
  session,
  folderDir,
  now,
  title,
  active,
  cursor,
  hotkey,
  renaming,
  actions,
  onSelect,
  onRenameCommit,
}: {
  session: SessionData;
  folderDir: string;
  now: number;
  title?: string;
  active: boolean;
  /** Under the rail cursor — the chip the arrows are steering. */
  cursor: boolean;
  /** 1–9 while the jump chord is held and this chip is one of the first nine. */
  hotkey?: number;
  renaming: boolean;
  actions: SessionActions;
  onSelect: (folderDir: string, sessionId: string) => void;
  onRenameCommit: (sessionId: string, name: string) => void;
}) {
  const needs = sessionCatchesEye(session);
  const agent = isAgent(session);
  // Live only: a stopped PTY's last title lingers in the caller's `titles` map
  // and would label a dead shell as a running Claude.
  const label = (session.live ? claudeTitleName(title) : null) ?? sessionLabel(session);
  const hint = [
    sessionStatusText(session),
    session.live && fmtElapsed(now - session.createdAt),
    session.purpose && `✦ ${session.purpose}`,
    label !== session.name && session.name,
  ]
    .filter(Boolean)
    .join(" · ");
  const age = fmtWaitingAge(session.needsSinceMs, now);
  const note = noteChip(useInbox(), session.id);
  // JS state, not CSS `:hover` — WebKitGTK doesn't reliably update `:hover` on
  // real pointer movement.
  const [hovered, setHovered] = useState(false);
  if (renaming) {
    return (
      <span className="flex items-center gap-1.5 px-1.5">
        <Glyph agent={agent} />
        <input
          autoFocus
          aria-label="Session name"
          defaultValue={session.name}
          onBlur={(e) => onRenameCommit(session.id, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onRenameCommit(session.id, (e.target as HTMLInputElement).value);
            if (e.key === "Escape") onRenameCommit(session.id, session.name);
          }}
          className="w-40 rounded-sm border border-input bg-background px-1 text-xs outline-none"
        />
      </span>
    );
  }
  return (
    <Hint label={hint} side="bottom">
      <div
        role="button"
        tabIndex={0}
        aria-current={active || undefined}
        onClick={() => onSelect(folderDir, session.id)}
        onDoubleClick={() => actions.renameStart(session.id)}
        onKeyDown={(e) => e.key === "Enter" && onSelect(folderDir, session.id)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className={cn(
          "relative flex h-6 max-w-64 min-w-0 cursor-pointer items-center gap-1.5 rounded-sm pr-1.5 text-xs",
          hovered && !needs && "bg-kumo-tint",
          active && !needs && "bg-kumo-tint",
          cursor && "ring-1 ring-inset ring-agent",
          // Amber owns the fill, so focus on a needs-you chip moves to a ring.
          needs && "bg-warn/10",
          needs && hovered && "bg-warn/15",
          active && needs && "ring-1 ring-inset ring-agent/70",
        )}
      >
        {hotkey === undefined ? <Glyph agent={agent} /> : <HotkeyBadge n={hotkey} />}
        <Dot session={session} />
        <span
          className={cn(
            "min-w-0 truncate",
            session.live ? "text-kumo-default" : "text-kumo-subtle",
            active && "font-medium",
          )}
        >
          {label}
        </span>
        {note && (
          <EnvelopeSimpleIcon
            aria-label={note.kind === "pending" ? "note waiting" : "note delivered"}
            className={cn(
              "size-3 shrink-0",
              note.kind === "pending" ? "text-agent" : "text-kumo-subtle",
            )}
          />
        )}
        {age && <span className="shrink-0 font-mono text-mini text-warn">{age}</span>}
        {hovered && (
          <span className="absolute inset-y-0 right-0 z-10 flex items-center gap-0.5 rounded-r-sm bg-kumo-tint pl-1">
            <ChipControls session={session} folderDir={folderDir} actions={actions} />
          </span>
        )}
      </div>
    </Hint>
  );
});

/** ✕ close stays inline as the one action every session has; the rest vary by
 * state and live behind "···". */
function ChipControls({
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
  if (!session.live || !agent) {
    items.push({
      glyph: "✦",
      label: "Start Claude here",
      onSelect: () => actions.startClaude(folderDir, session),
      className: "text-agent",
    });
  }
  if (session.live && agent) {
    items.push({
      glyph: "■",
      label: "Stop Claude (shell survives)",
      onSelect: () => actions.stopClaude(session),
    });
    items.push({
      glyph: "✉",
      label: "Note to agent…",
      onSelect: () => actions.noteAgent(session),
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
        ghost
        title="close session"
        onClick={() => actions.close(session.id)}
        className="size-5 hover:text-danger"
      >
        ✕
      </IconBtn>
      <DropdownMenu>
        <Hint label="More actions">
          <DropdownMenu.Trigger
            render={
              <Button
                variant="ghost"
                size="xs"
                shape="square"
                aria-label="More actions"
                className="size-5 text-kumo-subtle"
                onClick={(e) => e.stopPropagation()}
                icon={<DotsThreeVerticalIcon className="size-3.5" />}
              />
            }
          />
        </Hint>
        <DropdownMenu.Content align="end" className="w-auto min-w-48">
          {items.map((item) => (
            <DropdownMenu.Item
              key={item.label}
              onClick={item.onSelect}
              className="whitespace-nowrap"
            >
              <span className={cn("w-4 text-center font-mono text-xs", item.className)}>
                {item.glyph}
              </span>
              {item.label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu>
    </>
  );
}
