import { describe, expect, it } from "vitest";
import { baseChips, parseRecentBases, rememberBase } from "./recent-bases";

const b = (name: string) => ({ name, label: `origin/${name}` });
const branches = [b("main"), b("develop"), b("release"), b("hotfix"), b("spike")];

describe("baseChips", () => {
  it("leads with the default, then the recent bases the repo still has", () => {
    expect(baseChips(branches, ["release", "gone", "develop"]).map((c) => c.name)).toEqual([
      "main",
      "release",
      "develop",
    ]);
  });
  it("never repeats the default and stops at the cap", () => {
    const chips = baseChips(branches, ["main", "spike", "hotfix", "release", "develop"]);
    expect(chips.map((c) => c.name)).toEqual(["main", "spike", "hotfix", "release"]);
  });
  it("is empty until the branches load", () => {
    expect(baseChips([], ["main"])).toEqual([]);
  });
});

describe("rememberBase", () => {
  it("moves the base to the front, once, and forgets the oldest", () => {
    expect(rememberBase(["a", "b"], "b")).toEqual(["b", "a"]);
    expect(rememberBase(["a", "b", "c", "d", "e", "f"], "g")).toEqual([
      "g",
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });
});

describe("parseRecentBases", () => {
  it("reads a stored list and treats anything else as no history", () => {
    expect(parseRecentBases('["main","dev"]')).toEqual(["main", "dev"]);
    expect(parseRecentBases(null)).toEqual([]);
    expect(parseRecentBases("{oops")).toEqual([]);
    expect(parseRecentBases('{"a":1}')).toEqual([]);
    expect(parseRecentBases('["ok",3]')).toEqual(["ok"]);
  });
});
