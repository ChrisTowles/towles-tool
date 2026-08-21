import { afterEach, describe, expect, it, vi } from "vitest";
import {
  matchesEditableOverride,
  matchesShortcut,
  SHORTCUTS,
  shortcutHint,
  tabShortcutId,
  withHint,
} from "./shortcuts";

// `matches` only reads these fields, so a plain object stands in for a real
// KeyboardEvent (the test environment is node, without the DOM).
function key(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    key: "",
    code: "",
    ...overrides,
  } as KeyboardEvent;
}

describe("tab shortcuts", () => {
  it("registers a jump binding for each digit 1–9", () => {
    for (let n = 1; n <= 9; n++) {
      expect(SHORTCUTS[`tab-${n}`]).toBeDefined();
    }
  });

  it("collapses the nine tab jumps to a single help-overlay entry", () => {
    expect(SHORTCUTS["tab-1"].hideInHelp).toBeFalsy();
    for (let n = 2; n <= 9; n++) {
      expect(SHORTCUTS[`tab-${n}`].hideInHelp).toBe(true);
    }
  });

  it("matches mod+digit (Ctrl on non-mac)", () => {
    expect(matchesShortcut("tab-3", key({ ctrlKey: true, key: "3" }))).toBe(true);
    expect(matchesShortcut("tab-3", key({ ctrlKey: true, key: "4" }))).toBe(false);
    expect(matchesShortcut("tab-3", key({ key: "3" }))).toBe(false);
  });

  it("zen is a global mod+shift+f binding shown in the help overlay", () => {
    const zen = SHORTCUTS["zen"];
    expect(zen).toBeDefined();
    expect(zen.scope).toBe("global");
    expect(zen.hideInHelp).toBeFalsy();
    expect(matchesShortcut("zen", key({ ctrlKey: true, shiftKey: true, key: "f" }))).toBe(true);
    // Plain mod+f (no shift) must not toggle zen.
    expect(matchesShortcut("zen", key({ ctrlKey: true, key: "f" }))).toBe(false);
  });

  it("close-tab is plain mod+w — distinct from the shift+w pane-close chord", () => {
    expect(matchesShortcut("close-tab", key({ ctrlKey: true, key: "w" }))).toBe(true);
    // mod+shift+w belongs to ab-close-pane, so it must NOT close the tab.
    expect(matchesShortcut("close-tab", key({ ctrlKey: true, shiftKey: true, key: "w" }))).toBe(
      false,
    );
  });

  it("ab-close-pane is the one close chord — no session-only binding beside it", () => {
    expect(matchesShortcut("ab-close-pane", key({ ctrlKey: true, shiftKey: true, key: "w" }))).toBe(
      true,
    );
    expect("ab-close-session" in SHORTCUTS).toBe(false);
    // Closing whatever holds the ring has to reach a pane you are typing in.
    expect(SHORTCUTS["ab-close-pane"].allowInEditable).toBe(true);
    expect(matchesEditableOverride(key({ ctrlKey: true, shiftKey: true, key: "w" }))).toBe(true);
  });

  it("next-tab/prev-tab are mod+] and mod+[", () => {
    expect(matchesShortcut("next-tab", key({ ctrlKey: true, key: "]" }))).toBe(true);
    expect(matchesShortcut("prev-tab", key({ ctrlKey: true, key: "[" }))).toBe(true);
    expect(matchesShortcut("next-tab", key({ ctrlKey: true, key: "[" }))).toBe(false);
  });
});

describe("board shortcuts", () => {
  it("registers the board-scoped filter binding", () => {
    expect(SHORTCUTS["board-filter"].scope).toBe("board");
    expect(matchesShortcut("board-filter", key({ key: "/" }))).toBe(true);
  });

  it("has no new-task binding — tasks are created on the Agentboard", () => {
    expect("board-new-todo" in SHORTCUTS).toBe(false);
  });
});

describe("rail session jumps", () => {
  it("registers a jump binding for each digit 1–9, collapsed to one help entry", () => {
    for (let n = 1; n <= 9; n++) {
      expect(SHORTCUTS[`ab-jump-session-${n}`].scope).toBe("agentboard");
      expect(SHORTCUTS[`ab-jump-session-${n}`].hideInHelp).toBe(n > 1);
    }
  });

  it("takes shift, because plain mod+digit is already the tab jump", () => {
    const shifted = key({ ctrlKey: true, shiftKey: true, key: "!", code: "Digit1" });
    expect(matchesShortcut("ab-jump-session-1", shifted)).toBe(true);
    expect(matchesShortcut("tab-1", shifted)).toBe(false);
    expect(matchesShortcut("ab-jump-session-1", key({ ctrlKey: true, key: "1" }))).toBe(false);
  });

  it('matches the shifted digit by physical key — Shift+1 arrives as "!"', () => {
    expect(
      matchesShortcut("ab-jump-session-3", key({ ctrlKey: true, shiftKey: true, key: "#" })),
    ).toBe(false);
    expect(
      matchesShortcut(
        "ab-jump-session-3",
        key({ ctrlKey: true, shiftKey: true, key: "#", code: "Digit3" }),
      ),
    ).toBe(true);
  });

  it("works with a terminal focused, like the other board-wide jumps", () => {
    expect(SHORTCUTS["ab-jump-session-1"].allowInEditable).toBe(true);
    expect(
      matchesEditableOverride(key({ ctrlKey: true, shiftKey: true, key: "!", code: "Digit1" })),
    ).toBe(true);
  });
});

describe("editable-target override", () => {
  it("jump-next/prev opt out of the editable guard so they work with a terminal focused", () => {
    expect(SHORTCUTS["ab-jump-next"].allowInEditable).toBe(true);
    expect(SHORTCUTS["ab-jump-prev"].allowInEditable).toBe(true);
    expect(matchesEditableOverride(key({ ctrlKey: true, shiftKey: true, key: "n" }))).toBe(true);
    expect(matchesEditableOverride(key({ ctrlKey: true, shiftKey: true, key: "p" }))).toBe(true);
  });

  it("jump-idle is its own chord beside them, and just as terminal-proof", () => {
    expect(matchesShortcut("ab-jump-idle", key({ ctrlKey: true, shiftKey: true, key: "a" }))).toBe(
      true,
    );
    expect(matchesShortcut("ab-jump-idle", key({ ctrlKey: true, key: "a" }))).toBe(false);
    expect(SHORTCUTS["ab-jump-idle"].allowInEditable).toBe(true);
    expect(matchesEditableOverride(key({ ctrlKey: true, shiftKey: true, key: "a" }))).toBe(true);
  });

  it("task lifecycle chords work with a terminal focused — they act on board state", () => {
    expect(SHORTCUTS["ab-new-task"].allowInEditable).toBe(true);
    expect(SHORTCUTS["ab-remove-task"].allowInEditable).toBe(true);
    expect(matchesEditableOverride(key({ ctrlKey: true, shiftKey: true, key: "d" }))).toBe(true);
    expect(matchesEditableOverride(key({ ctrlKey: true, shiftKey: true, key: "Delete" }))).toBe(
      true,
    );
  });

  it("remove-task is mod+shift+delete — plain Delete stays with the shell", () => {
    expect(
      matchesShortcut("ab-remove-task", key({ ctrlKey: true, shiftKey: true, key: "Delete" })),
    ).toBe(true);
    expect(matchesShortcut("ab-remove-task", key({ key: "Delete" }))).toBe(false);
    expect(matchesShortcut("ab-remove-task", key({ ctrlKey: true, key: "Delete" }))).toBe(false);
  });

  it("the delete flow confirms on mod+shift+enter — same chord as the delete, twice", () => {
    expect(
      matchesShortcut(
        "ab-confirm-close-worktree",
        key({ ctrlKey: true, shiftKey: true, key: "Enter" }),
      ),
    ).toBe(true);
    // Plain and unshifted Enter stay with the focused dialog button / the
    // bare-Enter "jump into the terminal" binding.
    expect(matchesShortcut("ab-confirm-close-worktree", key({ key: "Enter" }))).toBe(false);
    expect(matchesShortcut("ab-confirm-close-worktree", key({ ctrlKey: true, key: "Enter" }))).toBe(
      false,
    );
  });

  it("new-session (mod+d) stays gated — Ctrl+D is EOF at a shell prompt", () => {
    expect(SHORTCUTS["ab-new-session"].allowInEditable).toBeFalsy();
    expect(matchesEditableOverride(key({ ctrlKey: true, key: "d" }))).toBe(false);
  });

  it("a plain, unmatched key never triggers the override", () => {
    expect(matchesEditableOverride(key({ key: "n" }))).toBe(false);
  });
});

describe("tabShortcutId", () => {
  it("maps an open tab to its digit, in tab order", () => {
    expect(tabShortcutId(["agentboard", "cockpit", "board"], "agentboard")).toBe("tab-1");
    expect(tabShortcutId(["agentboard", "cockpit", "board"], "board")).toBe("tab-3");
  });

  it("has no key for a screen that is not open — the digits address tabs", () => {
    expect(tabShortcutId(["agentboard"], "telemetry")).toBeNull();
  });

  it("stops at nine, because the bindings do", () => {
    const nine = [
      "agentboard",
      "cockpit",
      "board",
      "slack",
      "doctor",
      "claude-sessions",
      "mcp",
      "telemetry",
      "task-explorer",
    ] as const;
    expect(tabShortcutId([...nine], "task-explorer")).toBe("tab-9");
    expect(tabShortcutId([...nine, "settings"], "settings")).toBeNull();
  });

  it("every id it returns is a real binding", () => {
    const tabs = ["agentboard", "cockpit", "board"] as const;
    for (const id of tabs) {
      const shortcut = tabShortcutId([...tabs], id);
      expect(shortcut && SHORTCUTS[shortcut]).toBeDefined();
    }
  });
});

describe("withHint", () => {
  it("appends the binding a control duplicates", () => {
    expect(withHint("Collapse the rail", "ab-toggle-rail")).toBe(
      `Collapse the rail (${shortcutHint("ab-toggle-rail")})`,
    );
  });

  it("throws on an unknown id rather than labelling a control with nothing", () => {
    expect(() => withHint("Do a thing", "no-such-binding")).toThrow(
      'Unknown shortcut id "no-such-binding"',
    );
  });
});

// `IS_MAC` is read once at module eval, so the mac half of every binding is only
// reachable through a fresh import under a stubbed `navigator`.
async function macModule() {
  vi.stubGlobal("navigator", { platform: "MacIntel" });
  vi.resetModules();
  return import("./shortcuts");
}

describe("on macOS", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("takes ⌘ for the jump chords", async () => {
    const mac = await macModule();
    const cmd = key({ metaKey: true, shiftKey: true, key: "a" });
    expect(mac.matchesShortcut("ab-jump-idle", cmd)).toBe(true);
    expect(mac.matchesEditableOverride(cmd)).toBe(true);
    expect(
      mac.matchesShortcut("ab-jump-next", key({ metaKey: true, shiftKey: true, key: "n" })),
    ).toBe(true);
  });

  it("takes the Linux Ctrl+Shift spelling too, terminal override and all", async () => {
    const mac = await macModule();
    const ctrl = key({ ctrlKey: true, shiftKey: true, key: "a" });
    expect(mac.matchesShortcut("ab-jump-idle", ctrl)).toBe(true);
    expect(mac.matchesEditableOverride(ctrl)).toBe(true);
    expect(
      mac.matchesShortcut("ab-toggle-files", key({ ctrlKey: true, shiftKey: true, key: "e" })),
    ).toBe(true);
  });

  // The whole reason the alias is shift-only: ⌃C/⌃D are the shell's, and a
  // stray Ctrl must not fall through to a binding on its main key alone.
  it("never aliases a bare Ctrl chord away from the shell", async () => {
    const mac = await macModule();
    expect(mac.matchesShortcut("ab-new-session", key({ ctrlKey: true, key: "d" }))).toBe(false);
    expect(mac.matchesShortcut("palette", key({ ctrlKey: true, key: "k" }))).toBe(false);
    expect(mac.matchesShortcut("close-tab", key({ ctrlKey: true, key: "w" }))).toBe(false);
    expect(mac.matchesShortcut("ab-focus-terminal", key({ ctrlKey: true, key: "enter" }))).toBe(
      false,
    );
    expect(mac.matchesEditableOverride(key({ ctrlKey: true, key: "d" }))).toBe(false);
  });

  it("labels it ⌘⇧A wherever the keycaps show", async () => {
    const mac = await macModule();
    expect(mac.shortcutKeys("ab-jump-idle")).toEqual(["⌘", "⇧", "A"]);
    expect(mac.shortcutHint("ab-jump-idle")).toBe("⌘⇧A");
    expect(mac.shortcutAria("ab-jump-idle")).toBe("Meta+Shift+A");
  });
});
