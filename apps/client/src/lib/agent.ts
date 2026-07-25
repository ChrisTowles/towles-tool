/**
 * The `agent://event` wire shape, mirroring `crates/tt-agent`'s `AgentEvent`.
 *
 * This is the same relationship `term-protocol.ts` has with `tt-vt`: the Rust
 * enum and this union must change in lockstep. The `other` and `malformed`
 * variants are what let that lockstep be loose in practice — an unmodeled
 * Claude Code message arrives as `other` rather than breaking the feed, so a
 * CLI release can add message types without a frontend change.
 */

import { invoke } from "@/lib/tauri";

/** A tool call's arguments — shape varies per tool, so it stays unknown. */
export type ToolInput = Record<string, unknown>;

/** A command the session accepts. `description`/`argumentHint` are null when
 * the list came from `system/init`, which sends names only — see the Rust
 * `SlashCommand` doc for why both sources share one type. */
export type SlashCommand = {
  name: string;
  description: string | null;
  argumentHint: string | null;
  aliases: string[];
};

export type AgentEvent =
  | {
      kind: "init";
      sessionId: string;
      model: string;
      cwd: string;
      tools: string[];
      permissionMode: string;
      slashCommands: SlashCommand[];
    }
  | { kind: "commandsChanged"; commands: SlashCommand[] }
  | { kind: "text"; text: string; parentToolUseId: string | null }
  | { kind: "thinking"; text: string; parentToolUseId: string | null }
  | {
      kind: "toolUse";
      id: string;
      name: string;
      input: ToolInput;
      parentToolUseId: string | null;
    }
  | { kind: "toolResult"; toolUseId: string; content: string; isError: boolean }
  | {
      kind: "turn";
      subtype: string;
      isError: boolean;
      durationMs: number;
      numTurns: number;
      totalCostUsd: number;
    }
  | { kind: "other"; discriminant: string; raw: unknown }
  | { kind: "malformed"; line: string }
  | { kind: "exited"; code: number | null };

/** An event as it arrives over IPC: the union plus its routing id. */
export type AgentEventPayload = AgentEvent & { agentId: string };

export const AGENT_EVENT = "agent://event";

export type StartAgentRequest = {
  agentId: string;
  cwd: string;
  prompt?: string;
  model?: string;
  permissionMode?: string;
  resume?: string;
};

export const agentStart = (req: StartAgentRequest) => invoke<void>("agent_start", { req });

export const agentSend = (agentId: string, text: string) =>
  invoke<void>("agent_send", { agentId, text });

export const agentStop = (agentId: string) => invoke<void>("agent_stop", { agentId });

/**
 * One rendered row of the transcript.
 *
 * Tool calls and their results arrive as separate events, on different
 * message types (`assistant` vs `user`) and an arbitrary number of events
 * apart. {@link foldEvents} pairs them back by id so a tool renders as one
 * row that fills in, rather than a call and an orphaned result far apart.
 */
export type Turn =
  | { id: string; type: "user"; text: string }
  | { id: string; type: "text"; text: string }
  | { id: string; type: "thinking"; text: string }
  | {
      id: string;
      type: "tool";
      name: string;
      input: ToolInput;
      result?: string;
      isError?: boolean;
      /** No result yet — the call is still running. */
      pending: boolean;
    }
  | { id: string; type: "notice"; text: string; isError: boolean };

export type AgentView = {
  turns: Turn[];
  sessionId: string | null;
  model: string | null;
  /** Everything `/`-completable in this session. */
  commands: SlashCommand[];
  /** True between a submitted prompt and the `turn` event that ends it. */
  running: boolean;
  costUsd: number;
  /** Set once the process exits — the pane is dead until restarted. */
  exitCode: number | null | undefined;
};

export const emptyView = (): AgentView => ({
  turns: [],
  sessionId: null,
  model: null,
  commands: [],
  running: false,
  costUsd: 0,
  exitCode: undefined,
});

/**
 * Fold one event into the view.
 *
 * Pure and separated from the component precisely so the pairing and
 * running-state rules are unit-testable without a DOM — the repo's
 * logic-in-`lib` testing convention.
 */
export function foldEvent(view: AgentView, event: AgentEvent): AgentView {
  switch (event.kind) {
    case "init":
      return {
        ...view,
        sessionId: event.sessionId,
        model: event.model,
        commands: event.slashCommands,
        running: true,
      };
    case "commandsChanged":
      // Wholesale replacement, not a merge: the CLI rebuilt its command set,
      // so a command absent from the new list is genuinely gone.
      return { ...view, commands: event.commands };
    case "text":
      return {
        ...view,
        turns: [...view.turns, { id: `text-${view.turns.length}`, type: "text", text: event.text }],
      };
    case "thinking":
      return {
        ...view,
        turns: [
          ...view.turns,
          { id: `thinking-${view.turns.length}`, type: "thinking", text: event.text },
        ],
      };
    case "toolUse":
      return {
        ...view,
        turns: [
          ...view.turns,
          {
            id: event.id,
            type: "tool",
            name: event.name,
            input: event.input,
            pending: true,
          },
        ],
      };
    case "toolResult":
      return {
        ...view,
        turns: view.turns.map((t) =>
          t.type === "tool" && t.id === event.toolUseId
            ? { ...t, result: event.content, isError: event.isError, pending: false }
            : t,
        ),
      };
    case "turn":
      return { ...view, running: false, costUsd: view.costUsd + event.totalCostUsd };
    case "exited":
      // Clear `running`: an agent that died mid-turn never sends the `turn`
      // event, and a spinner that never stops reads as a hang.
      return { ...view, running: false, exitCode: event.code };
    case "malformed":
      return {
        ...view,
        turns: [
          ...view.turns,
          {
            id: `malformed-${view.turns.length}`,
            type: "notice",
            text: `Unparseable output: ${event.line}`,
            isError: true,
          },
        ],
      };
    case "other":
      // Protocol noise (status ticks, token counters, stream deltas). Kept
      // out of the transcript by design — see the Raw toggle on the screen.
      return view;
  }
}

export const foldEvents = (events: AgentEvent[], from: AgentView = emptyView()): AgentView =>
  events.reduce(foldEvent, from);

/**
 * Append what the user just sent.
 *
 * Echoed locally rather than read off the wire: the CLI does not send user
 * turns back unless started with `--replay-user-messages`, and the only `user`
 * messages we *do* receive are tool results. Without this the composer clears
 * and the prompt vanishes, leaving a reply with nothing to read it against.
 *
 * If this ever gains `--replay-user-messages`, drop this echo rather than
 * keeping both — they would double every turn.
 */
export function appendUserTurn(view: AgentView, text: string): AgentView {
  return {
    ...view,
    turns: [...view.turns, { id: `user-${view.turns.length}`, type: "user", text }],
  };
}

/** A one-line summary of a tool call, for the collapsed row. */
export function summarizeToolInput(input: ToolInput): string {
  for (const key of ["file_path", "path", "command", "pattern", "url", "prompt", "description"]) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  const json = JSON.stringify(input);
  return json === "{}" || json === undefined ? "" : json;
}

/**
 * The command-name fragment the caret sits in, or null when the `/` menu
 * should stay shut.
 *
 * The menu opens only for a `/` at the very start of the draft: a slash
 * anywhere else is ordinary prose (a path, a fraction, a closing tag), and
 * Claude Code itself only treats a leading slash as a command. It closes once
 * a space is typed, because from there on the user is writing *arguments*, not
 * picking a command.
 */
export function slashQuery(draft: string): string | null {
  if (!draft.startsWith("/")) return null;
  const rest = draft.slice(1);
  return /\s/.test(rest) ? null : rest;
}

/**
 * Commands matching `query`, best first.
 *
 * Ranked rather than merely filtered, because the list runs to ~90 entries and
 * a plain substring filter buries `/context` under `plugin-dev:command-
 * development` for the query "co". Prefix beats interior, name beats alias,
 * and ties keep the CLI's own ordering.
 */
export function matchCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase();
  const rank = (c: SlashCommand): number => {
    const name = c.name.toLowerCase();
    if (name.startsWith(q)) return 0;
    // A `plugin:command` entry should match on the bare command too — that
    // trailing part is what a user remembers.
    if (name.split(":").pop()?.startsWith(q)) return 1;
    if (c.aliases.some((a) => a.toLowerCase().startsWith(q))) return 2;
    if (name.includes(q)) return 3;
    return -1;
  };
  return commands
    .map((c, i) => ({ c, r: rank(c), i }))
    .filter((x) => x.r >= 0)
    .toSorted((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.c);
}

/** Replace the typed fragment with a chosen command, ready for arguments. */
export function applyCommand(command: SlashCommand): string {
  return `/${command.name} `;
}

/** What a keystroke should do while the `/` menu is open. */
export type SlashMenuAction =
  | { type: "move"; cursor: number }
  | { type: "pick" }
  | { type: "dismiss" };

/**
 * Decide how the open `/` menu handles a keystroke, or null to let the
 * composer have it.
 *
 * Extracted from the component because this is exactly the logic that a
 * synthetic keydown test would certify without proving anything about the real
 * platform — the repo's rule is to unit-test the pure seam and verify the rest
 * by driving the app. `count` is assumed > 0; the menu is never open empty.
 */
export function slashMenuKey(
  key: string,
  state: { count: number; cursor: number },
): SlashMenuAction | null {
  const { count, cursor } = state;
  switch (key) {
    // Wraps in both directions: with ~90 commands, running off the end and
    // stopping there is worse than cycling.
    case "ArrowDown":
      return { type: "move", cursor: (cursor + 1) % count };
    case "ArrowUp":
      return { type: "move", cursor: (cursor - 1 + count) % count };
    // Enter picks rather than sending — the draft is a half-typed command
    // name, which would be a nonsense prompt.
    case "Tab":
    case "Enter":
      return { type: "pick" };
    case "Escape":
      return { type: "dismiss" };
    default:
      return null;
  }
}
