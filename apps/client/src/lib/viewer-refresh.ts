/** What the code viewer does when its open file changes on disk
 * (`ide://file-changed`), kept pure so it's testable without Monaco. The mtime
 * compare is the own-save suppressor: ⌘S fires the watcher too, but the
 * buffer's token already matches disk, so the echo can't start a reload loop. */

/** How long typing must pause before an editable buffer auto-saves. A file in
 * conflict never auto-saves, and neither does a deleted-on-disk one — ⌘S stays
 * the deliberate act for both. */
export const AUTOSAVE_DELAY_MS = 1000;

export type DiskChangeAction =
  /** Disk matches what the buffer already knows (our own save's echo). */
  | "ignore"
  /** Clean buffer — take the disk content silently, in place. */
  | "reload"
  /** Unsaved edits — never clobber either side silently; raise the banner. */
  | "conflict";

export function diskChangeAction(opts: {
  /** The buffer has edits not yet saved to disk. */
  dirty: boolean;
  /** The mtime token from the buffer's last read/save, if known. */
  bufferMtimeMs: number | null;
  /** The mtime just re-read from disk. */
  diskMtimeMs: number;
}): DiskChangeAction {
  if (opts.bufferMtimeMs !== null && opts.diskMtimeMs === opts.bufferMtimeMs) return "ignore";
  return opts.dirty ? "conflict" : "reload";
}
