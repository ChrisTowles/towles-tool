/** What a link in the Markdown preview should *do*: left alone, an external href
 * navigates the shell away with no back button, and a relative one 404s against
 * the frontend origin instead of hitting the checkout. */

import { resolveRepoPath } from "@/lib/markdown-assets";

export type MarkdownLink =
  | { kind: "external"; url: string }
  | { kind: "repo"; path: string; hash: string | null }
  | { kind: "anchor"; hash: string }
  | { kind: "invalid" };

/** Anything else is refused: `openUrl` shouldn't get a `javascript:` URL. */
const EXTERNAL_SCHEMES = new Set(["http", "https", "mailto"]);

export function classifyMarkdownLink(fromPath: string, href: string): MarkdownLink {
  const trimmed = href.trim();
  if (trimmed === "") return { kind: "invalid" };
  if (trimmed.startsWith("#")) {
    return trimmed.length > 1 ? { kind: "anchor", hash: trimmed.slice(1) } : { kind: "invalid" };
  }
  if (trimmed.startsWith("//")) return { kind: "external", url: `https:${trimmed}` };
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed)?.[1].toLowerCase();
  if (scheme !== undefined) {
    return EXTERNAL_SCHEMES.has(scheme) ? { kind: "external", url: trimmed } : { kind: "invalid" };
  }
  const path = resolveRepoPath(fromPath, trimmed);
  if (path === null) return { kind: "invalid" };
  const hash = trimmed.includes("#") ? trimmed.slice(trimmed.indexOf("#") + 1) : "";
  return { kind: "repo", path, hash: hash === "" ? null : hash };
}

/** GitHub's rule, not `rehype-slug`'s — the links were written against GitHub, so
 * a merely *valid* id scheme leaves them all dead. Each space becomes its own
 * hyphen (`A — B` is `a--b`); collapsing runs looks tidier and breaks links. */
export function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\w\- ]+/g, "")
    .replace(/ /g, "-");
}
