import { beforeEach, describe, expect, it, vi } from "vitest";

import type { XFn } from "./gh-cli-wrapper";
import { getIssues, isGithubCliInstalled } from "./gh-cli-wrapper";

const mockX: XFn = vi.fn().mockResolvedValue({ stdout: "[]", stderr: "", exitCode: 0 });

describe("gh-cli-wrapper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mockX).mockResolvedValue({ stdout: "[]", stderr: "", exitCode: 0 });
  });

  describe("getIssues", () => {
    it("passes --label flag when label provided", async () => {
      await getIssues({ cwd: ".", label: "auto-claude", exec: mockX });

      expect(mockX).toHaveBeenCalledWith("gh", expect.arrayContaining(["--label", "auto-claude"]));
    });

    it("does not pass --label flag when label not provided", async () => {
      await getIssues({ cwd: ".", exec: mockX });

      const args = vi.mocked(mockX).mock.calls[0]![1] as string[];
      expect(args).not.toContain("--label");
    });

    it("passes --assignee @me flag when assignedToMe is true", async () => {
      await getIssues({ cwd: ".", assignedToMe: true, exec: mockX });

      expect(mockX).toHaveBeenCalledWith("gh", expect.arrayContaining(["--assignee", "@me"]));
    });
  });

  describe("isGithubCliInstalled", () => {
    it("returns true when gh CLI outputs expected string", async () => {
      vi.mocked(mockX).mockResolvedValue({
        stdout: "gh version 2.0.0 (https://github.com/cli/cli)",
        stderr: "",
        exitCode: 0,
      });

      const result = await isGithubCliInstalled(mockX);
      expect(result).toBe(true);
    });

    it("returns false when gh CLI is not available", async () => {
      vi.mocked(mockX).mockRejectedValue(new Error("command not found"));

      const result = await isGithubCliInstalled(mockX);
      expect(result).toBe(false);
    });
  });
});
