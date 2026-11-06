import { describe, expect, it } from "vitest";
import { takeTarget, type FocusTarget } from "./focus-target";

const prTarget: FocusTarget = { screen: "agentboard", kind: "pr", id: "octo/widgets#43" };
const todoTarget: FocusTarget = { screen: "board", kind: "todo", id: "7" };

describe("takeTarget", () => {
  it("takes and clears the target when the screen matches", () => {
    expect(takeTarget(prTarget, "agentboard")).toEqual([prTarget, null]);
  });

  it("leaves a target for another screen untouched", () => {
    expect(takeTarget(todoTarget, "agentboard")).toEqual([null, todoTarget]);
    expect(takeTarget(todoTarget, "board")).toEqual([todoTarget, null]);
  });

  it("finds nothing when nothing is pending", () => {
    expect(takeTarget(null, "board")).toEqual([null, null]);
  });
});
