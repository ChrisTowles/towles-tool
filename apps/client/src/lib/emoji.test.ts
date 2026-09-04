import { describe, expect, it } from "vitest";
import { EMOJI_GROUPS, QUICK_REACTIONS, emojiChar, searchEmoji } from "./emoji";

describe("emojiChar", () => {
  it("resolves a shortcode with or without colons", () => {
    expect(emojiChar("tada")).toBe("🎉");
    expect(emojiChar(":tada:")).toBe("🎉");
  });

  it("resolves Slack's aliases to the canonical character", () => {
    expect(emojiChar("thumbsup")).toBe(emojiChar("+1"));
    expect(emojiChar("shrug")).toBe(emojiChar("person_shrugging"));
  });

  it("is null for a custom or unknown shortcode", () => {
    expect(emojiChar("shipit")).toBeNull();
    expect(emojiChar("")).toBeNull();
  });

  it("drops a skin-tone modifier and refuses a bare one", () => {
    expect(emojiChar("wave::skin-tone-5")).toBe("👋");
    expect(emojiChar("skin-tone-5")).toBeNull();
  });
});

describe("the picker's set", () => {
  it("resolves every quick reaction", () => {
    for (const name of QUICK_REACTIONS) expect(emojiChar(name)).not.toBeNull();
  });

  it("has no duplicate shortcode across groups", () => {
    const names = EMOJI_GROUPS.flatMap((g) => g.entries.map(([name]) => name));
    expect(names.length).toBe(new Set(names).size);
  });

  it("searches by shortcode substring and is empty for a blank query", () => {
    expect(searchEmoji("party")).toContainEqual(["partying_face", "🥳"]);
    expect(searchEmoji("  ")).toEqual([]);
  });
});
