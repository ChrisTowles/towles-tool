import { describe, expect, it } from "vitest";
import type { PromptImprover, TaskTemplate } from "./settings";
import { composeGoal, nextTaskTemplateId, withTemplateImprover } from "./task-templates";

const tpl = (over: Partial<TaskTemplate> = {}): TaskTemplate => ({
  id: "bug",
  label: "Bug",
  repo: "",
  goal: "",
  improver: "",
  setup: "",
  ...over,
});

const imp = (id: string, preferred = false): PromptImprover => ({
  id,
  label: id,
  enabled: true,
  preferred,
  prompt: "",
});

describe("composeGoal", () => {
  it("puts the template's goal first, then what was typed", () => {
    expect(composeGoal(tpl({ goal: "Reproduce first." }), " login 500s ")).toBe(
      "Reproduce first.\n\nlogin 500s",
    );
  });

  it("drops an empty half", () => {
    expect(composeGoal(tpl({ goal: "Reproduce first." }), "")).toBe("Reproduce first.");
    expect(composeGoal(tpl(), "typed")).toBe("typed");
  });
});

describe("nextTaskTemplateId", () => {
  it("slugs the label and avoids taken ids", () => {
    expect(nextTaskTemplateId([], "Bug fix")).toBe("bug-fix");
    expect(nextTaskTemplateId([tpl({ id: "bug-fix" })], "Bug fix")).toBe("bug-fix-2");
    expect(nextTaskTemplateId([], "!!")).toBe("template");
  });
});

describe("withTemplateImprover", () => {
  const improvers = [imp("direct", true), imp("clarify"), imp("interview")];

  it("leads with the template's improver, preferred", () => {
    const out = withTemplateImprover(improvers, "interview");
    expect(out.map((i) => i.id)).toEqual(["interview", "direct", "clarify"]);
    expect(out[0].preferred).toBe(true);
  });

  it("leaves the list alone for no or an unknown improver", () => {
    expect(withTemplateImprover(improvers, undefined)).toBe(improvers);
    expect(withTemplateImprover(improvers, "gone")).toBe(improvers);
  });
});
