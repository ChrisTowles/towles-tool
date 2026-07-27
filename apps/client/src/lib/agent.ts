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

/**
 * The CLI asking permission — and, when `requiresUserInteraction` is set,
 * asking the user a question outright. Mirrors Rust's `control::
 * PermissionRequest`.
 *
 * **The agent is stopped until this is answered.** Unlike every other event
 * here, ignoring one is not a rendering choice; it is a hang.
 */
export type PermissionRequest = {
  requestId: string;
  toolName: string;
  displayName: string | null;
  description: string | null;
  toolUseId: string | null;
  input: ToolInput;
  /** "Always allow" offers, in the CLI's own vocabulary. Echoed back verbatim
   * when accepted — never constructed here. */
  suggestions: unknown[];
  requiresUserInteraction: boolean;
};

/** The answer. `updatedInput` is how a question tool is *answered* rather than
 * merely permitted; `message` on a deny reaches the model as the tool result. */
export type PermissionDecision =
  | { kind: "allow"; updatedInput?: ToolInput; updatedPermissions?: unknown[] }
  | { kind: "deny"; message?: string }
  | { kind: "cancelled" };

/** One question inside an `AskUserQuestion` call. */
export type AskQuestion = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
};

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
  | ({ kind: "permissionRequest" } & PermissionRequest)
  | { kind: "unsupportedControlRequest"; requestId: string; subtype: string }
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
 * A prior `claude` session in this folder, offered for resuming.
 *
 * These are ordinary Claude Code transcripts — the chat pane spawns a real
 * `claude` in the folder, so its sessions land in `~/.claude/projects/` exactly
 * like a terminal one's and the two are mutually resumable. Nothing here is
 * specific to the pane.
 */
export type ResumableSession = {
  sessionId: string;
  title: string | null;
  mtime: number;
  userTurns: number;
  costUsd: number;
};

export const agentResumableSessions = (dir: string) =>
  invoke<ResumableSession[]>("agent_resumable_sessions", { dir });

export const agentRespond = (
  agentId: string,
  requestId: string,
  toolName: string,
  verdict: Verdict,
  decision: PermissionDecision,
) => invoke<void>("agent_respond", { agentId, requestId, toolName, verdict, decision });

/** How a permission prompt ended, once it has. Kept on the turn so an answered
 * card collapses to a record of what you decided instead of vanishing. */
export type Verdict = "allow" | "answered" | "deny" | "cancelled";

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
      /** The CLI is blocked on this call and waiting for a decision. */
      permission?: PermissionRequest;
      /** What was decided, once it was. */
      verdict?: Verdict;
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
      // Records the session; deliberately does *not* set `running`. A session
      // starting is not a turn in flight — the caller that sent something owns
      // that flag (`startChat`/`sendChat` set it optimistically). Forcing it
      // true here would leave a resumed session, which reattaches without
      // sending anything, spinning on a turn that was never asked for.
      return {
        ...view,
        sessionId: event.sessionId,
        model: event.model,
        commands: event.slashCommands,
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
            ? {
                ...t,
                result: event.content,
                isError: event.isError,
                pending: false,
                // A result settles the gate whatever happened to the card —
                // the CLI ran (or refused) the call, so a prompt still on
                // screen for it is stale and would answer into the void.
                permission: undefined,
              }
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
    case "permissionRequest": {
      const { kind: _kind, ...request } = event;
      // Attach to the call it is about rather than appending a second row: the
      // `toolUse` message arrives first, so the row is already on screen and
      // turning it into the decision card keeps one call to one row.
      const target = view.turns.find(
        (t) => t.type === "tool" && t.id === request.toolUseId && !t.verdict,
      );
      if (target)
        return {
          ...view,
          turns: view.turns.map((t) => (t === target ? { ...t, permission: request } : t)),
        };
      // No matching call — the prompt still has to be answerable, so it gets a
      // row of its own rather than being dropped on the floor.
      return {
        ...view,
        turns: [
          ...view.turns,
          {
            id: `perm-${request.requestId}`,
            type: "tool",
            name: request.toolName,
            input: request.input,
            pending: true,
            permission: request,
          },
        ],
      };
    }
    case "unsupportedControlRequest":
      // Already refused in Rust — recorded, not actionable. It means the CLI
      // asked for something this client doesn't implement, which is worth
      // seeing when a feature mysteriously doesn't work.
      return {
        ...view,
        turns: [
          ...view.turns,
          {
            id: `unsupported-${event.requestId}`,
            type: "notice",
            text: `Declined an unsupported request from Claude Code: ${event.subtype}`,
            isError: false,
          },
        ],
      };
    case "other":
      // Protocol noise (status ticks, token counters, stream deltas). Kept
      // out of the transcript by design — see the Raw toggle on the screen.
      return view;
  }
}

/**
 * Record a decision on the turn holding `requestId`.
 *
 * Applied optimistically by the caller the moment the user clicks: the CLI
 * sends nothing back to acknowledge a `control_response`, so there is no event
 * that would clear the card later. Dropping `permission` is what makes the
 * decision final — a card still holding a request is a card still awaiting one.
 */
export function resolvePermission(view: AgentView, requestId: string, verdict: Verdict): AgentView {
  return {
    ...view,
    turns: view.turns.map((t) =>
      t.type === "tool" && t.permission?.requestId === requestId
        ? { ...t, permission: undefined, verdict }
        : t,
    ),
  };
}

/**
 * Cancel every prompt still open on this view, in one pass.
 *
 * The teardown counterpart to {@link resolvePermission}: closing or stopping a
 * pane cancels all of its prompts at once, and they all get the same verdict,
 * so resolving them one at a time would rebuild the turn list once per card.
 */
export const cancelPermissions = (view: AgentView): AgentView => ({
  ...view,
  turns: view.turns.map((t) =>
    t.type === "tool" && t.permission
      ? { ...t, permission: undefined, verdict: "cancelled" as Verdict }
      : t,
  ),
});

/** Every prompt still waiting on this view — for the teardown path, which has
 * to answer each one. Prefer {@link isAsking} to test *whether* any are
 * pending; this allocates. */
export const pendingPermissions = (view: AgentView): PermissionRequest[] =>
  view.turns.flatMap((t) => (t.type === "tool" && t.permission ? [t.permission] : []));

/**
 * Is this session blocked on a prompt?
 *
 * Separate from {@link pendingPermissions} because the answer is needed far
 * more often than the list, and `some` exits on the first hit and allocates
 * nothing where building the array walks every turn.
 *
 * Still O(turns), so callers must not put it on a render path: `agent-sessions`
 * calls it once per store write and caches the result on the record (see its
 * `chatSession`), because `chatStatus` runs per rail row and across every open
 * chat on every event.
 */
export const isAsking = (view: AgentView): boolean =>
  view.turns.some((t) => t.type === "tool" && t.permission !== undefined);

/**
 * Which card a blocked request should render as.
 *
 * Pure and here rather than in the component for the reason the `/` menu's
 * matching is: this is the branching worth testing, and a component is where
 * it would stop being tested.
 *
 * **Payload shape decides, not `requiresUserInteraction`.** The CLI's flag says
 * a request needs a human, which every card here already does — it does not say
 * *which* card, and a request flagged for a human whose questions we cannot
 * parse still has to render as something answerable. So a parseable question
 * list makes it a question, and the tool name is the last resort, for
 * `ExitPlanMode` alone, which announces itself no other way.
 */
export function promptKind(
  request: PermissionRequest,
  /** Pre-parsed by a caller that also needs the list, so the payload is walked
   * once per render rather than once per consumer. */
  questions: AskQuestion[] = askQuestions(request.input),
): "question" | "plan" | "gate" {
  if (questions.length > 0) return "question";
  if (request.toolName === "ExitPlanMode") return "plan";
  // A request the CLI flagged as needing a human, whose payload we can't
  // render as a question, still must not be answered by guessing — a gate at
  // least puts the decision in front of someone.
  return "gate";
}

/** Toggle one option, honoring the question's own single/multi-select rule. */
export function togglePick(
  picks: Map<string, QuestionPicks>,
  question: AskQuestion,
  label: string,
): Map<string, QuestionPicks> {
  const next = new Map(picks);
  const cur = picks.get(question.question) ?? { labels: new Set<string>(), other: "" };
  const labels = new Set(cur.labels);
  if (labels.has(label)) labels.delete(label);
  else if (question.multiSelect) labels.add(label);
  else {
    // Single-select replaces rather than accumulates — the radio semantics
    // `multiSelect: false` is asking for.
    labels.clear();
    labels.add(label);
  }
  next.set(question.question, { ...cur, labels });
  return next;
}

/** Record the free text behind "Other". Beside {@link togglePick} because the
 * two share one rule — an absent entry defaults to no labels and no text, and
 * both fields of an entry always travel together. */
export function setOther(
  picks: Map<string, QuestionPicks>,
  question: AskQuestion,
  text: string,
): Map<string, QuestionPicks> {
  const next = new Map(picks);
  const cur = picks.get(question.question) ?? { labels: new Set<string>(), other: "" };
  next.set(question.question, { ...cur, other: text });
  return next;
}

/** How many of `questions` have an answer that would actually be sent. Counts
 * the *resolved* picks, so an "Other" selected with nothing typed reads as
 * unanswered here exactly as {@link resolvePicks} drops it — a Send button that
 * enabled on it would quietly behave as Skip. */
export function answeredCount(questions: AskQuestion[], picks: Map<string, QuestionPicks>): number {
  const resolved = resolvePicks(picks);
  return questions.filter((q) => (resolved.get(q.question)?.size ?? 0) > 0).length;
}

/** Substitute the typed text for the "Other" placeholder at submit time — the
 * model wants the answer, not the word "Other". */
export function resolvePicks(picks: Map<string, QuestionPicks>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [question, { labels, other }] of picks) {
    const typed = other.trim();
    out.set(
      question,
      new Set([...labels].flatMap((l) => (l === OTHER_LABEL ? (typed ? [typed] : []) : [l]))),
    );
  }
  return out;
}

/** What one question's answer looks like mid-edit: the chosen labels plus the
 * free text behind "Other". One entry per question rather than parallel maps —
 * they are keyed identically and always change together. */
export type QuestionPicks = { labels: Set<string>; other: string };

/** The CLI's own label for the free-text choice, matched so a user who knows
 * Claude Code sees the same word. */
export const OTHER_LABEL = "Other";

/**
 * A button label for an "always allow" offer.
 *
 * The suggestions are the CLI's vocabulary and we echo them back untouched, so
 * this only has to recognize enough to write a label — an unrecognized kind
 * still renders, by its type, rather than disappearing.
 */
export function suggestionLabel(suggestion: unknown): string {
  if (typeof suggestion !== "object" || suggestion === null) return "Always allow";
  const { type, mode, destination } = suggestion as Record<string, unknown>;
  if (type === "setMode" && typeof mode === "string")
    return `Switch to ${mode}${destination === "session" ? " for this session" : ""}`;
  if (type === "addRules") return "Always allow this";
  return typeof type === "string" ? `Apply "${type}"` : "Always allow";
}

/**
 * The questions inside an `AskUserQuestion` call, or `[]` for anything else.
 *
 * Defensive about the shape because it comes off the wire as `unknown`: a
 * malformed question list must degrade to a plain allow/deny card rather than
 * throw inside the renderer and take the whole transcript with it.
 */
export function askQuestions(input: ToolInput): AskQuestion[] {
  const raw = input.questions;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((q) => {
    if (typeof q !== "object" || q === null) return [];
    const { question, header, multiSelect, options } = q as Record<string, unknown>;
    if (typeof question !== "string" || !Array.isArray(options)) return [];
    const parsed = options.flatMap((o) => {
      if (typeof o !== "object" || o === null) return [];
      const { label, description } = o as Record<string, unknown>;
      return typeof label === "string"
        ? [{ label, description: typeof description === "string" ? description : undefined }]
        : [];
    });
    return parsed.length === 0
      ? []
      : [
          {
            question,
            header: typeof header === "string" ? header : undefined,
            multiSelect: multiSelect === true,
            options: parsed,
          },
        ];
  });
}

/**
 * Write picks into an `AskUserQuestion` input: keyed by question text, `", "`-
 * joined for a multi-select, and an unanswered question omitted rather than
 * sent blank.
 *
 * This is the only home of that format. The decision is assembled here because
 * this is where the picks are, and Rust carries it through as an opaque
 * `updatedInput` — so the tests in `agent.test.ts` are what pin it.
 */
export function answerQuestions(input: ToolInput, picks: Map<string, Set<string>>): ToolInput {
  const answers: Record<string, string> = {};
  for (const [question, set] of picks) {
    if (set.size > 0) answers[question] = [...set].join(", ");
  }
  return { ...input, answers };
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
