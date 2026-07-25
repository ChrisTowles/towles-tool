/**
 * Resolving what a Markdown document points at — image `src`s here, link
 * `href`s in `markdown-links.ts`, both over [`resolveRepoPath`].
 *
 * A preview renders a file that lives in a checkout, so `![](docs/x.gif)` is
 * relative to *that file's directory*, not to the webview's origin — which is
 * where an untouched `src` resolves, and why every image in the preview used
 * to be a broken box. Turning one into the other is pure string work with a
 * handful of cases that are each individually obvious and collectively easy to
 * get wrong, so it lives here with tests rather than inline in the component.
 *
 * The bytes themselves come from the `ttasset` URI scheme
 * (`crates-tauri/tt-app/src/asset.rs`); this module only builds the URL.
 */

import { convertFileSrc } from "@tauri-apps/api/core";
import type { Result } from "better-result";
import { invoke, isTauri } from "@/lib/tauri";
import type { IpcError } from "@/lib/errors";

/** Must match `asset::SCHEME` in `crates-tauri/tt-app/src/asset.rs`. */
const ASSET_SCHEME = "ttasset";

/**
 * Schemes an `<img>`/`<a>` may keep verbatim. `http(s)` is the badge/remote-
 * screenshot case, which we deliberately allow (a README's shields.io row is
 * unreadable otherwise, and this is a local tool pointed at your own repos).
 * `data:` is inert and occasionally used for inline SVG icons. Everything else
 * — `file:`, `javascript:`, `vbscript:` — is refused rather than passed to the
 * DOM.
 */
const PASSTHROUGH_SCHEMES = new Set(["http", "https", "data", "mailto"]);

/** The scheme of a URL-ish string, lowercased, or null when it has none. */
function schemeOf(raw: string): string | null {
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(raw);
  return match ? match[1].toLowerCase() : null;
}

/** Everything before the last `/`, or `""` for a file at the repo root. */
export function dirOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? "" : path.slice(0, cut);
}

/**
 * Collapse `.`/`..` segments, returning null when the path climbs out of the
 * repo root. Mirrors `asset::resolve_within` on the Rust side — that one is
 * the authority (this one can't be trusted, it runs in the webview), but
 * resolving here too means a bad link renders as a broken image immediately
 * instead of after a round trip.
 */
function normalizeSegments(path: string): string | null {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.length > 0 ? out.join("/") : null;
}

/**
 * A document-relative target as a repo-relative path, or null when it escapes
 * the checkout or is empty.
 *
 * `fromPath` is the *file* the reference appears in, not its directory —
 * passing the directory is the mistake this signature exists to prevent, since
 * both are strings and the wrong one silently resolves one level too deep.
 *
 * Three shapes arrive here:
 * - `docs/x.png` — relative to `fromPath`'s directory, the common case.
 * - `/docs/x.png` — treated as repo-root-relative. GitHub resolves a leading
 *   slash against the *site*, which for a repo file is nearly always meant as
 *   the repo root anyway; resolving it against the checkout is the reading
 *   that makes such links work rather than 404.
 * - `docs/my%20image.png` — percent-encoded, because Markdown URLs are URLs.
 *   Decoded once here; a malformed escape is left as-is rather than throwing.
 */
export function resolveRepoPath(fromPath: string, target: string): string | null {
  // Query and fragment belong to the URL, not to the file — `?raw=true` is
  // the common one, copied out of a GitHub "copy image address".
  const bare = target.split(/[?#]/, 1)[0];
  if (bare === "") return null;
  let decoded = bare;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    // A stray `%` isn't an escape; the raw form is the better guess.
  }
  const joined = decoded.startsWith("/") ? decoded : `${dirOf(fromPath)}/${decoded}`;
  return normalizeSegments(joined);
}

/**
 * The URL an `<img src>` should use for `path` inside `dir`, or null outside
 * the Tauri shell (plain-Vite browser dev, where the protocol isn't
 * registered and the component shows a placeholder instead).
 *
 * `convertFileSrc` is called only for its base: it is the one thing that knows
 * a custom scheme is `ttasset://localhost/` on Linux and macOS but
 * `http://ttasset.localhost/` on Windows. The pair travels as query
 * parameters — see `asset::parse_request` for why that beats encoding an
 * absolute directory inside a URL path.
 *
 * Imported straight from `@tauri-apps/api` rather than through `lib/tauri.ts`
 * deliberately, and it is not a hole in the Result boundary: this is not IPC,
 * it is synchronous string building over `__TAURI_INTERNALS__`. Its only
 * failure is that object being absent, which is what the `isTauri()` guard
 * above already answers, so there is no error left for a `Result` to carry.
 */
export function assetUrl(dir: string, path: string): string | null {
  if (!isTauri()) return null;
  const base = convertFileSrc("", ASSET_SCHEME);
  return `${base}?dir=${encodeURIComponent(dir)}&path=${encodeURIComponent(path)}`;
}

/**
 * Register a checkout with the asset protocol, which serves nothing from a
 * folder that hasn't been (see `asset.rs`'s module doc — this is the guard
 * that keeps a hostile document's forged URL inside trees the user opened).
 *
 * Must resolve before the first `<img>` renders, so the preview awaits it
 * alongside its own read rather than firing it off.
 */
export function allowAssetDir(dir: string): Promise<Result<void, IpcError>> {
  return invoke<void>("asset_allow_dir", { dir });
}

/** Where an image's bytes come from. */
export type MarkdownSrc =
  /** A remote or inline URL, used exactly as written. */
  | { kind: "external"; url: string }
  /** A file in the checkout, at this repo-relative path. */
  | { kind: "repo"; path: string }
  /** Unusable — an unsupported scheme, or a path outside the checkout. */
  | { kind: "invalid" };

/**
 * Classify an image `src` found in the file at `fromPath`.
 *
 * Protocol-relative (`//host/x.png`) is promoted to `https:` rather than left
 * alone: the preview's own origin is `tauri:`/`http:` depending on the build,
 * so "same scheme as the page" is not a meaningful instruction here.
 */
export function resolveMarkdownSrc(fromPath: string, src: string): MarkdownSrc {
  const trimmed = src.trim();
  if (trimmed === "") return { kind: "invalid" };
  if (trimmed.startsWith("//")) return { kind: "external", url: `https:${trimmed}` };
  const scheme = schemeOf(trimmed);
  if (scheme !== null) {
    return PASSTHROUGH_SCHEMES.has(scheme)
      ? { kind: "external", url: trimmed }
      : { kind: "invalid" };
  }
  const path = resolveRepoPath(fromPath, trimmed);
  return path === null ? { kind: "invalid" } : { kind: "repo", path };
}
