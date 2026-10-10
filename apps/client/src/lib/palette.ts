import { sessionLabel, type RepoData } from "./agentboard";
import type { IssueItem, PrItem } from "./data";
import { SCREENS, type ScreenId } from "./screens";

/** Pure builders for the palette's dynamic sections, unit-testable without a DOM. */

/** A checkout (folder) to jump to in Agentboard. */
export type PaletteRepoEntry = {
  key: string;
  folderDir: string;
  repoName: string;
  folderName: string;
  branch: string;
  needs: number;
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

export type PalettePrEntry = {
  key: string;
  url: string;
  repo: string;
  number: number;
  title: string;
  checks: string;
  keywords: string[];
};

export type PaletteQuickAddEntry = {
  key: string;
  title: string;
};

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
        needs: folder.needs,
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
          needs: s.needsReason != null,
          keywords: [label, repo.name, folder.name].filter(Boolean),
        });
      }
    }
  }
  return stableSortByNeeds(out, (e) => e.needs);
}

/** Open PRs only, newest-updated first — the action opens the PR page. */
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

/** Open issues only, newest-updated first — the action opens the issue page. */
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

/** The `ui.action` detail for a checkout/session jump: did it go to something
 * waiting on the user? Never the name — that is content. */
export function paletteNeedsDetail(needs: boolean): "needs" | undefined {
  return needs ? "needs" : undefined;
}

/** `null` for an empty query — nothing to name a todo. The trimmed query is
 * the title verbatim; long text and internal whitespace stay intact. */
export function paletteQuickAddEntry(query: string): PaletteQuickAddEntry | null {
  const title = query.trim();
  if (!title) return null;
  return { key: "quick-add", title };
}

const RECENT_LIMIT = 4;

/** Empty while searching, so Recent's duplicate rows never compete with "Go to"'s
 * exact match. */
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

/** How well `target` matches `q`, both lowercased: a prefix beats a word start
 * beats a substring beats a subsequence, and a tight subsequence beats a loose
 * one. A subsequence spread past 3× the query is noise, not a match: 0. */
function matchScore(target: string, q: string): number {
  if (target.startsWith(q)) return 0.9;
  const at = target.indexOf(q);
  if (at > 0) return /[\s/#._-]/.test(target[at - 1]) ? 0.8 : 0.7;
  let first = -1;
  let pos = -1;
  for (const ch of q) {
    pos = target.indexOf(ch, pos + 1);
    if (pos === -1) return 0;
    if (first === -1) first = pos;
  }
  const span = pos - first + 1;
  return span > 3 * q.length ? 0 : 0.1 + (0.4 * q.length) / span;
}

/** The palette's score for one row, 0 to 1. An exact title wins outright, and a
 * keyword hit counts for a little less than the same hit on the title. */
export function paletteFilter(value: string, search: string, keywords: string[] = []): number {
  const q = search.trim().toLowerCase();
  if (!q || value.trim().toLowerCase() === q) return 1;
  return Math.max(
    matchScore(value.toLowerCase(), q),
    ...keywords.map((k) => 0.9 * matchScore(k.toLowerCase(), q)),
  );
}

/** Stable partition: entries flagged by `needs` come first, keeping their
 * relative order. A partition rather than a comparator, for legibility. */
function stableSortByNeeds<T>(items: T[], needs: (item: T) => boolean): T[] {
  const hot: T[] = [];
  const rest: T[] = [];
  for (const it of items) (needs(it) ? hot : rest).push(it);
  return [...hot, ...rest];
}
