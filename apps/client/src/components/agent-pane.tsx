import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, CornerDownLeft, Play, Square, X } from "lucide-react";
import { toast } from "sonner";
import { ChatDot, IconBtn } from "@/components/agentboard-bits";
import { Markdown } from "@/components/markdown";
import { PaneChrome, PaneLens } from "@/components/pane-chrome";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import {
  applyCommand,
  matchCommands,
  slashMenuKey,
  slashQuery,
  summarizeToolInput,
  type SlashCommand,
  type Turn,
} from "@/lib/agent";
import {
  chatStatus,
  closeChat,
  sendChat,
  startChat,
  stopChat,
  useChatSession,
  type ChatSession,
} from "@/lib/agent-sessions";
import { agentPaneId, type FolderData } from "@/lib/agentboard";
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

  const start = useCallback(
    async (prompt: string) => {
      uiAction("agent.start", "agentboard");
      const res = await startChat(agentId, dir, prompt);
      if (res.isErr() && !NotInTauri.is(res.error))
        toast.error(`Could not start agent: ${errorMessage(res.error)}`);
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
            <p className="py-10 text-center text-xs text-muted-foreground">
              {started ? "Waiting for the agent…" : "Type a prompt below to start a session here."}
            </p>
          )}
          {view.turns.map((turn) => (
            <TurnRow key={turn.id} turn={turn} />
          ))}
          {dead && (
            <p className="py-3 text-center font-mono text-[10.5px] text-muted-foreground">
              Agent exited{view.exitCode === null ? "" : ` (code ${view.exitCode})`}
            </p>
          )}
          <div ref={bottomRef} />
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

function TurnRow({ turn }: { turn: Turn }) {
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
      return <ToolRow turn={turn} />;
  }
}

function ToolRow({ turn }: { turn: Extract<Turn, { type: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const summary = summarizeToolInput(turn.input);

  return (
    <div
      className={cn(
        "rounded-lg border border-border",
        turn.isError && "border-red-500/40 bg-red-500/5",
      )}
    >
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
        <span
          className={cn(
            "size-2 shrink-0 rounded-full",
            turn.pending
              ? "animate-pulse bg-cyan-500"
              : turn.isError
                ? "bg-red-500"
                : "bg-green-500",
          )}
        />
        <span className="shrink-0 font-mono text-[11px] text-violet-500">{turn.name}</span>
        <span className="truncate font-mono text-[10.5px] text-muted-foreground" title={summary}>
          {summary}
        </span>
      </div>
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
