/** What the Files pane should do with a file, answered from the extension, not
 * the bytes: `ide_read_file` refuses NUL, so a binary that reaches the read
 * silently never opens. An unlisted binary is harmless; a *text* one is not. */

export type PreviewKind = "markdown" | "html" | "image" | "video" | "binary";

const MARKDOWN = ["md", "markdown"];
const HTML = ["html", "htm"];

/** Must match `asset::mime_for`'s arms, or it is served as octet-stream. */
const IMAGE = ["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "bmp", "ico"];

const VIDEO = ["mp4", "webm", "mov"];

/** Known-unviewable. A wrong entry turns a real file into a refusal. */
const BINARY = [
  "pdf",
  "zip",
  "gz",
  "tgz",
  "bz2",
  "xz",
  "zst",
  "tar",
  "7z",
  "rar",
  "jar",
  "class",
  "wasm",
  "exe",
  "dll",
  "so",
  "dylib",
  "bin",
  "o",
  "a",
  "rlib",
  "icns",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "db",
  "sqlite",
  "sqlite3",
  "mp3",
  "wav",
  "flac",
  "ogg",
  "m4a",
];

const KINDS: readonly (readonly [PreviewKind, readonly string[]])[] = [
  ["markdown", MARKDOWN],
  ["html", HTML],
  ["image", IMAGE],
  ["video", VIDEO],
  ["binary", BINARY],
];

/** Lowercased extension, empty when there is none — a dotfile has none. */
function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function previewKindFor(path: string): PreviewKind | null {
  const ext = extensionOf(path);
  if (ext === "") return null;
  for (const [kind, extensions] of KINDS) {
    if (extensions.includes(ext)) return kind;
  }
  return null;
}

/** Whether the pane pairs this file with Monaco — read by `monaco-fs.ts` to
 * decide whether the bytes are worth fetching at all. */
export function opensInEditor(kind: PreviewKind | null): boolean {
  return kind === null || kind === "markdown" || kind === "html";
}
