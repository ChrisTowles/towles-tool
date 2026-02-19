import { describe, expect, it } from "vitest";
import { isProtectedBranch, discoverGitRepos } from "./branch-clean-all";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

describe("branch-clean-all", () => {
  describe("isProtectedBranch", () => {
    it("protects main", () => {
      expect(isProtectedBranch("main", "main", "feature/x")).toBe(true);
    });

    it("protects master", () => {
      expect(isProtectedBranch("master", "main", "feature/x")).toBe(true);
    });

    it("protects develop", () => {
      expect(isProtectedBranch("develop", "main", "feature/x")).toBe(true);
    });

    it("protects dev", () => {
      expect(isProtectedBranch("dev", "main", "feature/x")).toBe(true);
    });

    it("protects the base branch", () => {
      expect(isProtectedBranch("staging", "staging", "feature/x")).toBe(true);
    });

    it("protects the current branch", () => {
      expect(isProtectedBranch("feature/x", "main", "feature/x")).toBe(true);
    });

    it("does not protect a regular feature branch", () => {
      expect(isProtectedBranch("feature/123-add-login", "main", "feature/x")).toBe(false);
    });

    it("does not protect a branch named similarly to protected ones", () => {
      expect(isProtectedBranch("main-backup", "main", "feature/x")).toBe(false);
    });
  });

  describe("discoverGitRepos", () => {
    let tmpDir: string;

    function setup() {
      tmpDir = mkdtempSync(join(tmpdir(), "branch-clean-all-test-"));
    }

    function cleanup() {
      rmSync(tmpDir, { recursive: true, force: true });
    }

    it("finds directories with .git folder", () => {
      setup();
      try {
        // Create fake repos
        mkdirSync(join(tmpDir, "repo-a", ".git"), { recursive: true });
        mkdirSync(join(tmpDir, "repo-b", ".git"), { recursive: true });
        // Create a non-repo directory
        mkdirSync(join(tmpDir, "not-a-repo"), { recursive: true });

        const repos = discoverGitRepos(tmpDir);
        expect(repos).toHaveLength(2);
        expect(repos[0]).toContain("repo-a");
        expect(repos[1]).toContain("repo-b");
      } finally {
        cleanup();
      }
    });

    it("returns empty array when no repos found", () => {
      setup();
      try {
        mkdirSync(join(tmpDir, "just-a-folder"), { recursive: true });

        const repos = discoverGitRepos(tmpDir);
        expect(repos).toHaveLength(0);
      } finally {
        cleanup();
      }
    });

    it("returns sorted results", () => {
      setup();
      try {
        mkdirSync(join(tmpDir, "zz-repo", ".git"), { recursive: true });
        mkdirSync(join(tmpDir, "aa-repo", ".git"), { recursive: true });
        mkdirSync(join(tmpDir, "mm-repo", ".git"), { recursive: true });

        const repos = discoverGitRepos(tmpDir);
        expect(repos).toHaveLength(3);
        expect(repos[0]).toContain("aa-repo");
        expect(repos[1]).toContain("mm-repo");
        expect(repos[2]).toContain("zz-repo");
      } finally {
        cleanup();
      }
    });
  });

  describe("gone branch regex", () => {
    // Testing the regex pattern used in getGoneBranches
    const goneRegex = /^\*?\s+(\S+)\s+\S+\s+\[.+: gone\]/;

    it("matches a gone branch line", () => {
      const line =
        "  feature/old-thing   abc1234 [origin/feature/old-thing: gone] some commit message";
      const match = line.match(goneRegex);
      expect(match).not.toBeNull();
      expect(match![1]).toBe("feature/old-thing");
    });

    it("matches current branch with asterisk", () => {
      const line = "* feature/current    abc1234 [origin/feature/current: gone] msg";
      const match = line.match(goneRegex);
      expect(match).not.toBeNull();
      expect(match![1]).toBe("feature/current");
    });

    it("does not match a tracking branch that is not gone", () => {
      const line = "  feature/active      abc1234 [origin/feature/active] some message";
      const match = line.match(goneRegex);
      expect(match).toBeNull();
    });

    it("does not match a branch with ahead/behind info", () => {
      const line = "  feature/wip         abc1234 [origin/feature/wip: ahead 2] msg";
      const match = line.match(goneRegex);
      expect(match).toBeNull();
    });
  });
});
