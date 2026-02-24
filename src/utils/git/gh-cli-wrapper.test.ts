import { beforeEach, describe, expect, it, vi } from "vitest";
import { x } from "tinyexec";
import { getIssues, isGithubCliInstalled } from "./gh-cli-wrapper";

vi.mock("tinyexec", () => ({
  x: vi.fn().mockResolvedValue({ stdout: "[]" }),
}));

const mockX = vi.mocked(x);

describe("gh-cli-wrapper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockX.mockResolvedValue({ stdout: "[]" } as never);
  });

  describe("getIssues", () => {
    it("passes --label flag when label provided", async () => {
      await getIssues({ cwd: ".", label: "auto-claude" });

      expect(mockX).toHaveBeenCalledWith("gh", expect.arrayContaining(["--label", "auto-claude"]));
    });

    it("does not pass --label flag when label not provided", async () => {
      await getIssues({ cwd: "." });

      const args = mockX.mock.calls[0]![1] as string[];
      expect(args).not.toContain("--label");
    });

    it("passes --assignee @me flag when assignedToMe is true", async () => {
      await getIssues({ cwd: ".", assignedToMe: true });

      expect(mockX).toHaveBeenCalledWith("gh", expect.arrayContaining(["--assignee", "@me"]));
    });
  });

  describe("isGithubCliInstalled", () => {
    it("returns true when gh CLI outputs expected string", async () => {
      mockX.mockResolvedValue({ stdout: "gh version 2.0.0 (https://github.com/cli/cli)" } as never);

      const result = await isGithubCliInstalled();
      expect(result).toBe(true);
    });

    it("returns false when gh CLI is not available", async () => {
      mockX.mockRejectedValue(new Error("command not found"));

      const result = await isGithubCliInstalled();
      expect(result).toBe(false);
    });
  });
});
