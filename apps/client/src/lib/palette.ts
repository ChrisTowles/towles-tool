import { defaultFilter } from "cmdk";
import { sessionLabel, sessionNeeds, type RepoData } from "./agentboard";
import type { IssueItem, PrItem } from "./data";
import { SCREENS, type ScreenId } from "./screens";

/**
 * Pure builders for the command palette's dynamic sections (repos, sessions,
 * open PRs, open issues). Kept out of the component so the ordering/labelling rules are
 * unit-testable without a DOM: the palette itself just maps these to
 * `<CommandItem>`s. All are read-only projections of the agentboard state and
 * store snapshot — nothing here writes.
 */

/** A checkout (folder) to jump to in Agentboard. */
export type PaletteRepoEntry = {
  /** Stable de-dupe/react key. */
  key: string;
  folderDir: string;
  /** Repo name, e.g. `octo/widgets` (the rail's logical repo). */
  repoName: string;
  /** Checkout name — distinguishes worktrees/tasks of the same repo. */
  folderName: string;
  branch: string;
  /** Sessions in this checkout that need attention right now. */
  needs: number;
  /** Extra fuzzy-match terms (repo, folder, branch). */
  keywords: string[];
};

/** A PTY session to reveal in Agentboard. */
export type PaletteSessionEntry = {
  key: string;
  folderDir: string;
  sessionId: string;
  label: string;
  repoName: string;
  folderName: string;
  /** True when the session is blocked/errored/finished-unseen. */
  needs: boolean;
  keywords: string[];
};

/** An open PR to open in the browser. */
export type PalettePrEntry = {
  key: string;
  url: string;
  repo: string;
  number: number;
  title: string;
  checks: string;
  keywords: string[];
};

/** A "create a todo from the current query" action. */
export type PaletteQuickAddEntry = {
  key: string;
  /** Trimmed query — the title the todo is created with. */
  title: string;
};

/** An open issue to open in the browser. */
export type PaletteIssueEntry = {
  key: string;
  url: string;
  repo: string;
  number: number;
  title: string;
  keywords: string[];
};

/** One entry per checkout, in rail order (repo → folder), skipping checkouts
 * with no on-disk `dir`. Checkouts needing attention are surfaced first. */
export function paletteRepoEntries(repos: RepoData[]): PaletteRepoEntry[] {
  const out: PaletteRepoEntry[] = [];
  for (const repo of repos) {
    for (const folder of repo.folders) {
      if (!folder.dir) continue;
      out.push({
        key: folder.dir,
        folderDir: folder.dir,
        repoName: repo.name,
        folderName: folder.name,
        branch: folder.branch,
        needs: folder.sessions.filter(sessionNeeds).length,
        keywords: [repo.name, folder.name, folder.branch].filter(Boolean),
      });
    }
  }
  return stableSortByNeeds(out, (e) => e.needs > 0);
}

/** One entry per session across every checkout, sessions needing attention
 * first (so the palette leads with "the agent waiting on you"). */
export function paletteSessionEntries(repos: RepoData[]): PaletteSessionEntry[] {
  const out: PaletteSessionEntry[] = [];
  for (const repo of repos) {
    for (const folder of repo.folders) {
      if (!folder.dir) continue;
      for (const s of folder.sessions) {
        const label = sessionLabel(s);
        out.push({
          key: s.id,
          folderDir: folder.dir,
          sessionId: s.id,
          label,
          repoName: repo.name,
          folderName: folder.name,
          needs: sessionNeeds(s),
          keywords: [label, repo.name, folder.name].filter(Boolean),
        });
      }
    }
  }
  return stableSortByNeeds(out, (e) => e.needs);
}

/** One entry per open PR, newest-updated first. Non-open PRs are dropped —
 * the palette action opens the PR page, which only makes sense while it's live. */
export function palettePrEntries(prs: PrItem[]): PalettePrEntry[] {
  return prs
    .filter((p) => p.state === "open")
    .slice()
    .toSorted((a, b) => b.updatedTs - a.updatedTs)
    .map((p) => ({
      key: `${p.repo}#${p.number}`,
      url: p.url,
      repo: p.repo,
      number: p.number,
      title: p.title,
      checks: p.checks,
      keywords: [p.repo, `#${p.number}`, p.title, p.branch].filter(Boolean),
    }));
}

/** One entry per open issue, newest-updated first. Non-open issues are dropped —
 * the palette action opens the issue page, which only makes sense while it's live. */
export function paletteIssueEntries(issues: IssueItem[]): PaletteIssueEntry[] {
  return issues
    .filter((i) => i.state === "open")
    .slice()
    .toSorted((a, b) => b.updatedTs - a.updatedTs)
    .map((i) => ({
      key: `${i.repo}#${i.number}`,
      url: i.url,
      repo: i.repo,
      number: i.number,
      title: i.title,
      keywords: [i.repo, `#${i.number}`, i.title, ...i.labels].filter(Boolean),
    }));
}

/** The quick-add action for the current palette query, or `null` when the query
 * is empty/whitespace (nothing to name a todo). The trimmed query is preserved
 * verbatim as the title — long text and internal whitespace stay intact. */
export function paletteQuickAddEntry(query: string): PaletteQuickAddEntry | null {
  const title = query.trim();
  if (!title) return null;
  return { key: "quick-add", title };
}

/** How many MRU screens the Recent group shows — a shortcut, not a second full
 * screen list. */
const RECENT_LIMIT = 4;

/**
 * The screens the "Recent" group renders: MRU minus the screen you're already
 * looking at, capped, and **empty whenever the query is non-empty**.
 *
 * The emptying is the fix for the exact-title-match bug, not a cosmetic choice.
 * cmdk ranks *items* within a group by score correctly, but its cross-group
 * ordering is broken for any heading containing a character `encodeURIComponent`
 * escapes: it looks the group element up with
 * `[cmdk-group][data-value="${encodeURIComponent(heading)}"]` while the element
 * carries the heading verbatim, so `Go to` never matches and that group is never
 * hoisted. The first group in DOM order therefore keeps the initial selection —
 * with Agentboard in Recent, typing `Board` auto-selected `Recent > Agentboard`
 * and Enter navigated to the wrong screen. Recent is a zero-query convenience
 * (every screen is already in "Go to"), so dropping it while searching both
 * removes the duplicate rows and leaves "Go to" as the first group, where the
 * within-group score sort puts the exact match on top.
 */
export function paletteRecentScreens(
  recent: readonly string[],
  activeTab: string,
  query: string,
): ScreenId[] {
  if (query.trim()) return [];
  return recent
    .filter((id): id is ScreenId => id !== activeTab && id in SCREENS)
    .slice(0, RECENT_LIMIT);
}

/**
 * Palette scoring: an exact match of an item's own value wins outright, else
 * cmdk's default fuzzy score.
 *
 * cmdk's default filter appends an item's keywords to its value before scoring,
 * so typing a screen's exact title (`Board`) scores 0.99 rather than 1 and can
 * be tied or beaten by a longer entry that happens to contain it. Typing
 * something's full name is an unambiguous statement of intent, so it ranks first
 * regardless of what else matched.
 */
export function paletteFilter(value: string, search: string, keywords?: string[]): number {
  const q = search.trim().toLowerCase();
  if (q && value.trim().toLowerCase() === q) return 1;
  return defaultFilter(value, search, keywords);
}

/** Stable partition: entries flagged by `needs` keep their relative order but
 * come first. (`Array.prototype.sort` is stable in modern engines, but a plain
 * partition makes the intent obvious and avoids comparator sign juggling.) */
function stableSortByNeeds<T>(items: T[], needs: (item: T) => boolean): T[] {
  const hot: T[] = [];
  const rest: T[] = [];
  for (const it of items) (needs(it) ? hot : rest).push(it);
  return [...hot, ...rest];
}
