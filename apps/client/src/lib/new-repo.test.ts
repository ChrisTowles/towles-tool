import { describe, expect, it } from "vitest";
import { cloneDirName, repoParentDirs } from "./new-repo";

describe("repoParentDirs", () => {
  it("orders parents by how many tracked repos live there", () => {
    expect(repoParentDirs(["/c/w/a", "/c/p/x", "/c/p/y", "/c/p/z/", "/root"])).toEqual([
      "/c/p",
      "/c/w",
    ]);
  });
});

describe("cloneDirName", () => {
  it("names the folder after the repo, whatever form the source takes", () => {
    expect(cloneDirName("owner/repo")).toBe("repo");
    expect(cloneDirName("https://github.com/owner/repo.git/")).toBe("repo");
    expect(cloneDirName("git@github.com:owner/repo.git")).toBe("repo");
  });
});
