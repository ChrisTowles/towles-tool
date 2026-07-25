/**
 * What a link in the Markdown preview should *do* when clicked.
 *
 * Left alone, every one of them is wrong. An `<a href="https://…">` inside the
 * webview navigates the app away from itself — the whole shell replaced by a
 * web page, with no back button, because there is no browser chrome here. A
 * relative `[docs](docs/FOO.md)` is worse: it resolves against the frontend's
 * own origin and 404s, when the file is right there in the checkout the
 * preview is already reading from.
 *
 * So each href is classified into one of three intents and handled explicitly
 * by the preview's `a` component. Anchors are the only kind the browser
 * already gets right, and they still need slugged heading ids to land on.
 */

import { resolveRepoPath } from "@/lib/markdown-assets";

export type MarkdownLink =
  /** Open in the OS browser via `openExternalUrl`. */
  | { kind: "external"; url: string }
  /** Open this repo-relative file in the Files pane; `hash` scrolls within it. */
  | { kind: "repo"; path: string; hash: string | null }
  /** Scroll to a heading in the document already on screen. */
  | { kind: "anchor"; hash: string }
  /** Nothing sensible to do — rendered as plain text. */
  | { kind: "invalid" };

/** Schemes worth handing to the OS. Anything else is refused rather than
 * dispatched: `openUrl` on a `javascript:` or `file:` URL is the OS's problem
 * to have, and it shouldn't get one. */
const EXTERNAL_SCHEMES = new Set(["http", "https", "mailto"]);

/**
 * Classify a link `href` found in the file at `fromPath`.
 *
 * Note the asymmetry with `resolveMarkdownSrc`: a bare `#section` is a real
 * link (it's how a README's table of contents works) but not a real image, and
 * a `data:` URL is a fine image but not something to navigate to.
 */
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

/**
 * GitHub's heading-anchor rule, so a document's own table of contents lands on
 * the right heading: lowercase, drop everything that isn't a word character,
 * space or hyphen, then spaces to hyphens.
 *
 * Ours rather than `rehype-slug`'s (which follows the HTML `id` spec) because
 * the links being resolved were written against GitHub — an id scheme that is
 * merely *valid* would leave every existing `#some-heading` link dead.
 *
 * Each space becomes its own hyphen rather than a run collapsing into one:
 * `A — B` is `a--b` on GitHub, because the em dash is deleted and the two
 * spaces around it survive. Collapsing reads as tidier and breaks every link
 * into a heading containing punctuation.
 */
export function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\w\- ]+/g, "")
    .replace(/ /g, "-");
}
