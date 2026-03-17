import { describe, expect, it, vi, beforeEach } from "vitest";

import { execSafe } from "../../utils/git/exec.js";
import { ensureLabelsExist, LABELS, removeLabel, setLabel } from "./labels";

vi.mock("../../utils/git/exec.js", () => ({
  execSafe: vi.fn().mockResolvedValue({ stdout: "", ok: true }),
}));

const mockedExecSafe = vi.mocked(execSafe);

describe("LABELS", () => {
  it("has expected label values", () => {
    expect(LABELS.inProgress).toBe("auto-claude-in-progress");
    expect(LABELS.review).toBe("auto-claude-review");
    expect(LABELS.failed).toBe("auto-claude-failed");
    expect(LABELS.success).toBe("auto-claude-success");
  });

  it("has exactly 4 labels", () => {
    expect(Object.keys(LABELS)).toHaveLength(4);
  });
});

describe("ensureLabelsExist", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates all labels with --force", async () => {
    await ensureLabelsExist("owner/repo");

    expect(mockedExecSafe).toHaveBeenCalledTimes(4);
    for (const label of Object.values(LABELS)) {
      expect(mockedExecSafe).toHaveBeenCalledWith("gh", [
        "label",
        "create",
        label,
        "--repo",
        "owner/repo",
        "--force",
      ]);
    }
  });
});

describe("setLabel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls gh issue edit with --add-label", async () => {
    await setLabel("owner/repo", 42, "auto-claude-in-progress");

    expect(mockedExecSafe).toHaveBeenCalledWith("gh", [
      "issue",
      "edit",
      "42",
      "--repo",
      "owner/repo",
      "--add-label",
      "auto-claude-in-progress",
    ]);
  });
});

describe("removeLabel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls gh issue edit with --remove-label", async () => {
    await removeLabel("owner/repo", 42, "auto-claude-failed");

    expect(mockedExecSafe).toHaveBeenCalledWith("gh", [
      "issue",
      "edit",
      "42",
      "--repo",
      "owner/repo",
      "--remove-label",
      "auto-claude-failed",
    ]);
  });
});
