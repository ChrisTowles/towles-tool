import { convertFileSrc } from "@tauri-apps/api/core";
import type { Result } from "better-result";
import { invoke, isTauri } from "@/lib/tauri";
import type { IpcError } from "@/lib/errors";

/** Must match `asset::SCHEME` in `crates-tauri/tt-app/src/asset.rs`. */
const ASSET_SCHEME = "ttasset";

/** Remote badges are deliberately allowed — a README's shields.io row is
 * unreadable otherwise. Anything not listed is refused, never passed to the DOM. */
const PASSTHROUGH_SCHEMES = new Set(["http", "https", "data", "mailto"]);

function schemeOf(raw: string): string | null {
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(raw);
  return match ? match[1].toLowerCase() : null;
}

export function dirOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? "" : path.slice(0, cut);
}

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

/** `fromPath` is the *file* the reference appears in, not its directory — both
 * are strings, and the wrong one silently resolves a level too deep. A leading
 * slash is read as repo-root-relative, which is what such links nearly mean. */
export function resolveRepoPath(fromPath: string, target: string): string | null {
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

/** `convertFileSrc` is called only for its base — the one thing that knows a
 * custom scheme is `http://ttasset.localhost/` on Windows. Not a hole in the
 * Result boundary: it is string building over `__TAURI_INTERNALS__`, not IPC,
 * and its only failure is the absence `isTauri()` already answers. */
export function assetUrl(dir: string, path: string): string | null {
  if (!isTauri()) return null;
  const base = convertFileSrc("", ASSET_SCHEME);
  return `${base}?dir=${encodeURIComponent(dir)}&path=${encodeURIComponent(path)}`;
}

/** The protocol serves nothing from an unregistered folder, so this must resolve
 * before the first `<img>` renders — the preview awaits it, never fires it off. */
export function allowAssetDir(dir: string): Promise<Result<void, IpcError>> {
  return invoke<void>("asset_allow_dir", { dir });
}

export type MarkdownSrc =
  | { kind: "external"; url: string }
  | { kind: "repo"; path: string }
  | { kind: "invalid" };

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
