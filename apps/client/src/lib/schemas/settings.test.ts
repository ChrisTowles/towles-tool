import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { UserSettingsSchema } from "./settings";

const valid = {
  preferredEditor: "code",
  journalSettings: {
    baseFolder: "~/journal",
    dailyPathTemplate: "{{date}}.md",
    meetingPathTemplate: "{{date}}-meeting.md",
    notePathTemplate: "{{date}}-note.md",
    templateDir: "~/journal/templates",
  },
  promptImprovers: [
    { id: "direct", label: "Direct", enabled: true, preferred: true, prompt: "Restate it." },
  ],
  taskTemplates: [
    { id: "bug", label: "Bug", repo: "", goal: "Reproduce first.", improver: "", setup: "" },
  ],
  savedViews: [
    {
      id: "gh-failures",
      label: "gh failures",
      filters: [{ field: "outcome", op: "neq", value: "ok" }],
      days: 1,
      query: "",
    },
  ],
  savedQueries: [{ id: "slow-spawns", label: "slow spawns", sql: "select 1" }],
  telemetryRules: [
    {
      id: "zero-error",
      label: "Zero ERROR",
      enabled: true,
      kind: "count",
      select: [{ field: "level", op: "eq", value: "ERROR" }],
      pass: [],
      threshold: 0,
      days: 1,
    },
  ],
  collectors: {
    calendar: {
      enabled: false,
      refreshMinutes: 15,
      quietHours: { enabled: false, startHour: 9, endHour: 17, weekdays: [0, 1, 2, 3, 4] },
      sources: [{ id: "google", label: "Google (personal)", enabled: true, prompt: "list today" }],
    },
    prs: { enabled: true, refreshSeconds: 60, mergedRefreshMinutes: 15 },
    issues: { enabled: true, refreshMinutes: 5, watchedLabels: ["agent-ready"] },
    slack: {
      enabled: false,
      token: "",
      appToken: "",
      watchUserId: "",
      watchName: "",
      refreshSeconds: 60,
    },
  },
};

const parse = Schema.decodeUnknownSync(UserSettingsSchema);

describe("UserSettingsSchema", () => {
  it("parses a well-formed settings object", () => {
    expect(parse(valid)).toEqual(valid);
  });

  it("keeps unknown top-level fields (TS-CLI compat)", () => {
    const withExtra = { ...valid, someFutureField: "kept" };
    expect(parse(withExtra)).toMatchObject({ someFutureField: "kept" });
  });

  it("keeps unknown agentboard keys", () => {
    const withAgentboard = { ...valid, agentboard: { compactRecommendPercent: 40, futureKey: 1 } };
    const parsed = parse(withAgentboard);
    expect(parsed.agentboard).toEqual({ compactRecommendPercent: 40, futureKey: 1 });
  });

  it("reads an unrecognized agentboard level or rail mode as unset, not a parse failure", () => {
    const odd = {
      ...valid,
      agentboard: { notifyThreshold: "loud", railFilter: "weird", notify: true },
    };
    const parsed = parse(odd);
    expect(parsed.agentboard?.notifyThreshold).toBeUndefined();
    expect(parsed.agentboard?.railFilter).toBeUndefined();
    expect(parsed.agentboard?.notify).toBe(true);
  });

  it("defaults taskTemplates to empty when the key is absent", () => {
    const { taskTemplates: _taskTemplates, ...without } = valid;
    expect(parse(without).taskTemplates).toEqual([]);
  });

  it("rejects a payload missing a required field", () => {
    const { preferredEditor: _preferredEditor, ...missing } = valid;
    expect(() => parse(missing)).toThrow("preferredEditor");
  });
});
