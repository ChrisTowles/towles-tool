import { describe, expect, it } from "vitest";
import {
  appendUserTurn,
  applyCommand,
  emptyView,
  foldEvents,
  matchCommands,
  slashMenuKey,
  slashQuery,
  summarizeToolInput,
  type AgentEvent,
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
    const started = foldEvents([init]);
    expect(started).toMatchObject({ sessionId: "sess-1", model: "claude-opus-5", running: true });

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
