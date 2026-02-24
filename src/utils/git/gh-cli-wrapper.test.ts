import { beforeEach, describe, expect, it, vi } from "vitest";
import { getIssues, isGithubCliInstalled } from "./gh-cli-wrapper";

vi.mock("tinyexec", () => ({
  x: vi.fn().mockResolvedValue({ stdout: "[]" }),
}));

describe("gh-cli-wrapper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getIssues", () => {
    it("passes --label flag when label provided", async () => {
      const { x } = await import("tinyexec");
      const mockX = vi.mocked(x);
      mockX.mockResolvedValue({ stdout: "[]" } as never);

      await getIssues({ cwd: ".", label: "auto-claude" });

      expect(mockX).toHaveBeenCalledWith("gh", expect.arrayContaining(["--label", "auto-claude"]));
    });

    it("does not pass --label flag when label not provided", async () => {
      const { x } = await import("tinyexec");
      const mockX = vi.mocked(x);
      mockX.mockResolvedValue({ stdout: "[]" } as never);

      await getIssues({ cwd: "." });

      const args = mockX.mock.calls[0]![1] as string[];
      expect(args).not.toContain("--label");
    });

    it("passes --assignee @me flag when assignedToMe is true", async () => {
      const { x } = await import("tinyexec");
      const mockX = vi.mocked(x);
      mockX.mockResolvedValue({ stdout: "[]" } as never);

      await getIssues({ cwd: ".", assignedToMe: true });

      expect(mockX).toHaveBeenCalledWith("gh", expect.arrayContaining(["--assignee", "@me"]));
    });
  });

  describe("isGithubCliInstalled", () => {
    it("returns true when gh CLI outputs expected string", async () => {
      const { x } = await import("tinyexec");
      const mockX = vi.mocked(x);
      mockX.mockResolvedValue({ stdout: "gh version 2.0.0 (https://github.com/cli/cli)" } as never);

      const result = await isGithubCliInstalled();
      expect(result).toBe(true);
    });

    it("returns false when gh CLI is not available", async () => {
      const { x } = await import("tinyexec");
      const mockX = vi.mocked(x);
      mockX.mockRejectedValue(new Error("command not found"));

      const result = await isGithubCliInstalled();
      expect(result).toBe(false);
    });
  });
});

describe("getIssues label filter", () => {
  it("passes --label flag when label provided", async () => {
    const { x } = await import("tinyexec");
    vi.mocked(x).mockResolvedValueOnce({
      stdout: "[]",
      stderr: "",
      exitCode: 0,
    } as never);

    await getIssues({ cwd: ".", label: "auto-claude" });

    expect(x).toHaveBeenCalledWith("gh", expect.arrayContaining(["--label", "auto-claude"]));
  });
});

vi.mock("tinyexec", async (importOriginal) => {
  const actual = await importOriginal<typeof import("tinyexec")>();
  return {
    ...actual,
    x: vi.fn(actual.x),
  };
});
