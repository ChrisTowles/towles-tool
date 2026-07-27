import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronRight, CornerDownLeft, History, Play, Square, X } from "lucide-react";
import { toast } from "sonner";
import { ChatDot, IconBtn } from "@/components/agentboard-bits";
import { PermissionCard } from "@/components/agent-prompt-card";
import { Markdown } from "@/components/markdown";
import { PaneChrome, PaneLens } from "@/components/pane-chrome";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  agentResumableSessions,
  applyCommand,
  matchCommands,
  slashMenuKey,
  slashQuery,
  summarizeToolInput,
  type ResumableSession,
  type SlashCommand,
  type Turn,
  type Verdict,
} from "@/lib/agent";
import {
  chatStatus,
  closeChat,
  resumeChat,
  sendChat,
  startChat,
  stopChat,
  useChatSession,
  type ChatSession,
} from "@/lib/agent-sessions";
import { agentPaneId, type FolderData } from "@/lib/agentboard";
import { fmtAge } from "@/lib/data";
import { useClipboardCopy } from "@/lib/use-clipboard-copy";
import { errorMessage, NotInTauri } from "@/lib/errors";
import { uiAction } from "@/lib/ui-action";
import { cn } from "@/lib/utils";

/**
 * A Claude Code session in this folder, rendered as structured turns instead
 * of PTY scrollback — tool calls as collapsible rows with their results paired
 * back, plus cost and status as facts rather than text to scan.
 *
 * The complement to the folder's terminal panes, not a replacement: a terminal
 * is precision going *in* (every keystroke reaches the CLI, including the
 * things this pane has no affordance for), this is comprehension coming
 * *back*. Both can be open on the same checkout at once, which is why the
 * lens chip says `chat` where a PTY Claude pane says `claude`.
 *
 * **The pane id is the backend session key**, and it is folder-scoped
 * (`agentPaneId`), so there is exactly one rendered agent per folder. All
 * transcript logic lives in `lib/agent.ts` (`foldEvent`) and the session state
 * itself in `lib/agent-sessions.ts` — deliberately *outside* this component,
 * because the pane unmounts whenever its folder isn't the active one and
 * neither the conversation nor the `claude` process may die with it. This file
 * is the shell around both.
 */
export function AgentPane({
  folder,
  focused,
  onClose,
}: {
  folder: FolderData | undefined;
  focused: boolean;
  onClose: () => void;
}) {
  const dir = folder?.dir ?? "";
  const agentId = agentPaneId(dir);
  const session = useChatSession(agentId);
  const { view, started } = session;
  const [draft, setDraft] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // The `/` menu. `dismissed` is separate from "no matches" so Escape can
  // close the menu without also clearing what the user typed.
  const [dismissed, setDismissed] = useState(false);
  const [cursor, setCursor] = useState(0);
  const query = slashQuery(draft);
  const matches = useMemo(
    () => (query === null ? [] : matchCommands(view.commands, query)),
    [query, view.commands],
  );
  const menuOpen = !dismissed && query !== null && matches.length > 0;
  const active = matches[Math.min(cursor, matches.length - 1)];

  // Any edit re-opens the menu and re-homes the selection: after Escape,
  // typing another character means the user wants it back.
  function editDraft(next: string) {
    setDraft(next);
    setDismissed(false);
    setCursor(0);
  }

  function complete(command: SlashCommand) {
    setDraft(applyCommand(command));
    setDismissed(false);
    setCursor(0);
    taRef.current?.focus();
  }

  // Closing the pane is what ends the session — the agent is owned by the
  // pane, the same way a terminal's shell is owned by its `TerminalView`.
  // Unmount is the catch-all because a pane leaves the layout by several
  // routes (its own ✕, the rail row's ✕, closing its window, the layout
  // prune), and only one of them runs through `onClose`. This is *not* the
  // folder-switch path any more: `PaneGrid` keeps every open chat pane mounted
  // and merely hides the ones outside the active window, exactly as it already
  // did for terminals — so this fires only when the pane is genuinely gone.
  useEffect(() => () => closeChat(agentId), [agentId]);

  // Follow the tail as turns land. `end` rather than `start` so a long tool
  // result doesn't scroll its own top out of view.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [view.turns]);

  const [resuming, setResuming] = useState(false);

  const start = useCallback(
    async (prompt: string) => {
      uiAction("agent.start", "agentboard");
      const res = await startChat(agentId, dir, prompt);
      if (res.isErr() && !NotInTauri.is(res.error))
        toast.error(`Could not start agent: ${errorMessage(res.error)}`);
    },
    [agentId, dir],
  );

  const resume = useCallback(
    async (sessionId: string) => {
      uiAction("agent.resume", "agentboard");
      const res = await resumeChat(agentId, dir, sessionId);
      if (res.isErr() && !NotInTauri.is(res.error))
        toast.error(`Could not resume session: ${errorMessage(res.error)}`);
      else taRef.current?.focus();
    },
    [agentId, dir],
  );

  const submit = useCallback(async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    if (!started) return start(text);

    uiAction("agent.send", "agentboard");
    if ((await sendChat(agentId, text)).isErr())
      toast.error("Agent is not running — start it again.");
  }, [agentId, draft, start, started]);

  const stop = useCallback(async () => {
    uiAction("agent.stop", "agentboard");
    await stopChat(agentId);
  }, [agentId]);

  const dead = view.exitCode !== undefined;

  return (
    <div
      className={cn(
        "flex h-full flex-col overflow-hidden rounded-lg border bg-card",
        focused && "border-violet-500/60",
      )}
    >
      <PaneChrome
        lens={<PaneLens kind="chat" title="A Claude Code session rendered as structured turns" />}
        subject={
          view.model ? (
            <span className="font-mono text-[11px] text-muted-foreground">{view.model}</span>
          ) : undefined
        }
        controls={<AgentStatus session={session} />}
        actions={
          <>
            {view.sessionId && <SessionIdChip sessionId={view.sessionId} dir={dir} />}
            {view.costUsd > 0 && (
              <span className="font-mono text-[10.5px] text-muted-foreground">
                ${view.costUsd.toFixed(4)}
              </span>
            )}
            {started && !dead && (
              <IconBtn title="Stop this agent" onClick={() => void stop()}>
                <Square className="size-3" />
              </IconBtn>
            )}
            <IconBtn title="Close pane" onClick={onClose}>
              <X className="size-3.5" />
            </IconBtn>
          </>
        }
      />

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-2 p-3">
          {view.turns.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-10">
              <p className="text-center text-xs text-muted-foreground">
                {started
                  ? "Waiting for the agent…"
                  : "Type a prompt below to start a session here."}
              </p>
              {!started && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[11px]"
                  onClick={() => setResuming(true)}
                >
                  <History className="size-3" />
                  Resume a session…
                </Button>
              )}
            </div>
          )}
          {view.turns.map((turn) => (
            <TurnRow key={turn.id} turn={turn} agentId={agentId} />
          ))}
          {dead && (
            <p className="py-3 text-center font-mono text-[10.5px] text-muted-foreground">
              Agent exited{view.exitCode === null ? "" : ` (code ${view.exitCode})`}
            </p>
          )}
          <div ref={bottomRef} />
          <ResumeDialog
            dir={dir}
            open={resuming}
            onOpenChange={setResuming}
            onPick={(sessionId) => {
              setResuming(false);
              void resume(sessionId);
            }}
          />
        </div>
      </ScrollArea>

      <div className="relative flex items-end gap-2 border-t border-border p-2">
        {menuOpen && <SlashMenu matches={matches} activeName={active?.name} onPick={complete} />}
        <Textarea
          ref={taRef}
          value={draft}
          onChange={(e) => editDraft(e.target.value)}
          onKeyDown={(e) => {
            // While the menu is up it owns the navigation keys — otherwise
            // Enter would send the half-typed `/cont` as a prompt.
            if (menuOpen) {
              const action = slashMenuKey(e.key, {
                count: matches.length,
                cursor: Math.min(cursor, matches.length - 1),
              });
              if (action) {
                e.preventDefault();
                if (action.type === "move") setCursor(action.cursor);
                else if (action.type === "pick") {
                  if (active) complete(active);
                } else setDismissed(true);
                return;
              }
            }
            // Enter sends, Shift+Enter breaks the line. No `stopPropagation`:
            // the registry already refuses to fire from a textarea, and
            // swallowing the event here would also kill the `allowInEditable`
            // shortcuts (⌘⇧N/⌘⇧P) that are meant to work from anywhere.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={started ? "Reply to the agent…" : "What should the agent do here?"}
          className="max-h-32 min-h-12 resize-none text-xs"
        />
        <Button size="sm" onClick={() => void submit()} disabled={!draft.trim()}>
          {started ? <CornerDownLeft className="size-3" /> : <Play className="size-3" />}
          {started ? "Send" : "Start"}
        </Button>
      </div>
    </div>
  );
}

/** The `/` completion list. Anchored above the composer because the pane's
 * bottom edge is the window's — a dropdown would render off-screen. */
function SlashMenu({
  matches,
  activeName,
  onPick,
}: {
  matches: SlashCommand[];
  activeName: string | undefined;
  onPick: (c: SlashCommand) => void;
}) {
  return (
    <div className="absolute bottom-full left-2 z-20 mb-1 max-h-72 w-[min(34rem,calc(100%-1rem))] overflow-y-auto rounded-lg border border-border bg-card shadow-lg">
      {matches.map((c) => {
        const isActive = c.name === activeName;
        return (
          <div
            key={c.name}
            role="button"
            tabIndex={-1}
            // `onMouseDown`, not `onClick`: the textarea must not lose focus
            // before the completion lands, or the caret jumps out of the
            // composer mid-pick.
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(c);
            }}
            className={cn(
              "flex cursor-pointer items-baseline gap-2 px-3 py-1.5 hover:bg-accent/50",
              // A left edge on the active row, not fill alone: the menu is a
              // long scrolling list and the fill is easy to lose track of
              // while arrowing through it.
              isActive
                ? "bg-accent border-l-2 border-l-violet-500 pl-2.5"
                : "border-l-2 border-l-transparent pl-2.5",
            )}
          >
            {/* 13px is the app's base size — the row is a name you read, not a
                dense git stat, so it gets that rather than the 10–11px the
                chips use. `text-foreground` with only the slash tinted keeps
                the name at full contrast; violet on the whole string was both
                small and low-contrast. */}
            <span className="shrink-0 font-mono text-[13px] text-foreground">
              <span className="text-violet-500">/</span>
              {c.name}
            </span>
            {c.argumentHint && (
              <span className="shrink-0 font-mono text-xs text-muted-foreground/70">
                {c.argumentHint}
              </span>
            )}
            {c.description && (
              <span className="truncate text-xs text-muted-foreground">{c.description}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function AgentStatus({ session }: { session: ChatSession }) {
  const status = chatStatus(session);
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <ChatDot status={status} />
      <span className="font-mono text-[10.5px] text-muted-foreground">
        {status === "off" ? "idle" : status}
      </span>
    </span>
  );
}

function TurnRow({ turn, agentId }: { turn: Turn; agentId: string }) {
  switch (turn.type) {
    case "user":
      // Right-inset and violet-edged so a glance down the transcript separates
      // what you asked from what came back, without a chat-bubble motif the
      // rest of the app doesn't use.
      return (
        <div className="ml-6 rounded-lg border-l-2 border-l-violet-500 bg-accent/60 px-2.5 py-1.5 text-xs whitespace-pre-wrap text-foreground">
          {turn.text}
        </div>
      );
    case "text":
      return <Markdown content={turn.text} className="px-0.5 text-xs" />;
    case "thinking":
      return (
        <details className="px-2.5 py-1">
          <summary className="cursor-pointer text-[10.5px] text-muted-foreground/60">
            thinking
          </summary>
          <div className="pt-1.5 text-[11px] whitespace-pre-wrap text-muted-foreground">
            {turn.text}
          </div>
        </details>
      );
    case "notice":
      return (
        <div
          className={cn(
            "rounded-lg px-2.5 py-1.5 font-mono text-[10.5px]",
            turn.isError ? "bg-red-500/10 text-red-500" : "text-muted-foreground",
          )}
        >
          {turn.text}
        </div>
      );
    case "tool":
      return <ToolRow turn={turn} agentId={agentId} />;
  }
}

/** How an answered prompt reads afterwards. Kept terse — it is a footnote on a
 * row you already decided, not a result. */
const VERDICT_TEXT: Record<Verdict, string> = {
  allow: "allowed",
  answered: "answered",
  deny: "denied",
  cancelled: "cancelled",
};

/** Border + dot per row state, derived once from the same precedence so the two
 * can't disagree about what a row is doing. Blocked outranks everything: it is
 * the only state that needs the user. */
const TOOL_ROW_TONE = {
  blocked: { row: "border-amber-500/60 bg-amber-500/5", dot: "animate-pulse bg-amber-500" },
  pending: { row: "border-border", dot: "animate-pulse bg-cyan-500" },
  error: { row: "border-red-500/40 bg-red-500/5", dot: "bg-red-500" },
  done: { row: "border-border", dot: "bg-green-500" },
} as const;

function toolRowTone(turn: Extract<Turn, { type: "tool" }>): keyof typeof TOOL_ROW_TONE {
  if (turn.permission) return "blocked";
  if (turn.pending) return "pending";
  return turn.isError ? "error" : "done";
}

function ToolRow({ turn, agentId }: { turn: Extract<Turn, { type: "tool" }>; agentId: string }) {
  const summary = summarizeToolInput(turn.input);
  const [open, setOpen] = useState(false);
  const tone = TOOL_ROW_TONE[toolRowTone(turn)];

  return (
    <div className={cn("rounded-lg border", tone.row)}>
      {/* Not a <button>: the expanded body holds selectable content and its own
          scrollers, which React rejects inside a button — at runtime only. */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => e.key === "Enter" && setOpen((v) => !v)}
        className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 hover:bg-accent/50"
      >
        <ChevronRight
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        <span className={cn("size-2 shrink-0 rounded-full", tone.dot)} />
        <span className="shrink-0 font-mono text-[11px] text-violet-500">{turn.name}</span>
        <span className="truncate font-mono text-[10.5px] text-muted-foreground" title={summary}>
          {turn.permission?.description ?? summary}
        </span>
        {turn.verdict && (
          <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground/70">
            {VERDICT_TEXT[turn.verdict]}
          </span>
        )}
      </div>
      {/* Outside the collapsible body: a decision the agent is blocked on must
          never be behind a disclosure triangle. */}
      {turn.permission && <PermissionCard agentId={agentId} request={turn.permission} />}
      {open && (
        <div className="space-y-1.5 border-t border-border px-2.5 py-1.5">
          <pre className="overflow-x-auto font-mono text-[10.5px] text-muted-foreground">
            {JSON.stringify(turn.input, null, 2)}
          </pre>
          {turn.result !== undefined && (
            <pre
              className={cn(
                "max-h-56 overflow-auto font-mono text-[10.5px]",
                turn.isError ? "text-red-500" : "text-foreground",
              )}
            >
              {turn.result}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The session id, and the bridge out of this pane into a terminal.
 *
 * A chat pane runs a real `claude` in the folder, so its transcript is an
 * ordinary Claude Code session — `claude --resume <id>` from that folder picks
 * it up with full context, verified against a live session. That makes the id
 * the one piece of state worth exposing: without it the conversation is
 * reachable only through this pane, and closing the pane looks like losing it.
 */
function SessionIdChip({ sessionId, dir }: { sessionId: string; dir: string }) {
  const { copiedKey, copy } = useClipboardCopy();
  const command = `claude --resume ${sessionId}`;
  const copied = copiedKey === sessionId;

  return (
    // Radix, not a native `title`: the webview swallows those unreliably (see
    // `IconBtn`), and a multi-line hint is exactly what a `title` can't render.
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => {
            uiAction("agent.copy_resume", "agentboard");
            copy(sessionId, command);
          }}
          className="flex shrink-0 items-center gap-1 rounded px-1 font-mono text-[10px] text-muted-foreground hover:bg-accent/50 hover:text-foreground"
        >
          {copied ? (
            <Check className="size-2.5 text-green-500" />
          ) : (
            <History className="size-2.5" />
          )}
          {copied ? "copied" : sessionId.slice(0, 8)}
        </button>
      </TooltipTrigger>
      {/* The full command, not the bare id: what you do with this is paste it
          into a shell, and reconstructing the flag from memory is the step
          people get wrong. */}
      <TooltipContent className="font-mono text-[10px]">
        <div>{dir}</div>
        <div>$ {command}</div>
        <div className="font-sans text-muted-foreground">Click to copy the resume command.</div>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Pick a prior session in this folder to continue.
 *
 * The list is every Claude Code session launched here — this pane's own and
 * any from a terminal or a bare `claude` in the same directory, because they
 * are the same kind of transcript. That symmetry is the point: work started at
 * the CLI can be picked up in the pane and vice versa, and neither surface
 * owns the conversation.
 *
 * Scanned on open rather than kept fresh: it is read once, by a deliberate
 * click, and a session started after the dialog opened is not one the user is
 * looking for.
 */
function ResumeDialog({
  dir,
  open,
  onOpenChange,
  onPick,
}: {
  dir: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (sessionId: string) => void;
}) {
  const [sessions, setSessions] = useState<ResumableSession[] | null>(null);

  useEffect(() => {
    if (!open) return;
    setSessions(null);
    void (async () => {
      const found = await agentResumableSessions(dir);
      // An empty list and a failed scan read the same to the user here — there
      // is nothing to resume either way — so this degrades rather than
      // reporting, except outside Tauri where it is expected.
      setSessions(found.unwrapOr([]));
    })();
  }, [open, dir]);

  const now = Date.now();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Resume a session</DialogTitle>
          <DialogDescription>
            Claude Code sessions started in this folder — from this pane or from a terminal.
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-80">
          <div className="flex flex-col gap-1 pr-2">
            {sessions === null && (
              <p className="py-6 text-center text-xs text-muted-foreground">Looking…</p>
            )}
            {sessions?.length === 0 && (
              <p className="py-6 text-center text-xs text-muted-foreground">
                No previous sessions in this folder.
              </p>
            )}
            {sessions?.map((s) => (
              <button
                key={s.sessionId}
                type="button"
                onClick={() => onPick(s.sessionId)}
                className="flex flex-col items-start gap-0.5 rounded-md border border-border px-2.5 py-1.5 text-left hover:bg-accent/50"
              >
                <span className="line-clamp-2 text-xs text-foreground">
                  {s.title ?? (
                    <span className="font-mono text-muted-foreground">{s.sessionId}</span>
                  )}
                </span>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {fmtAge(s.mtime, now)} · {s.userTurns} turn{s.userTurns === 1 ? "" : "s"}
                  {s.costUsd > 0 && ` · $${s.costUsd.toFixed(2)}`}
                </span>
              </button>
            ))}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
