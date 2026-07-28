/**
 * The rail rows that aren't a PTY session: a chat (`AgentPane`) and the view
 * panes (diff, files, preview, jarvis), plus the colored spine that brackets a
 * multi-pane window's rows.
 *
 * They live together because they share one shape — a pane, not a process —
 * and one rule: a view pane is a *view of* the folder, so it carries no status
 * and closes without asking, while a chat owns a conversation and reports one.
 */
import { useState } from "react";
import { AppWindow, Box, Files, GitCompare } from "lucide-react";
import { ChatDot, IconBtn } from "@/components/agentboard-bits";
import { cn } from "@/lib/utils";
import { chatStatus, useChatSession, type ChatStatus } from "@/lib/agent-sessions";
import {
  agentPaneId,
  isDiffPane,
  isFilesPane,
  isJarvisPane,
  isPreviewPane,
  windowColor,
  type AgWindow,
} from "@/lib/agentboard";

/** Vertical color spine beside a multi-pane window's rows in the rail: the
 * window's group color as a thin bar bracketing its sessions, clicking
 * focuses that window in the pane area. Replaces the old text label — window
 * names carry no signal in the rail; the color + tooltip is enough. */
export function WindowSpine({
  win,
  folderWins,
  count,
  onFocus,
}: {
  win: AgWindow;
  folderWins: AgWindow[];
  count: number;
  onFocus: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onFocus}
      title={`window “${win.name}” — ${count} panes, click to focus`}
      aria-label={`Focus window ${win.name}`}
      className="absolute inset-y-1 left-4 z-10 flex w-2 justify-center"
    >
      <span className={cn("h-full w-[3px] rounded-full", windowColor(folderWins, win.id))} />
    </button>
  );
}

/** The pane kinds that are a *view of* the folder rather than something
 * running in it — each still gets a rail row, so what's open in a folder is
 * answerable from the rail alone. */
export type ViewPaneKind = "diff" | "files" | "preview" | "jarvis";

export function viewPaneKind(paneId: string): ViewPaneKind | null {
  if (isDiffPane(paneId)) return "diff";
  if (isFilesPane(paneId)) return "files";
  if (isPreviewPane(paneId)) return "preview";
  if (isJarvisPane(paneId)) return "jarvis";
  return null;
}

const VIEW_PANE_META: Record<
  ViewPaneKind,
  { Icon: typeof GitCompare; label: string; title: string }
> = {
  diff: { Icon: GitCompare, label: "diff", title: "This checkout's changed files, side by side" },
  files: { Icon: Files, label: "files", title: "This checkout's file tree and editor" },
  preview: { Icon: AppWindow, label: "preview", title: "This checkout's live dev server" },
  jarvis: { Icon: Box, label: "jarvis", title: "A native Bevy surface tiled in this window" },
};

/**
 * A folder's diff / files / preview pane as a rail row.
 *
 * Quieter than a session or chat row — no status dot, since there is nothing
 * running to have a status — but present, because "what is open in this folder"
 * is a question the rail should answer. Clicking focuses the pane (the same
 * call the folder header's chip makes, which is a no-op placement when the pane
 * already exists); ✕ closes it.
 */
export function ViewPaneRow({
  kind,
  active,
  onSelect,
  onClose,
}: {
  kind: ViewPaneKind;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const { Icon, label, title } = VIEW_PANE_META[kind];
  const [hovered, setHovered] = useState(false);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-current={active || undefined}
      title={title}
      onClick={onSelect}
      onKeyDown={(e) => e.key === "Enter" && onSelect()}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={cn(
        "relative ml-1.5 flex cursor-pointer items-center gap-2.5 border-l-2 border-transparent py-1 pr-3 pl-9",
        hovered && "bg-accent",
        active && "border-l-violet-500 bg-accent",
      )}
    >
      <Icon className="w-4 shrink-0 text-muted-foreground/60" />
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
        {label}
      </span>
      {hovered && (
        <span className="absolute inset-y-0 right-2 z-10 flex items-center gap-1 bg-accent pl-1.5">
          <IconBtn title={`close ${label} pane`} onClick={onClose} className="hover:text-red-500">
            ✕
          </IconBtn>
        </span>
      )}
    </div>
  );
}

/** Row text per chat status — the same short, uniform-width words
 * `sessionStatusText` uses for PTY sessions. */
const CHAT_STATUS_TEXT: Record<ChatStatus, string> = {
  /** Pane open, nothing started yet — the composer is waiting on you. */
  off: "Ready",
  working: "Working",
  asking: "Asking",
  idle: "Idle",
  exited: "Exited",
  error: "Error",
};

/**
 * A folder's chat pane as a rail row, beside its shells.
 *
 * Not a `SessionRow`: a chat is not a PTY, so it has none of what that row
 * reports (no shell kind, no elapsed PTY time, no prompt-cache badge, no
 * rename — its identity is the folder). What it does share is the shape — glyph,
 * status dot, label, right-aligned meta, hover ✕ — so scanning the rail reads
 * as one list rather than two. The status comes from `lib/agent-sessions`,
 * which is why it can be shown here at all: while the transcript lived inside
 * the pane, nothing outside it could know a session was running.
 */
export function ChatRow({
  folderDir,
  active,
  onSelect,
  onClose,
}: {
  folderDir: string;
  /** This chat's pane is the focused tile in the pane area. */
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const session = useChatSession(agentPaneId(folderDir));
  const status = chatStatus(session);
  const [hovered, setHovered] = useState(false);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-current={active || undefined}
      title="Claude chat in this checkout — structured turns, not a terminal"
      onClick={onSelect}
      onKeyDown={(e) => e.key === "Enter" && onSelect()}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={cn(
        "relative ml-1.5 flex cursor-pointer items-center gap-2.5 border-l-2 border-transparent py-1.5 pr-3 pl-9",
        hovered && "bg-accent",
        active && "border-l-violet-500 bg-accent",
      )}
    >
      {/* ✦ is the app-wide "a Claude session lives here" glyph — the same one
          `Glyph` puts on an agent session row and the ✦ chat buttons use. */}
      <span className="w-4 shrink-0 text-center font-mono text-xs text-violet-500">✦</span>
      <ChatDot status={status} />
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          status === "off" ? "text-muted-foreground" : "text-foreground",
        )}
      >
        chat
      </span>
      <span className="ml-auto flex min-w-0 shrink items-center gap-2">
        {session.view.model && (
          <span className="shrink-0 truncate font-mono text-[10.5px] text-muted-foreground/70">
            {session.view.model}
          </span>
        )}
        {session.view.costUsd > 0 && (
          <span
            className="shrink-0 font-mono text-[10.5px] text-muted-foreground/70"
            title="what this conversation has cost so far"
          >
            ${session.view.costUsd.toFixed(2)}
          </span>
        )}
        {/* Same fixed 7ch slot the session rows use, so the status column
            lines up down the whole folder rather than per row kind. */}
        <span className="inline-block w-[7ch] shrink-0 truncate text-[11px] text-muted-foreground">
          {CHAT_STATUS_TEXT[status]}
        </span>
      </span>
      {hovered && (
        <span className="absolute inset-y-0 right-2 z-10 flex items-center gap-1 bg-accent pl-1.5">
          <IconBtn
            title="close chat (ends the session)"
            onClick={onClose}
            className="hover:text-red-500"
          >
            ✕
          </IconBtn>
        </span>
      )}
    </div>
  );
}
