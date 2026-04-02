import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ExecSafeFn } from "./labels";
import { ensureLabelsExist, LABELS, removeLabel, setLabel } from "./labels";

const mockExecSafe: ExecSafeFn = vi.fn().mockResolvedValue({ stdout: "", ok: true });

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
    await ensureLabelsExist("owner/repo", mockExecSafe);

    expect(mockExecSafe).toHaveBeenCalledTimes(4);
    for (const label of Object.values(LABELS)) {
      expect(mockExecSafe).toHaveBeenCalledWith("gh", [
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
    await setLabel("owner/repo", 42, "auto-claude-in-progress", mockExecSafe);

    expect(mockExecSafe).toHaveBeenCalledWith("gh", [
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
    await removeLabel("owner/repo", 42, "auto-claude-failed", mockExecSafe);

    expect(mockExecSafe).toHaveBeenCalledWith("gh", [
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
