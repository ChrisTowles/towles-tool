import { describe, expect, it } from "vitest";
import type { Issue } from "@towles/shared";
import { buildIssueChoices, computeColumnLayout } from "./branch";

const issues: Issue[] = [
  {
    number: 4,
    title: "Short bug",
    state: "open",
    labels: [{ name: "bug", color: "d73a4a" }],
  },
  {
    number: 123,
    title: "Add authentication flow with OAuth",
    state: "open",
    labels: [
      { name: "enhancement", color: "a2eeef" },
      { name: "priority", color: "ff0000" },
    ],
  },
  {
    number: 7,
    title: "Docs update",
    state: "open",
    labels: [],
  },
];

describe("computeColumnLayout", () => {
  it("computes longestNumber from widest issue number", () => {
    const layout = computeColumnLayout(issues, 100);
    // "123" is 3 chars
    expect(layout.longestNumber).toBe(3);
  });

  it("computes longestLabels from widest joined label string", () => {
    const layout = computeColumnLayout(issues, 100);
    // "enhancement, priority" is 21 chars
    expect(layout.longestLabels).toBe("enhancement, priority".length);
  });

  it("caps line width at 130", () => {
    const narrow = computeColumnLayout(issues, 80);
    const wide = computeColumnLayout(issues, 200);
    // descriptionLength = min(cols, 130) - longestNumber - longestLabels - 15
    expect(narrow.descriptionLength).toBe(80 - 3 - 21 - 15);
    expect(wide.descriptionLength).toBe(130 - 3 - 21 - 15);
  });

  it("handles single issue", () => {
    const single: Issue[] = [{ number: 1, title: "t", state: "open", labels: [] }];
    const layout = computeColumnLayout(single, 80);
    expect(layout.longestNumber).toBe(1);
    expect(layout.longestLabels).toBe(0);
    expect(layout.descriptionLength).toBe(80 - 1 - 0 - 15);
  });

  it("handles issues with no labels", () => {
    const noLabels: Issue[] = [
      { number: 42, title: "No labels here", state: "open", labels: [] },
      { number: 100, title: "Also no labels", state: "open", labels: [] },
    ];
    const layout = computeColumnLayout(noLabels, 100);
    expect(layout.longestLabels).toBe(0);
    expect(layout.longestNumber).toBe(3);
  });
});

describe("buildIssueChoices", () => {
  const layout = computeColumnLayout(issues, 100);

  it("returns one choice per issue plus a Cancel option", () => {
    const choices = buildIssueChoices(issues, layout);
    expect(choices).toHaveLength(issues.length + 1);
  });

  it("last choice is Cancel", () => {
    const choices = buildIssueChoices(issues, layout);
    const last = choices[choices.length - 1];
    expect(last.title).toBe("Cancel");
    expect(last.value).toBe("cancel");
  });

  it("uses issue number as title and value", () => {
    const choices = buildIssueChoices(issues, layout);
    expect(choices[0].title).toBe("4");
    expect(choices[0].value).toBe(4);
    expect(choices[1].title).toBe("123");
    expect(choices[1].value).toBe(123);
  });

  it("includes issue title text in description", () => {
    const choices = buildIssueChoices(issues, layout);
    const desc = Bun.stripANSI(choices[0].description!);
    expect(desc).toContain("Short bug");
  });

  it("includes label names in description", () => {
    const choices = buildIssueChoices(issues, layout);
    const desc = Bun.stripANSI(choices[1].description!);
    expect(desc).toContain("enhancement");
    expect(desc).toContain("priority");
  });

  it("handles issues with no labels", () => {
    const choices = buildIssueChoices(issues, layout);
    // Issue #7 has no labels — description should still contain the title
    const desc = Bun.stripANSI(choices[2].description!);
    expect(desc).toContain("Docs update");
  });

  it("works with empty issue list", () => {
    const emptyLayout = computeColumnLayout(
      [{ number: 0, title: "", state: "open", labels: [] }],
      80,
    );
    const choices = buildIssueChoices([], emptyLayout);
    // Only the Cancel choice
    expect(choices).toHaveLength(1);
    expect(choices[0].value).toBe("cancel");
  });
});
