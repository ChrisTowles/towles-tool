import { describe, expect, it } from "vitest";
import {
  answeredCount,
  answerQuestions,
  appendUserTurn,
  applyCommand,
  askQuestions,
  cancelPermissions,
  emptyView,
  foldEvents,
  matchCommands,
  isAsking,
  OTHER_LABEL,
  pendingPermissions,
  promptKind,
  resolvePermission,
  resolvePicks,
  setOther,
  suggestionLabel,
  togglePick,
  type QuestionPicks,
  slashMenuKey,
  slashQuery,
  summarizeToolInput,
  type AgentEvent,
  type AskQuestion,
  type PermissionRequest,
  type SlashCommand,
} from "@/lib/agent";

const init: AgentEvent = {
  kind: "init",
  sessionId: "sess-1",
  model: "claude-opus-5",
  cwd: "/repo",
  tools: ["Read"],
  permissionMode: "default",
  slashCommands: [],
};

describe("foldEvents", () => {
  it("pairs a tool result back onto its call", () => {
    const view = foldEvents([
      init,
      {
        kind: "toolUse",
        id: "toolu_1",
        name: "Read",
        input: { file_path: "a.ts" },
        parentToolUseId: null,
      },
      { kind: "toolResult", toolUseId: "toolu_1", content: "contents", isError: false },
    ]);

    expect(view.turns).toHaveLength(1);
    const tool = view.turns[0];
    expect(tool).toMatchObject({
      type: "tool",
      name: "Read",
      result: "contents",
      pending: false,
      isError: false,
    });
  });

  it("leaves a call pending until its result arrives", () => {
    const view = foldEvents([
      init,
      { kind: "toolUse", id: "toolu_1", name: "Bash", input: {}, parentToolUseId: null },
    ]);
    expect(view.turns[0]).toMatchObject({ type: "tool", pending: true });
  });

  it("pairs by id even when other turns interleave", () => {
    const view = foldEvents([
      init,
      { kind: "toolUse", id: "a", name: "Read", input: {}, parentToolUseId: null },
      { kind: "toolUse", id: "b", name: "Grep", input: {}, parentToolUseId: null },
      { kind: "text", text: "thinking out loud", parentToolUseId: null },
      { kind: "toolResult", toolUseId: "b", content: "match", isError: false },
    ]);

    expect(view.turns.find((t) => t.id === "a")).toMatchObject({ pending: true });
    expect(view.turns.find((t) => t.id === "b")).toMatchObject({ pending: false, result: "match" });
  });

  it("tracks session, model, running state and cost across a turn", () => {
    // `running` is owned by whoever sent something — `startChat`/`sendChat`
    // set it optimistically — so init records the session without claiming a
    // turn is in flight. A resumed session reattaches sending nothing, and
    // would otherwise spin forever on a turn nobody asked for.
    const started = foldEvents([init], { ...emptyView(), running: true });
    expect(started).toMatchObject({ sessionId: "sess-1", model: "claude-opus-5", running: true });
    expect(foldEvents([init]).running).toBe(false);

    const done = foldEvents(
      [
        {
          kind: "turn",
          subtype: "success",
          isError: false,
          durationMs: 900,
          numTurns: 2,
          totalCostUsd: 0.02,
        },
      ],
      started,
    );
    expect(done.running).toBe(false);
    expect(done.costUsd).toBeCloseTo(0.02);
  });

  it("stops running when the agent dies mid-turn", () => {
    // No `turn` event ever arrives in this case; a spinner that kept going
    // would read as a hang rather than a crash.
    const view = foldEvents([init, { kind: "exited", code: 1 }]);
    expect(view.running).toBe(false);
    expect(view.exitCode).toBe(1);
  });

  it("ignores protocol noise but surfaces malformed output", () => {
    const view = foldEvents([
      init,
      { kind: "other", discriminant: "system/status", raw: {} },
      { kind: "malformed", line: "<html>" },
    ]);
    expect(view.turns).toHaveLength(1);
    expect(view.turns[0]).toMatchObject({ type: "notice", isError: true });
  });

  it("starts empty", () => {
    expect(emptyView().turns).toEqual([]);
    expect(emptyView().exitCode).toBeUndefined();
  });
});

describe("summarizeToolInput", () => {
  it("prefers the field a human identifies the call by", () => {
    expect(summarizeToolInput({ file_path: "/a/b.ts", offset: 10 })).toBe("/a/b.ts");
    expect(summarizeToolInput({ command: "ls -la" })).toBe("ls -la");
  });

  it("falls back to JSON, and to empty for no arguments", () => {
    expect(summarizeToolInput({ weird: 1 })).toBe('{"weird":1}');
    expect(summarizeToolInput({})).toBe("");
  });
});

const cmd = (name: string, extra: Partial<SlashCommand> = {}): SlashCommand => ({
  name,
  description: null,
  argumentHint: null,
  aliases: [],
  ...extra,
});

describe("slashQuery", () => {
  it("opens only for a leading slash", () => {
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/cont")).toBe("cont");
    // A slash mid-prose is a path or a fraction, not a command.
    expect(slashQuery("look at src/lib/agent.ts")).toBeNull();
    expect(slashQuery("")).toBeNull();
  });

  it("closes once arguments start", () => {
    // From the first space on, the user is writing arguments — keeping the
    // menu open would hijack Enter for a selection they already made.
    expect(slashQuery("/tt:plan ")).toBeNull();
    expect(slashQuery("/tt:plan the thing")).toBeNull();
  });
});

describe("matchCommands", () => {
  const commands = [
    cmd("plugin-dev:command-development"),
    cmd("context"),
    cmd("compact"),
    cmd("usage", { aliases: ["cost", "stats"] }),
    cmd("tt:plan"),
  ];

  it("ranks prefix matches above buried substrings", () => {
    // The bug this guards: a plain filter puts the long plugin command first
    // for "co", burying /context and /compact. Note "co" legitimately reaches
    // four entries — the plugin command via its bare tail
    // ("command-development") and /usage via its "cost" alias — so this is
    // about order, not about filtering them out.
    expect(matchCommands(commands, "co").map((c) => c.name)).toEqual([
      "context",
      "compact",
      "plugin-dev:command-development",
      "usage",
    ]);
  });

  it("matches a namespaced command by its bare tail", () => {
    expect(matchCommands(commands, "plan").map((c) => c.name)).toEqual(["tt:plan"]);
  });

  it("matches aliases, ranked below real names", () => {
    expect(matchCommands(commands, "cost").map((c) => c.name)).toEqual(["usage"]);
  });

  it("is case-insensitive and returns everything for an empty query", () => {
    expect(matchCommands(commands, "CONT").map((c) => c.name)).toEqual(["context"]);
    expect(matchCommands(commands, "")).toHaveLength(commands.length);
  });

  it("returns nothing for a query that matches nothing", () => {
    expect(matchCommands(commands, "zzz")).toEqual([]);
  });
});

describe("command list from the wire", () => {
  it("takes init's name-only list, then upgrades on commandsChanged", () => {
    const started = foldEvents([{ ...init, slashCommands: [cmd("context"), cmd("usage")] }]);
    expect(started.commands.map((c) => c.name)).toEqual(["context", "usage"]);
    expect(started.commands[0].description).toBeNull();

    const upgraded = foldEvents(
      [
        {
          kind: "commandsChanged",
          commands: [cmd("context", { description: "Show context usage" })],
        },
      ],
      started,
    );
    // Wholesale replacement — /usage is genuinely gone, not merged away.
    expect(upgraded.commands.map((c) => c.name)).toEqual(["context"]);
    expect(upgraded.commands[0].description).toBe("Show context usage");
  });
});

describe("applyCommand", () => {
  it("completes to the command plus a space, ready for arguments", () => {
    expect(applyCommand(cmd("tt:plan"))).toBe("/tt:plan ");
  });
});

const at = (cursor: number, count = 3) => ({ count, cursor });

describe("slashMenuKey", () => {
  it("wraps in both directions", () => {
    // With ~90 commands, stopping at the end is worse than cycling.
    expect(slashMenuKey("ArrowDown", at(2))).toEqual({ type: "move", cursor: 0 });
    expect(slashMenuKey("ArrowUp", at(0))).toEqual({ type: "move", cursor: 2 });
    expect(slashMenuKey("ArrowDown", at(0))).toEqual({ type: "move", cursor: 1 });
  });

  it("picks on Tab and Enter", () => {
    // Enter must NOT send here: the draft is a half-typed command name.
    expect(slashMenuKey("Enter", at(0))).toEqual({ type: "pick" });
    expect(slashMenuKey("Tab", at(0))).toEqual({ type: "pick" });
  });

  it("dismisses on Escape", () => {
    expect(slashMenuKey("Escape", at(1))).toEqual({ type: "dismiss" });
  });

  it("lets every other key through to the composer", () => {
    for (const key of ["a", "Backspace", "ArrowLeft", "/", " "]) {
      expect(slashMenuKey(key, at(0))).toBeNull();
    }
  });

  it("handles a single-entry menu without dividing by zero", () => {
    expect(slashMenuKey("ArrowDown", at(0, 1))).toEqual({ type: "move", cursor: 0 });
    expect(slashMenuKey("ArrowUp", at(0, 1))).toEqual({ type: "move", cursor: 0 });
  });
});

describe("appendUserTurn", () => {
  it("echoes what was sent, since the CLI never replays it", () => {
    // Without --replay-user-messages the wire's only `user` messages are tool
    // results, so the prompt would otherwise vanish when the composer clears.
    const view = appendUserTurn(emptyView(), "do the thing");
    expect(view.turns).toEqual([{ id: "user-0", type: "user", text: "do the thing" }]);
  });

  it("interleaves with agent turns in send order", () => {
    let view = appendUserTurn(emptyView(), "first");
    view = foldEvents([{ kind: "text", text: "reply", parentToolUseId: null }], view);
    view = appendUserTurn(view, "second");
    expect(view.turns.map((t) => [t.type, "text" in t ? t.text : ""])).toEqual([
      ["user", "first"],
      ["text", "reply"],
      ["user", "second"],
    ]);
  });

  it("gives every echo a distinct id", () => {
    let view = appendUserTurn(emptyView(), "a");
    view = appendUserTurn(view, "b");
    expect(new Set(view.turns.map((t) => t.id)).size).toBe(2);
  });
});

/** The shape the CLI actually sends, trimmed — see the Rust `control` module's
 * fixture, which was captured from a live session rather than written. */
const permission = (over: Partial<PermissionRequest> = {}): AgentEvent => ({
  kind: "permissionRequest",
  requestId: "r1",
  toolName: "Write",
  displayName: "Write",
  description: "probe.txt",
  toolUseId: "toolu_1",
  input: { file_path: "/tmp/probe.txt" },
  suggestions: [],
  requiresUserInteraction: false,
  ...over,
});

const write: AgentEvent = {
  kind: "toolUse",
  id: "toolu_1",
  name: "Write",
  input: { file_path: "/tmp/probe.txt" },
  parentToolUseId: null,
};

describe("permission prompts", () => {
  it("attaches to the call it is about instead of adding a row", () => {
    const view = foldEvents([init, write, permission()]);
    expect(view.turns).toHaveLength(1);
    const tool = view.turns[0];
    expect(tool.type === "tool" && tool.permission?.requestId).toBe("r1");
  });

  it("still lands somewhere answerable when no call matches", () => {
    // The CLI is blocked either way, so a prompt with no `toolUse` on screen
    // must not be silently dropped.
    const view = foldEvents([init, permission({ toolUseId: "toolu_missing" })]);
    expect(view.turns).toHaveLength(1);
    const tool = view.turns[0];
    expect(tool.type === "tool" && tool.permission?.requestId).toBe("r1");
    expect(pendingPermissions(view)).toHaveLength(1);
  });

  it("records the verdict and stops being pending once answered", () => {
    const answered = resolvePermission(foldEvents([init, write, permission()]), "r1", "deny");
    expect(pendingPermissions(answered)).toHaveLength(0);
    const tool = answered.turns[0];
    expect(tool.type === "tool" && tool.verdict).toBe("deny");
  });

  it("clears a stale prompt when the tool result arrives", () => {
    // The gate settled without us — answering into it would go nowhere.
    const view = foldEvents([
      init,
      write,
      permission(),
      { kind: "toolResult", toolUseId: "toolu_1", content: "ok", isError: false },
    ]);
    expect(pendingPermissions(view)).toHaveLength(0);
  });

  it("records an unservable control request rather than hiding it", () => {
    const view = foldEvents([
      init,
      { kind: "unsupportedControlRequest", requestId: "r9", subtype: "hook_callback" },
    ]);
    const notice = view.turns[0];
    expect(notice.type === "notice" && notice.text).toContain("hook_callback");
    expect(notice.type === "notice" && notice.isError).toBe(false);
  });
});

const questions = [
  {
    question: "Which colour?",
    header: "Colour",
    multiSelect: false,
    options: [{ label: "Red", description: "warm" }, { label: "Blue" }],
  },
];

describe("askQuestions", () => {
  it("reads a real AskUserQuestion input", () => {
    const [q] = askQuestions({ questions });
    expect(q.question).toBe("Which colour?");
    expect(q.header).toBe("Colour");
    expect(q.multiSelect).toBe(false);
    expect(q.options).toEqual([{ label: "Red", description: "warm" }, { label: "Blue" }]);
  });

  it("degrades to no questions rather than throwing on junk", () => {
    // It comes off the wire as unknown, and a throw inside the renderer would
    // take the whole transcript down with it — a plain allow/deny card is the
    // correct fallback.
    expect(askQuestions({})).toEqual([]);
    expect(askQuestions({ questions: "nope" })).toEqual([]);
    expect(askQuestions({ questions: [null, 42, { question: "no options" }] })).toEqual([]);
    expect(askQuestions({ questions: [{ question: "q", options: [{ nolabel: 1 }] }] })).toEqual([]);
  });

  it("is not fooled by a tool that merely has other input", () => {
    expect(askQuestions({ file_path: "a.ts" })).toEqual([]);
  });
});

describe("answerQuestions", () => {
  it("keys by question text and joins a multi-select, matching the CLI", () => {
    const answered = answerQuestions(
      { questions },
      new Map([
        ["Colour?", new Set(["Blue"])],
        ["Size?", new Set(["Small", "Large"])],
      ]),
    );
    expect(answered.answers).toEqual({ "Colour?": "Blue", "Size?": "Small, Large" });
    // The original input survives — the CLI matches the answers against it.
    expect(answered.questions).toBe(questions);
  });

  it("omits an unanswered question rather than sending it blank", () => {
    const answered = answerQuestions({}, new Map([["Skipped?", new Set<string>()]]));
    expect(answered.answers).toEqual({});
  });
});

const req = (over: Partial<PermissionRequest> = {}): PermissionRequest => ({
  requestId: "r1",
  toolName: "Write",
  displayName: null,
  description: null,
  toolUseId: null,
  input: {},
  suggestions: [],
  requiresUserInteraction: false,
  ...over,
});

describe("promptKind", () => {
  it("reads a question by its payload, not its tool name", () => {
    // A future question tool renders correctly without being named here.
    expect(promptKind(req({ toolName: "SomeFutureAsk", input: { questions } }))).toBe("question");
  });

  it("recognises the plan tool", () => {
    expect(promptKind(req({ toolName: "ExitPlanMode", input: { plan: "do it" } }))).toBe("plan");
  });

  it("falls back to a gate, including for an unparseable question payload", () => {
    expect(promptKind(req({ toolName: "Write" }))).toBe("gate");
    // Flagged as needing a human but with nothing renderable: a gate still
    // puts the decision in front of someone rather than guessing.
    expect(
      promptKind(req({ toolName: "AskUserQuestion", input: {}, requiresUserInteraction: true })),
    ).toBe("gate");
  });
});

const single: AskQuestion = { question: "Colour?", multiSelect: false, options: [] };
const multi: AskQuestion = { question: "Sizes?", multiSelect: true, options: [] };

describe("togglePick", () => {
  it("replaces for single-select and accumulates for multi", () => {
    let picks = togglePick(new Map(), single, "Red");
    picks = togglePick(picks, single, "Blue");
    expect([...(picks.get("Colour?")?.labels ?? [])]).toEqual(["Blue"]);

    let many = togglePick(new Map(), multi, "S");
    many = togglePick(many, multi, "L");
    expect([...(many.get("Sizes?")?.labels ?? [])]).toEqual(["S", "L"]);
  });

  it("toggles a selected option back off", () => {
    let picks = togglePick(new Map(), multi, "S");
    picks = togglePick(picks, multi, "S");
    expect(picks.get("Sizes?")?.labels.size).toBe(0);
  });

  it("keeps the free text while the selection changes", () => {
    let picks = togglePick(new Map(), single, OTHER_LABEL);
    picks = setOther(picks, single, "puce");
    picks = togglePick(picks, single, "Red");
    expect(picks.get("Colour?")?.other).toBe("puce");
  });
});

describe("setOther", () => {
  it("records text for a question with nothing selected yet", () => {
    const picks = setOther(new Map(), single, "puce");
    expect(picks.get("Colour?")).toEqual({ labels: new Set(), other: "puce" });
  });

  it("leaves the original map untouched", () => {
    const before = togglePick(new Map(), single, "Red");
    setOther(before, single, "puce");
    expect(before.get("Colour?")?.other).toBe("");
  });
});

describe("answeredCount", () => {
  it("counts only questions whose answer would actually be sent", () => {
    // `Other` with nothing typed resolves to no answer, so it must not read as
    // answered — a Send enabled on it would silently behave as Skip.
    let picks = togglePick(new Map(), single, OTHER_LABEL);
    expect(answeredCount([single, multi], picks)).toBe(0);
    picks = setOther(picks, single, "puce");
    expect(answeredCount([single, multi], picks)).toBe(1);
    picks = togglePick(picks, multi, "S");
    expect(answeredCount([single, multi], picks)).toBe(2);
  });
});

describe("resolvePicks", () => {
  it("substitutes the typed text for the Other placeholder", () => {
    const picks: Map<string, QuestionPicks> = new Map([
      ["Colour?", { labels: new Set([OTHER_LABEL]), other: "  puce  " }],
    ]);
    expect([...(resolvePicks(picks).get("Colour?") ?? [])]).toEqual(["puce"]);
  });

  it("drops Other entirely when nothing was typed", () => {
    // Sending the literal word "Other" would be an answer the user never gave.
    const picks: Map<string, QuestionPicks> = new Map([
      ["Colour?", { labels: new Set([OTHER_LABEL]), other: "   " }],
    ]);
    expect(resolvePicks(picks).get("Colour?")?.size).toBe(0);
  });
});

describe("suggestionLabel", () => {
  it("names the offers the CLI actually sends", () => {
    expect(suggestionLabel({ type: "setMode", mode: "acceptEdits", destination: "session" })).toBe(
      "Switch to acceptEdits for this session",
    );
    expect(suggestionLabel({ type: "addRules" })).toBe("Always allow this");
  });

  it("still renders a suggestion kind it has never seen", () => {
    // The vocabulary is the CLI's and grows; an unknown kind must stay
    // clickable rather than vanish.
    expect(suggestionLabel({ type: "somethingNew" })).toBe('Apply "somethingNew"');
    expect(suggestionLabel(null)).toBe("Always allow");
  });
});

describe("isAsking", () => {
  it("agrees with pendingPermissions without allocating", () => {
    const blocked = foldEvents([init, write, permission()]);
    expect(isAsking(blocked)).toBe(true);
    expect(isAsking(resolvePermission(blocked, "r1", "allow"))).toBe(false);
    expect(isAsking(foldEvents([init]))).toBe(false);
  });
});

describe("cancelPermissions", () => {
  it("cancels every open prompt in one pass and records the verdict", () => {
    const blocked = foldEvents([init, write, permission()]);
    const cancelled = cancelPermissions(blocked);
    expect(isAsking(cancelled)).toBe(false);
    expect(pendingPermissions(cancelled)).toEqual([]);
    const tool = cancelled.turns.find((t) => t.type === "tool");
    expect(tool?.type === "tool" && tool.verdict).toBe("cancelled");
  });

  it("leaves an already-decided turn's verdict alone", () => {
    // Teardown must not relabel a decision the user actually made.
    const decided = resolvePermission(foldEvents([init, write, permission()]), "r1", "allow");
    const tool = cancelPermissions(decided).turns.find((t) => t.type === "tool");
    expect(tool?.type === "tool" && tool.verdict).toBe("allow");
  });
});
