import { describe, expect, it } from "vitest";
import { IDENTITY_ACCENTS, identityColor } from "./identity-color";

describe("identityColor", () => {
  it("is stable: the same key always maps to the same accent", () => {
    expect(identityColor("towles-tool")).toBe(identityColor("towles-tool"));
    expect(identityColor("feat-topbar-worktree-indicator")).toBe(
      identityColor("feat-topbar-worktree-indicator"),
    );
  });

  it("always answers one of the literal accents", () => {
    for (const key of ["", "a", "towles-tool", "monorepo", "dawncaster-re"]) {
      expect(IDENTITY_ACCENTS).toContain(identityColor(key));
    }
  });
});
