import { describe, expect, it } from "vitest";
import type { QueuePark } from "@/lib/schemas/queue";
import type { FolderData, RepoData } from "./types";
import { parkedDirs, parkFact, revisitAt } from "./park";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 10, 12, 15, 0).getTime();

const park = (over: Partial<QueuePark> = {}): QueuePark => ({
  kind: "later",
  note: null,
  untilMs: null,
  atMs: NOW - 3 * DAY,
  due: null,
  held: true,
  ...over,
});

const repo = (key: string, dirs: string[]) =>
  ({ key, folders: dirs.map((dir) => ({ dir }) as FolderData) }) as RepoData;

describe("parkedDirs", () => {
  it("folds held parks only, and never the checkout on screen", () => {
    const parks = new Map([
      ["/a", park()],
      ["/b", park({ held: false, due: "date" })],
      ["/c", park()],
    ]);
    const out = parkedDirs([repo("r", ["/a", "/b", "/c", "/d"])], parks, "/c");
    expect(out.get("r")).toEqual(new Set(["/a"]));
  });

  it("leaves a repo with nothing parked out of the map", () => {
    expect(parkedDirs([repo("r", ["/a"])], new Map(), null).size).toBe(0);
  });
});

describe("parkFact", () => {
  it("names the kind and how long it has sat", () => {
    expect(parkFact(park(), NOW)).toBe("later · 3d");
    expect(parkFact(park({ kind: "blocked", atMs: NOW - 1000 }), NOW)).toBe("blocked · today");
  });

  it("says why a due park is back", () => {
    expect(parkFact(park({ due: "date", held: false }), NOW)).toBe("revisit · parked 3d");
    expect(parkFact(park({ due: "changed", held: false }), NOW)).toBe("unblocked? · parked 3d");
    expect(parkFact(park({ due: "landed", held: false }), NOW)).toBe("landed · parked 3d");
  });

  it("shows a revisit date still ahead", () => {
    expect(parkFact(park({ untilMs: NOW + DAY }), NOW)).toMatch(/^later · until /);
  });
});

describe("revisitAt", () => {
  it("lands on 09:00 local", () => {
    const at = new Date(revisitAt("tomorrow", NOW) as number);
    expect([at.getDate(), at.getHours()]).toEqual([13, 9]);
    const week = new Date(revisitAt("week", NOW) as number);
    expect(week.getDate()).toBe(19);
    const date = new Date(revisitAt("date", NOW, "2026-12-01") as number);
    expect([date.getMonth(), date.getDate(), date.getHours()]).toEqual([11, 1, 9]);
  });

  it("is null for no date or a bad one", () => {
    expect(revisitAt("none", NOW)).toBeNull();
    expect(revisitAt("date", NOW, "next week")).toBeNull();
  });
});
