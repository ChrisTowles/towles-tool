/** A `file://` overlay provider answering stat/readdir/readFile and the
 * Explorer's mutations over Tauri IPC. `monaco-vscode-files-service-override` is
 * deliberately NOT a direct dependency: declaring it pre-bundles a *second* copy
 * of the files service, and quick-open then reports "No matching results". */

import {
  FileChangeType,
  FileSystemProviderCapabilities,
  FileSystemProviderError,
  FileSystemProviderErrorCode,
  FileType,
  registerFileSystemOverlay,
  type IFileChange,
  type IFileDeleteOptions,
  type IFileOverwriteOptions,
  type IFileWriteOptions,
  type IFileSystemProviderWithFileReadWriteCapability,
  type IStat,
} from "@codingame/monaco-vscode-files-service-override";
import { Emitter, Event } from "@codingame/monaco-vscode-api/vscode/vs/base/common/event";
import { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import { Disposable } from "@codingame/monaco-vscode-api/vscode/vs/base/common/lifecycle";
import { invoke } from "@/lib/tauri";
import { errorMessage } from "@/lib/errors";
import { ideStat, ideUnwatchDir, ideWatchDir, onDirChangedOnDisk, type FsStat } from "@/lib/ide";
import { opensInEditor, previewKindFor } from "@/lib/preview-kind";

type FsDirEntry = { name: string; isDir: boolean };

function notFound(): FileSystemProviderError {
  return FileSystemProviderError.create("file not found", FileSystemProviderErrorCode.FileNotFound);
}

/** Fatal decoding on purpose: `ide_write_file` takes a Rust `String`, so a
 * lossy decode would write mojibake over a binary file and report success. */
function decodeText(content: Uint8Array, filePath: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw FileSystemProviderError.create(
      `${filePath} is not valid UTF-8 — the editor bridge only writes text files`,
      FileSystemProviderErrorCode.Unknown,
    );
  }
}

class TauriFileSystemProvider
  extends Disposable
  implements IFileSystemProviderWithFileReadWriteCapability
{
  // No `Readonly` bit, deliberately: `OverlayFileSystemProvider` skips any
  // delegate carrying it in `writeToDelegates`, so every mutation below dies.
  capabilities =
    FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.PathCaseSensitive;
  onDidChangeCapabilities = Event.None;
  private readonly _onDidChangeFile = this._register(new Emitter<readonly IFileChange[]>());
  onDidChangeFile = this._onDidChangeFile.event;

  private changed(...changes: IFileChange[]): void {
    this._onDidChangeFile.fire(changes);
  }

  /** Disk-side changes from the Rust tree watcher (`watchWorkspaceForExplorer`)
   * — the workbench can't call `watch()` itself with no files service part. */
  fireExternalChanges(changes: IFileChange[]): void {
    this._onDidChangeFile.fire(changes);
  }

  private async statOrNull(filePath: string): Promise<FsStat | null> {
    const stat = await ideStat("/", filePath);
    return stat.unwrapOr(null);
  }

  async stat(resource: URI): Promise<IStat> {
    const s = await this.statOrNull(resource.path.slice(1));
    if (s == null) throw notFound();
    return {
      type: s.isDir ? FileType.Directory : FileType.File,
      ctime: s.mtimeMs,
      mtime: s.mtimeMs,
      size: s.size,
    };
  }

  async readdir(resource: URI): Promise<[string, FileType][]> {
    const entries = await invoke<FsDirEntry[]>("ide_read_dir", {
      dir: "/",
      filePath: resource.path.slice(1),
    });
    if (entries.isErr()) throw notFound();
    return entries.value.map((e) => [e.name, e.isDir ? FileType.Directory : FileType.File]);
  }

  /** Files the pane renders itself resolve as an empty model, which exists only
   * to carry a URI to `lib/monaco.ts`'s views fallback. `ide_read_file` refuses
   * a NUL-containing file, so without this a PNG click did nothing at all. */
  async readFile(resource: URI): Promise<Uint8Array> {
    const filePath = resource.path.slice(1);
    if (!opensInEditor(previewKindFor(filePath))) return new Uint8Array();
    const read = await invoke<{ content: string }>("ide_read_file", {
      dir: "/",
      filePath,
    });
    if (read.isErr()) throw notFound();
    return new TextEncoder().encode(read.value.content);
  }

  /** The workbench's own save path; the code viewer instead calls
   * `ide_write_file` directly, keeping the mtime token that refuses to clobber
   * an agent's edit. `create`/`overwrite` are enforced here rather than trusted
   * to the caller, since the provider contract is what the next one relies on. */
  async writeFile(resource: URI, content: Uint8Array, opts: IFileWriteOptions): Promise<void> {
    const filePath = resource.path.slice(1);
    const text = decodeText(content, filePath);
    // Counterpart to `readFile`'s empty model: a pane-rendered file is zero
    // bytes here, so a save reaching this provider would truncate the real
    // image. Scoped to files that exist — the danger is truncation, not
    // creation, and an Explorer "New File" named `icon.png` is legitimate.
    const writingBinary = !opensInEditor(previewKindFor(filePath));
    if (writingBinary || !opts.create || !opts.overwrite) {
      const existing = await this.statOrNull(filePath);
      if (existing != null && writingBinary) {
        throw FileSystemProviderError.create(
          `${filePath} is not an editable text file`,
          FileSystemProviderErrorCode.NoPermissions,
        );
      }
      if (existing != null && !opts.overwrite) {
        throw FileSystemProviderError.create(
          `${filePath} already exists`,
          FileSystemProviderErrorCode.FileExists,
        );
      }
      if (existing == null && !opts.create) throw notFound();
    }
    await this.run("ide_write_file", {
      dir: "/",
      filePath,
      content: text,
      expectedMtimeMs: null,
    });
    this.changed({
      type: opts.overwrite ? FileChangeType.UPDATED : FileChangeType.ADDED,
      resource,
    });
  }

  watch() {
    return Disposable.None;
  }

  async mkdir(resource: URI): Promise<void> {
    await this.run("ide_create_dir", {
      dir: "/",
      filePath: resource.path.slice(1),
    });
    this.changed({ type: FileChangeType.ADDED, resource });
  }

  /** Always trashes, ignoring `opts.useTrash`: `OverlayFileSystemProvider` drops
   * the `Trash` bit, so the file service always asks for a permanent delete.
   * Registering directly with `registerCustomProvider` would surface it but
   * breaks quick-open, and a checkout is full of files git can't bring back. */
  async delete(resource: URI, opts: IFileDeleteOptions): Promise<void> {
    await this.run("ide_delete", {
      dir: "/",
      filePath: resource.path.slice(1),
      recursive: opts.recursive,
      useTrash: true,
    });
    this.changed({ type: FileChangeType.DELETED, resource });
  }

  async rename(from: URI, to: URI, opts: IFileOverwriteOptions): Promise<void> {
    await this.run("ide_rename", {
      dir: "/",
      fromPath: from.path.slice(1),
      toPath: to.path.slice(1),
      overwrite: opts.overwrite,
    });
    this.changed(
      { type: FileChangeType.DELETED, resource: from },
      { type: FileChangeType.ADDED, resource: to },
    );
  }

  private async run(cmd: string, args: Record<string, unknown>): Promise<void> {
    const ran = await invoke(cmd, args);
    if (ran.isErr()) {
      const message = errorMessage(ran.error);
      throw FileSystemProviderError.create(message, errorCodeFor(message));
    }
  }
}

/** VS Code offers an overwrite prompt on `FileExists` and gives up on `Unknown`,
 * so these substrings are a contract, pinned in `ide.rs` by a test. */
const ERROR_CODES: readonly (readonly [string, FileSystemProviderErrorCode])[] = [
  ["already exists", FileSystemProviderErrorCode.FileExists],
  ["escapes the folder", FileSystemProviderErrorCode.NoPermissions],
];

function errorCodeFor(message: string): FileSystemProviderErrorCode {
  return (
    ERROR_CODES.find(([needle]) => message.includes(needle))?.[1] ??
    FileSystemProviderErrorCode.Unknown
  );
}

let provider: TauriFileSystemProvider | null = null;

/** Call once, after the services initialize. See `delete` for why an overlay. */
export function registerTauriFileSystem(): void {
  provider = new TauriFileSystemProvider();
  registerFileSystemOverlay(1, provider);
}

/** Feed the Rust recursive watcher's batches into the provider's change event,
 * so the Explorer refreshes for files agents create — `setMonacoWorkspace`
 * holds one of these for the active workspace. Returns the unwatch. */
export function watchWorkspaceForExplorer(dir: string): () => void {
  void ideWatchDir(dir);
  const off = onDirChangedOnDisk(dir, (changes) => {
    if (!provider) return;
    provider.fireExternalChanges(
      changes.map((c) => ({
        type: c.kind === "deleted" ? FileChangeType.DELETED : FileChangeType.ADDED,
        resource: URI.file(`${dir}/${c.path}`),
      })),
    );
  });
  return () => {
    off();
    void ideUnwatchDir(dir);
  };
}
