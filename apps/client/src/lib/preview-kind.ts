/**
 * What the Files pane should do with a file, by extension.
 *
 * Three groups, and the distinction that matters is **whether Monaco can hold
 * the file at all**:
 *
 * - `markdown`/`html` have a code side. The pane shows the editor and a
 *   rendered preview, and the toolbar switches between them.
 * - `image`/`video` have no code side. The pane renders the file itself, from
 *   the `ttasset` protocol, with no editor mounted.
 * - `binary` is neither viewable nor editable — an archive, a font, a
 *   database. The pane says so.
 *
 * Anything else is `null`: an ordinary text file, straight into the editor.
 *
 * ## Why an extension list rather than sniffing the bytes
 *
 * This has to be answered *before* anything is read, because the read is what
 * fails. Opening a file in the Explorer resolves a text model first
 * (`lib/monaco.ts`'s views fallback), which goes through `ide_read_file`,
 * which refuses anything containing a NUL. The rejection means the fallback
 * never runs, so the pane's open handler never fires and clicking a PNG in the
 * Explorer did nothing whatsoever — no error, no change, the previously-open
 * file still on screen. `lib/monaco-fs.ts` consults this module to short-
 * circuit that read, and it can only do so from the path.
 *
 * The list is therefore allowed to be incomplete: an unlisted binary
 * extension still fails the old silent way, which is no worse than before.
 * It must never contain a *text* extension, though — that would send a real
 * source file to the "can't display this" card.
 */

/** Extensions the file viewer treats as something other than editable text. */
export type PreviewKind = "markdown" | "html" | "image" | "video" | "binary";

const MARKDOWN = ["md", "markdown"];
const HTML = ["html", "htm"];

/** Matches `asset::mime_for`'s image arms — a format listed here but not
 * there is served as `application/octet-stream` and won't render. */
const IMAGE = ["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "bmp", "ico"];

/** Likewise the video arms. WebKitGTK's codec support is narrower than this
 * list on some systems; an unplayable file shows the element's own error
 * rather than a broken pane. */
const VIDEO = ["mp4", "webm", "mov"];

/**
 * Known-unviewable formats. Deliberately conservative — every entry here is
 * something no one would expect to edit as text, because a wrong entry turns
 * a real file into a refusal. PDF is included: WebKitGTK has no built-in
 * viewer, so rendering one would mean vendoring pdf.js.
 */
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
  // The app's own bundle icon — a format WebKit can't show and no one edits.
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

/** The extension of a path, lowercased — empty for a file that has none.
 *
 * A dotfile with no extension (`.gitignore`) must not read as one: splitting
 * on `.` alone would call it `gitignore` and match nothing, which is right by
 * accident today but wrong the moment a `.db`-like name is added. */
function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** How the pane should present `path`, or null for ordinary text. */
export function previewKindFor(path: string): PreviewKind | null {
  const ext = extensionOf(path);
  if (ext === "") return null;
  for (const [kind, extensions] of KINDS) {
    if (extensions.includes(ext)) return kind;
  }
  return null;
}

/**
 * Whether the pane pairs this file with the Monaco editor.
 *
 * True for text and for the two kinds that have a source side; false for the
 * kinds Monaco cannot hold. `lib/monaco-fs.ts` reads this to decide whether a
 * file's bytes are worth fetching, and `FilesPane` to decide whether to mount
 * an editor at all.
 */
export function opensInEditor(kind: PreviewKind | null): boolean {
  return kind === null || kind === "markdown" || kind === "html";
}
