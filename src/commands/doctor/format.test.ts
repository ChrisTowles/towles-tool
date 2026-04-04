import { describe, it, expect } from "vitest";
import { formatDoctorJson } from "./format.js";
import type { DoctorRunResult } from "./checks.js";

function makeResult(overrides: Partial<DoctorRunResult> = {}): DoctorRunResult {
  return {
    timestamp: "2024-06-01T12:00:00.000Z",
    tools: [
      { name: "git", version: "2.40.0", ok: true },
      { name: "node", version: "20.11.0", ok: true },
      { name: "bun", version: "1.1.0", ok: true },
    ],
    ghAuth: true,
    plugins: [{ name: "code-simplifier", ok: true }],
    agentboard: [{ name: "database", ok: true }],
    ...overrides,
  };
}

describe("formatDoctorJson", () => {
  it("returns valid JSON with all fields", () => {
    const result = makeResult();
    const output = formatDoctorJson(result);
    const parsed = JSON.parse(output);

    expect(parsed.timestamp).toBe("2024-06-01T12:00:00.000Z");
    expect(parsed.tools).toHaveLength(3);
    expect(parsed.ghAuth).toBe(true);
    expect(parsed.plugins).toHaveLength(1);
    expect(parsed.agentboard).toHaveLength(1);
  });

  it("includes tool details", () => {
    const result = makeResult();
    const parsed = JSON.parse(formatDoctorJson(result));
    const git = parsed.tools.find((t: { name: string }) => t.name === "git");

    expect(git).toEqual({ name: "git", version: "2.40.0", ok: true });
  });

  it("includes warning field when present", () => {
    const result = makeResult({
      tools: [{ name: "ttyd", version: null, ok: true, warning: "optional, not installed" }],
    });
    const parsed = JSON.parse(formatDoctorJson(result));

    expect(parsed.tools[0].warning).toBe("optional, not installed");
  });

  it("preserves ghAuth false", () => {
    const result = makeResult({ ghAuth: false });
    const parsed = JSON.parse(formatDoctorJson(result));

    expect(parsed.ghAuth).toBe(false);
  });

  it("roundtrips through JSON.parse", () => {
    const result = makeResult();
    const parsed = JSON.parse(formatDoctorJson(result));

    expect(parsed).toEqual(result);
  });
});
