/** Frontend half of the Claude Code IDE bridge (docs/CLAUDE-CODE-IDE.md): every
 * embedded terminal hosts an IDE server in Rust, and a selection in a folder's
 * viewer routes to the `claude` running in that folder's terminal. */

import { useEffect, useMemo, useState } from "react";
import type { Result } from "better-result";
import { toast } from "sonner";
import { invoke, isTauri } from "@/lib/tauri";
import { errorMessage, type IpcError } from "@/lib/errors";
import { formatMentionRef, type MentionRange, type StreamRange } from "@/lib/ide-selection";

export type IdeStatus = {
  termId: string;
  dir: string;
  port: number;
  connected: boolean;
};

const STATUS_EVENT = "ide://status";

export function useIdeConnected(dir: string | undefined): boolean {
  const [statuses, setStatuses] = useState<Record<string, IdeStatus>>({});

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const initial = await invoke<IdeStatus[]>("ide_status");
      if (disposed) return;
      if (initial.isOk()) setStatuses(Object.fromEntries(initial.value.map((s) => [s.termId, s])));
      if (!isTauri()) return;
      const { listen } = await import("@tauri-apps/api/event");
      const sub = await listen<IdeStatus>(STATUS_EVENT, (e) => {
        setStatuses((prev) => ({ ...prev, [e.payload.termId]: e.payload }));
      });
      if (disposed) sub();
      else unlisten = sub;
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return useMemo(
    () => !!dir && Object.values(statuses).some((s) => s.connected && s.dir === dir),
    [statuses, dir],
  );
}

/** Lines are 1-based inclusive, columns 0-based. `text` must come from the
 * **model** (`getValueInRange`), not the file — these buffers are editable and a
 * save may still be pending (#309) — and must be read synchronously with the
 * selection rather than inside the debounce, by when the model may be disposed. */
export function ideSetSelection(
  dir: string,
  filePath: string,
  range: StreamRange,
  text: string,
): Promise<Result<void, IpcError>> {
  return invoke<void>("ide_set_selection", { dir, filePath, range, text });
}

/** Surfaces in Claude's getOpenEditors / checkDocumentDirty. Several diff-pane
 * files can be dirty at once, so this upserts just this one path. */
export function ideSetDiffDirty(
  dir: string,
  filePath: string,
  dirty: boolean,
): Promise<Result<void, IpcError>> {
  return invoke<void>("ide_set_diff_dirty", { dir, filePath, dirty });
}

export type FileRead = { content: string; mtimeMs: number };

/** An `Err` means the path does not exist — what deleted-on-disk detection needs. */
export type FsStat = { isDir: boolean; size: number; mtimeMs: number };

export function ideStat(dir: string, filePath: string): Promise<Result<FsStat, IpcError>> {
  return invoke<FsStat>("ide_stat", { dir, filePath });
}

export function ideReadFile(dir: string, filePath: string): Promise<Result<FileRead, IpcError>> {
  return invoke<FileRead>("ide_read_file", { dir, filePath });
}

/** Atomic; refuses when the file changed on disk since `expectedMtimeMs`. */
export function ideWriteFile(
  dir: string,
  filePath: string,
  content: string,
  expectedMtimeMs: number | null,
): Promise<Result<number, IpcError>> {
  return invoke<number>("ide_write_file", { dir, filePath, content, expectedMtimeMs });
}

const FILE_CHANGED_EVENT = "ide://file-changed";

export type FilesChangedEvent = { dir: string; filePaths: string[] };

/** One call for the whole list — a 50-file diff pane must not pay 50 IPC
 * round-trips. Pair with `ideUnwatchFiles` over the same list on close. */
export function ideWatchFiles(dir: string, filePaths: string[]): Promise<Result<void, IpcError>> {
  return invoke<void>("ide_watch_files", { dir, filePaths });
}

export function ideUnwatchFiles(dir: string, filePaths: string[]): Promise<Result<void, IpcError>> {
  return invoke<void>("ide_unwatch_files", { dir, filePaths });
}

/** Returns an unsubscribe; a no-op outside Tauri. */
export function onFilesChangedOnDisk(dir: string, cb: (filePath: string) => void): () => void {
  if (!isTauri()) return () => {};
  let disposed = false;
  let unlisten: (() => void) | undefined;
  void (async () => {
    const { listen } = await import("@tauri-apps/api/event");
    const sub = await listen<FilesChangedEvent>(FILE_CHANGED_EVENT, (e) => {
      if (e.payload.dir !== dir) return;
      for (const filePath of e.payload.filePaths) cb(filePath);
    });
    if (disposed) sub();
    else unlisten = sub;
  })();
  return () => {
    disposed = true;
    unlisten?.();
  };
}

export function onFileChangedOnDisk(dir: string, filePath: string, cb: () => void): () => void {
  return onFilesChangedOnDisk(dir, (changed) => {
    if (changed === filePath) cb();
  });
}

/** Structural, not `ITextModel`, so this module needs no editor dependency. */
type SavableModel = { getValue(): string; getAlternativeVersionId(): number };

/** Captured synchronously so a serialized save chain can write it later, once
 * earlier writes finished — possibly after the model itself was disposed. */
export type BufferSnapshot = { value: string; versionAtSave: number };

export function snapshotModel(model: SavableModel): BufferSnapshot {
  return { value: model.getValue(), versionAtSave: model.getAlternativeVersionId() };
}

/** Callers must serialize saves per file — overlapping writes of one file race
 * each other's mtime tokens and one gets refused. The returned version, compared
 * against the model's current one, is how a caller learns it is still dirty. */
export async function saveBufferSnapshot(
  dir: string,
  filePath: string,
  snapshot: BufferSnapshot,
  expectedMtimeMs: number | null,
): Promise<{ mtimeMs: number; versionAtSave: number } | null> {
  const written = await ideWriteFile(dir, filePath, snapshot.value, expectedMtimeMs);
  if (written.isErr()) {
    toast.error(`Couldn't save ${filePath} — ${written.error.message}`);
    return null;
  }
  return { mtimeMs: written.value, versionAtSave: snapshot.versionAtSave };
}

/** Claude's `openFile` tool, intercepted in `ide.rs` and sent on as `ide://open-file`. */
export type OpenFileRequest = { dir: string; filePath: string };

export function ideClearSelection(dir: string, filePath: string): Promise<Result<void, IpcError>> {
  return invoke<void>("ide_clear_selection", { dir, filePath });
}

/** Omit the lines for a whole-file mention. Fails when no session is connected. */
export function ideAtMention(
  dir: string,
  filePath: string,
  startLine?: number,
  endLine?: number,
): Promise<Result<void, IpcError>> {
  return invoke<void>("ide_at_mention", {
    dir,
    filePath,
    startLine: startLine ?? null,
    endLine: endLine ?? null,
  });
}

/** `ideAtMention` plus its toasts, so every mention gesture reports the same way. */
export async function ideMention(
  dir: string,
  filePath: string,
  range: MentionRange | null,
): Promise<void> {
  const sent = await ideAtMention(dir, filePath, range?.startLine, range?.endLine);
  sent.match({
    ok: () => toast.success(`${formatMentionRef(filePath, range)} sent to claude`),
    err: (e) => toast.error(errorMessage(e)),
  });
}
