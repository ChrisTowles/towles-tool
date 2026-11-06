// Random walks over the real atoms: snapshots arriving, clicks, folds, the
// cursor, panes — and after every step, the invariants the UI relies on.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acceptAgentboard, reposAtom } from "@/lib/agentboard/state";
import { EMPTY_STATE } from "@/lib/agentboard/store";
import type { FolderData, RepoData, StatePayload } from "@/lib/agentboard/types";
import { appRegistry, read } from "@/lib/atoms/registry";
import { folder, repo, session } from "@/screens/agentboard/test-fixtures";
import {
  readBoard,
  setIdleRevealed,
  setQuery,
  setRailCursor,
  setSelected,
  setUnmanagedRevealed,
} from "./atoms";
import { addPaneToActive, removePane, toggleCollapsed } from "./commands";
import { cursorNodeAtom, hotkeyTargetsAtom, railTreeAtom, winsAtom } from "./derive";
import { normalize } from "./model";
import { SELECTION } from "./selection";

/** mulberry32: small, seeded, reproducible. */
function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ORIGINS = ["checkout", "task", "detected"] as const;

function snapshot(r: () => number, ts: number): StatePayload {
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const repos: RepoData[] = [];
  for (let ri = 0; ri < 3; ri++) {
    if (r() < 0.15) continue;
    const folders: FolderData[] = [];
    for (let fi = 0; fi < 3; fi++) {
      if (fi > 0 && r() < 0.3) continue;
      const dir = `/r${ri}/f${fi}`;
      const sessions = [0, 1]
        .filter(() => r() < 0.5)
        .map((si) => session({ id: `${dir}#${si}`, live: r() < 0.7, working: r() < 0.3 }));
      folders.push(
        folder({
          dir,
          name: `f${fi}`,
          isWorktree: fi > 0,
          record: { origin: fi === 0 ? "checkout" : pick(ORIGINS) } as FolderData["record"],
          quiet: r() < 0.1,
          sessions,
        }),
      );
    }
    repos.push(repo(`r${ri}`, folders));
  }
  return { ...EMPTY_STATE, repos, ts };
}

const allDirs = () => read(railTreeAtom).flatMap((n) => (n.dir ? [n.dir] : []));

function step(r: () => number, ts: number) {
  const pick = <T>(xs: readonly T[]): T | undefined => xs[Math.floor(r() * xs.length)];
  const tree = read(railTreeAtom);
  const sessions = tree.filter((n) => n.sessionId !== null);
  const roll = r();
  if (roll < 0.15) return acceptAgentboard(snapshot(r, ts));
  if (roll < 0.3) {
    const n = pick(sessions);
    // Sometimes a session the snapshot no longer has: a click landing late.
    if (n?.dir && n.sessionId) return SELECTION.selectSession(n.dir, n.sessionId);
    return SELECTION.selectSession("/gone", "/gone#0");
  }
  if (roll < 0.42) {
    const dir = pick(allDirs());
    if (dir) return SELECTION.selectFolder(dir);
  }
  if (roll < 0.52) {
    const key = pick(tree.flatMap((n) => (n.collapseKey ? [n.collapseKey] : [])));
    if (key) return toggleCollapsed(key);
  }
  if (roll < 0.62) return setRailCursor(pick(tree) ?? null);
  if (roll < 0.68) return setQuery(r() < 0.7 ? "" : "f1");
  if (roll < 0.74) {
    const key = `r${Math.floor(r() * 3)}`;
    const set = r() < 0.5 ? setIdleRevealed : setUnmanagedRevealed;
    return set((s) => (s.has(key) ? new Set() : new Set([key])));
  }
  if (roll < 0.84) {
    const n = pick(sessions);
    if (n?.dir && n.sessionId) return addPaneToActive(n.dir, n.sessionId);
  }
  if (roll < 0.92) {
    const pane = pick(read(winsAtom)?.windows.flatMap((w) => w.panes) ?? []);
    if (pane) return removePane(pane);
  }
  // A stale selection written directly: the record's writer must still hold.
  setSelected({ folderDir: pick(allDirs()) ?? "/x", sessionId: "stale" });
}

const snapshotSessions = () =>
  read(reposAtom).flatMap((r) => r.folders.flatMap((f) => f.sessions.map((s) => s.id)));
const snapshotHasDir = (dir: string) =>
  read(reposAtom).some((r) => !r.archived && r.folders.some((f) => f.dir === dir));

/** Every invariant the UI relies on, as the list of the ones broken. */
function violations(): string[] {
  const out: string[] = [];
  const fail = (cond: boolean, what: string) => {
    if (!cond) out.push(what);
  };
  const ui = readBoard();
  fail(normalize(ui) === ui, "the record is normalized");
  fail(
    ui.selected === null || ui.selected.folderDir === ui.activeFolderDir,
    "the selection is in the checkout on screen",
  );
  fail(new Set(ui.open).size === ui.open.length, "a session mounts once");

  const tree = read(railTreeAtom);
  fail(new Set(tree.map((n) => n.key)).size === tree.length, "tree keys are unique");
  const cursor = read(cursorNodeAtom);
  fail(cursor === null || tree.includes(cursor), "the cursor is on a row");

  const sessionRows = new Set(tree.flatMap((n) => (n.sessionId ? [n.sessionId] : [])));
  for (const t of read(hotkeyTargetsAtom))
    fail(sessionRows.has(t.sessionId), `jump digit for ${t.sessionId} names a row`);

  const active = ui.activeFolderDir;
  fail(
    !(active && ui.query === "" && snapshotHasDir(active)) ||
      tree.some((n) => n.dir === active && n.kind !== "session"),
    "a fold never hides the checkout on screen",
  );

  const valid = new Set([...ui.open, ...snapshotSessions()]);
  for (const w of read(winsAtom)?.windows ?? [])
    for (const p of w.panes) fail(valid.has(p), `pane ${p} is a real session`);
  return out;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  appRegistry.reset();
});

describe("Agent Board invariants under random message sequences", () => {
  for (const seed of [1, 2, 3, 5, 8, 13, 21, 34, 55, 89]) {
    it(`seed ${seed}`, () => {
      const r = rng(seed);
      acceptAgentboard(snapshot(r, 1));
      const broken: string[] = [];
      for (let i = 0; i < 300; i++) {
        step(r, i + 2);
        broken.push(...violations().map((v) => `step ${i}: ${v}`));
      }
      expect(broken).toEqual([]);
    });
  }
});
