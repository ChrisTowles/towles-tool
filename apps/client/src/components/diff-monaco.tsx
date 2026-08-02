import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useEditorFontSize } from "@/lib/editor-prefs";
import { loadMonaco } from "@/lib/monaco";
import { applyLanguageFallback } from "@/lib/language-fallback";
import { invoke } from "@/lib/tauri";
import { errorMessage } from "@/lib/errors";
import {
  ideClearSelection,
  ideMention,
  ideReadFile,
  ideSetDiffDirty,
  ideSetSelection,
  ideStat,
  ideUnwatchFiles,
  ideWatchFiles,
  onFilesChangedOnDisk,
  saveBufferSnapshot,
  snapshotModel,
} from "@/lib/ide";
import { AUTOSAVE_DELAY_MS, diskChangeAction } from "@/lib/viewer-refresh";
import { IdeSelectionOverlay } from "@/components/ide-selection-chip";
import { EditorContextMenu } from "@/components/editor-context-menu";
import { ViewerBanner } from "@/components/viewer-banner";
import {
  diffWorkPath,
  mentionRangeFrom,
  sameMentionRange,
  streamRangeFrom,
  type MentionRange,
} from "@/lib/ide-selection";

export type ChangedFile = {
  path: string;
  oldPath: string | null;
  /** Git name-status letter (M/A/D/R/C/T), or "?" for untracked. */
  status: string;
  linesAdded: number;
  linesRemoved: number;
  /** Files under a collapsed `?` row: it is a directory, not a file. */
  untrackedFiles: number;
};

export type ChangedFiles = {
  files: ChangedFile[];
  untrackedCap: { dir: string; files: number; total: boolean } | null;
};

type Widget =
  import("@codingame/monaco-vscode-api/vscode/vs/editor/browser/widget/multiDiffEditor/multiDiffEditorWidget").MultiDiffEditorWidget;
type ViewModel =
  import("@codingame/monaco-vscode-api/vscode/vs/editor/browser/widget/multiDiffEditor/multiDiffEditorViewModel").MultiDiffEditorViewModel;
type DocItem =
  import("@codingame/monaco-vscode-api/vscode/vs/editor/browser/widget/multiDiffEditor/multiDiffEditorViewModel").DocumentDiffItemViewModel;
type TextModel = import("monaco-editor").editor.ITextModel;

/** Base sides are read-only history; working-tree sides take typing once
 * `editable` is on and autosave after a pause — unless conflicted, where the
 * banner is the only way out. */
export function MonacoMultiDiff({
  dir,
  files,
  mode,
  baseBranch,
  refreshKey,
  baseKey,
  editable,
  connected = false,
  registerReveal,
  reviewed,
  onToggleReviewed,
  onDirtyChange,
  onConflictChange,
}: {
  dir: string;
  files: ChangedFile[];
  mode: string;
  baseBranch: string | null;
  refreshKey: string;
  /** Moves only when the *baseline* can have, so a keystroke-driven stats bump
   * doesn't refetch every read-only base side. */
  baseKey: string;
  editable: boolean;
  connected?: boolean;
  registerReveal?: (reveal: ((path: string) => void) | null) => void;
  reviewed: ReadonlySet<string>;
  onToggleReviewed?: (path: string) => void;
  onDirtyChange?: (path: string, dirty: boolean) => void;
  onConflictChange?: (path: string, conflict: boolean) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** Mirrored in `conflictsRef`: state can't answer "already marked?" mid-callback. */
  const [conflicts, setConflictsState] = useState<ReadonlySet<string>>(() => new Set());
  const conflictsRef = useRef<Set<string>>(new Set());
  /** A disk reload, not typing — the saved-version token lags the edit. */
  const applyingDiskRef = useRef(false);
  const autosaveTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const saveChainsRef = useRef<Map<string, Promise<void>>>(new Map());
  /** Held across a rebuild: agent-triggered disposal isn't the user's choice. */
  const conflictCarryRef = useRef<Map<string, string>>(new Map());
  /** Stamped as of the fetch's *start*, so a baseline that moves mid-fetch re-fires. */
  const appliedBaseKeyRef = useRef<string | null>(null);
  const [selection, setSelection] = useState<{ path: string; range: MentionRange } | null>(null);
  const mentionRef = useRef<() => void>(() => {});
  const widgetRef = useRef<Widget | null>(null);
  const viewModelRef = useRef<ViewModel | null>(null);
  const itemsByPathRef = useRef<Map<string, DocItem> | null>(null);
  const checkboxesByPathRef = useRef<Map<string, HTMLInputElement>>(new Map());
  const modelsRef = useRef<Map<string, { original?: TextModel; modified?: TextModel }>>(new Map());
  // As of the last save: "unsaved edits?" and the next `expectedMtimeMs`.
  const mtimesRef = useRef<Map<string, number | null>>(new Map());
  const savedVersionsRef = useRef<Map<string, number>>(new Map());
  // What the IDE bridge was told is dirty, so teardown clears exactly that.
  const dirtyReportedRef = useRef<Set<string>>(new Set());
  // "Latest ref": the header checkboxes close over these once, at construction.
  const onToggleReviewedRef = useRef(onToggleReviewed);
  onToggleReviewedRef.current = onToggleReviewed;
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  const onConflictChangeRef = useRef(onConflictChange);
  onConflictChangeRef.current = onConflictChange;
  // `setUri` fires on row reuse, after the construction closure went stale.
  const reviewedRef = useRef(reviewed);
  reviewedRef.current = reviewed;
  // Read via each item's getter: a rebuild would lose the scroll position.
  const editableRef = useRef(editable);
  editableRef.current = editable;
  const [fontSize] = useEditorFontSize();
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;
  const optionsChangedRef = useRef<{ fire(): void } | null>(null);

  const applyReviewedState = (
    currentFiles: ChangedFile[],
    currentReviewed: ReadonlySet<string>,
  ) => {
    const viewModel = viewModelRef.current;
    const itemsByPath = itemsByPathRef.current;
    if (!viewModel || !itemsByPath) return;
    for (const f of currentFiles) {
      const isReviewed = currentReviewed.has(f.path);
      const item = itemsByPath.get(f.path);
      if (item) {
        if (isReviewed) viewModel.collapse(item);
        else viewModel.expand(item);
      }
      const checkbox = checkboxesByPathRef.current.get(f.path);
      if (checkbox) checkbox.checked = isReviewed;
    }
  };

  // Only on a real flip, so Claude's getOpenEditors sees this pane like Files.
  const reportDirty = (path: string, model: TextModel) => {
    const isDirty = model.getAlternativeVersionId() !== savedVersionsRef.current.get(path);
    const wasDirty = dirtyReportedRef.current.has(path);
    if (isDirty === wasDirty) return;
    if (isDirty) dirtyReportedRef.current.add(path);
    else dirtyReportedRef.current.delete(path);
    void ideSetDiffDirty(dir, path, isDirty);
    onDirtyChangeRef.current?.(path, isDirty);
  };

  const cancelAutosave = (path: string) => {
    const timer = autosaveTimersRef.current.get(path);
    if (timer !== undefined) {
      clearTimeout(timer);
      autosaveTimersRef.current.delete(path);
    }
  };

  /** The one save path. The buffer is snapshotted now, but the write queues
   * behind any in-flight save of the same path: they race their mtime tokens. */
  const saveFile = (path: string, model: TextModel): Promise<void> => {
    if (model.isDisposed()) return Promise.resolve();
    cancelAutosave(path);
    const snapshot = snapshotModel(model);
    const chain = (saveChainsRef.current.get(path) ?? Promise.resolve()).then(async () => {
      const result = await saveBufferSnapshot(
        dir,
        path,
        snapshot,
        mtimesRef.current.get(path) ?? null,
      );
      if (!result) return;
      // A disposed model means these maps belong to the next generation, which
      // read their own token — the write landed, but stamping it here would lie.
      if (model.isDisposed()) return;
      mtimesRef.current.set(path, result.mtimeMs);
      savedVersionsRef.current.set(path, result.versionAtSave);
      reportDirty(path, model);
    });
    saveChainsRef.current.set(path, chain);
    return chain;
  };

  /** Re-checked at fire time: a clean buffer has nothing to save, a conflicted one must not. */
  const scheduleAutosave = (path: string, model: TextModel) => {
    cancelAutosave(path);
    autosaveTimersRef.current.set(
      path,
      setTimeout(() => {
        autosaveTimersRef.current.delete(path);
        if (model.isDisposed() || conflictsRef.current.has(path)) return;
        if (model.getAlternativeVersionId() === savedVersionsRef.current.get(path)) return;
        void saveFile(path, model);
      }, AUTOSAVE_DELAY_MS),
    );
  };

  // Entering a conflict kills the autosave, which the mtime guard would bounce.
  const setConflict = (path: string, inConflict: boolean) => {
    if (conflictsRef.current.has(path) === inConflict) return;
    if (inConflict) {
      conflictsRef.current.add(path);
      cancelAutosave(path);
    } else {
      conflictsRef.current.delete(path);
    }
    setConflictsState(new Set(conflictsRef.current));
    onConflictChangeRef.current?.(path, inConflict);
  };

  /** `pushEditOperations`, not `setValue`, so an agent's edit stays undoable. */
  const applyDisk = (path: string, model: TextModel, content: string, mtimeMs: number | null) => {
    if (model.getValue() !== content) {
      applyingDiskRef.current = true;
      model.pushEditOperations(
        [],
        [{ range: model.getFullModelRange(), text: content }],
        () => null,
      );
      applyingDiskRef.current = false;
    }
    mtimesRef.current.set(path, mtimeMs);
    savedVersionsRef.current.set(path, model.getAlternativeVersionId());
    setConflict(path, false);
    reportDirty(path, model);
  };

  // Stat-first: the commonest event is the echo of our own save.
  const onDiskChange = async (path: string) => {
    const model = modelsRef.current.get(path)?.modified;
    if (!model || model.isDisposed()) return;
    const stat = await ideStat(dir, path);
    // A failed stat is a deletion, which the file list resolves on its own.
    if (stat.isErr() || model.isDisposed()) return;
    if (stat.value.mtimeMs === (mtimesRef.current.get(path) ?? null)) return;
    const read = await ideReadFile(dir, path);
    if (read.isErr() || model.isDisposed() || modelsRef.current.get(path)?.modified !== model) {
      return;
    }
    const action = diskChangeAction({
      dirty: model.getAlternativeVersionId() !== savedVersionsRef.current.get(path),
      bufferMtimeMs: mtimesRef.current.get(path) ?? null,
      diskMtimeMs: read.value.mtimeMs,
    });
    if (action === "reload") applyDisk(path, model, read.value.content, read.value.mtimeMs);
    else if (action === "conflict") setConflict(path, true);
  };

  // Every conflicted file at once — too rare to deserve a second UI. "Mine"
  // re-arms the mtime token first, or the save hits its own conflict guard.
  const resolveConflicts = async (choice: "theirs" | "mine") => {
    const conflicted = Array.from(conflictsRef.current);
    for (const path of conflicted) {
      const model = modelsRef.current.get(path)?.modified;
      if (!model || model.isDisposed()) {
        setConflict(path, false);
        continue;
      }
      if (choice === "theirs") {
        const read = await ideReadFile(dir, path);
        if (read.isErr()) {
          toast.error(`Couldn't reload ${path} — ${read.error.message}`);
          continue;
        }
        applyDisk(path, model, read.value.content, read.value.mtimeMs);
      } else {
        const stat = await ideStat(dir, path);
        mtimesRef.current.set(path, stat.isOk() ? stat.value.mtimeMs : null);
        setConflict(path, false);
        await saveFile(path, model);
      }
    }
  };

  // Stable across refetches of the same set, so content alone never rebuilds.
  const filesKey = files.map((f) => `${f.status}:${f.path}`).join("\n");

  useEffect(() => {
    let disposed = false;
    const disposables: Array<{ dispose(): void }> = [];
    let streamedPath: string | null = null;

    setError(null);
    setLoading(true);
    void (async () => {
      try {
        const [monaco, api, widgetMod, eventMod, utilsMod, domMod] = await Promise.all([
          loadMonaco(),
          import("@codingame/monaco-vscode-api"),
          import("@codingame/monaco-vscode-api/vscode/vs/editor/browser/widget/multiDiffEditor/multiDiffEditorWidget"),
          import("@codingame/monaco-vscode-api/vscode/vs/base/common/event"),
          import("@codingame/monaco-vscode-api/vscode/vs/editor/browser/widget/diffEditor/utils"),
          import("@codingame/monaco-vscode-api/vscode/vs/base/browser/dom"),
        ]);
        const contents = await Promise.all(files.map((f) => fetchSides(dir, f, mode, baseBranch)));
        if (disposed || !containerRef.current) return;

        const optionsChanged = new eventMod.Emitter<void>();
        disposables.push(optionsChanged);
        optionsChangedRef.current = optionsChanged;

        const models = new Map<string, { original?: TextModel; modified?: TextModel }>();
        mtimesRef.current = new Map();
        savedVersionsRef.current = new Map();
        const items = files.map((f, i) => {
          const baseUri = monaco.Uri.parse(`tt-diff-base:${dir}/${f.oldPath ?? f.path}`);
          const workUri = monaco.Uri.parse(`tt-diff-work:${dir}/${f.path}`);
          monaco.editor.getModel(baseUri)?.dispose();
          monaco.editor.getModel(workUri)?.dispose();
          const entry: { original?: TextModel; modified?: TextModel } = {};
          if (contents[i].original != null) {
            entry.original = monaco.editor.createModel(contents[i].original!, undefined, baseUri);
            applyLanguageFallback(monaco, entry.original, f.oldPath ?? f.path);
          }
          if (contents[i].modified != null) {
            entry.modified = monaco.editor.createModel(contents[i].modified!, undefined, workUri);
            applyLanguageFallback(monaco, entry.modified, f.path);
            mtimesRef.current.set(f.path, contents[i].modifiedMtimeMs);
            savedVersionsRef.current.set(f.path, entry.modified.getAlternativeVersionId());
            disposables.push(
              entry.modified.onDidChangeContent(() => {
                // A disk reload must neither flap dirty nor arm an autosave.
                if (applyingDiskRef.current) return;
                reportDirty(f.path, entry.modified!);
                scheduleAutosave(f.path, entry.modified!);
              }),
            );
          }
          models.set(f.path, entry);
          return {
            original: entry.original,
            modified: entry.modified,
            // A getter, so `onOptionsDidChange` flips read-only without a
            // rebuild. Leave the tt-diff-work: URI console error alone — a
            // provider to quiet it blanks the pane on a disposal race.
            get options() {
              return {
                readOnly: !editableRef.current,
                originalEditable: false,
                wordWrap: "on" as const,
                fontSize: fontSizeRef.current,
              };
            },
            onOptionsDidChange: optionsChanged.event,
          };
        });
        modelsRef.current = models;
        appliedBaseKeyRef.current = baseKey;

        // Re-raise the previous generation's banner; a caught-up carry drops.
        for (const [path, carried] of conflictCarryRef.current) {
          const restored = models.get(path)?.modified;
          if (!restored || restored.isDisposed() || restored.getValue() === carried) continue;
          applyingDiskRef.current = true;
          restored.pushEditOperations(
            [],
            [{ range: restored.getFullModelRange(), text: carried }],
            () => null,
          );
          applyingDiskRef.current = false;
          reportDirty(path, restored);
          setConflict(path, true);
        }
        conflictCarryRef.current = new Map();

        // After the models exist, so no event races a half-built map; the sweep
        // catches a write between the reads and the watch going live.
        const watchedPaths = files.filter((f) => models.get(f.path)?.modified).map((f) => f.path);
        void ideWatchFiles(dir, watchedPaths).then((started) => {
          if (started.isErr() || disposed) return;
          for (const path of watchedPaths) void onDiskChange(path);
        });
        const offDiskChanges = onFilesChangedOnDisk(dir, (path) => void onDiskChange(path));
        disposables.push({
          dispose: () => {
            offDiskChanges();
            void ideUnwatchFiles(dir, watchedPaths);
          },
        });

        const widget = api.createInstanceSync(
          widgetMod.MultiDiffEditorWidget,
          containerRef.current,
          {
            headerClickToCollapse: true,
            createResourceLabel: (element: HTMLElement) => {
              // Twice per file on a rename; only the "modified" one gets a box.
              if (!element.classList.contains("modified")) {
                return {
                  setUri(uri: { path: string } | undefined) {
                    element.textContent = uri ? uri.path.replace(`${dir}/`, "") : "";
                  },
                  dispose() {},
                };
              }
              const checkbox = document.createElement("input");
              checkbox.type = "checkbox";
              checkbox.className = "mr-1.5 size-3 shrink-0 cursor-pointer accent-emerald-500";
              checkbox.title = "mark reviewed (collapses this file's diff)";
              checkbox.addEventListener("click", (e) => e.stopPropagation());
              const text = document.createElement("span");
              element.replaceChildren(checkbox, text);
              let path: string | null = null;
              checkbox.addEventListener("change", () => {
                if (!path) return;
                onToggleReviewedRef.current?.(path);
              });
              return {
                setUri(uri: { path: string } | undefined) {
                  if (path) checkboxesByPathRef.current.delete(path);
                  path = uri ? uri.path.replace(`${dir}/`, "") : null;
                  text.textContent = path ?? "";
                  checkbox.style.visibility = path ? "visible" : "hidden";
                  if (path) {
                    checkboxesByPathRef.current.set(path, checkbox);
                    checkbox.checked = reviewedRef.current.has(path);
                  }
                },
                dispose() {
                  if (path && checkboxesByPathRef.current.get(path) === checkbox) {
                    checkboxesByPathRef.current.delete(path);
                  }
                },
              };
            },
          },
        );
        widgetRef.current = widget;
        disposables.push(widget);

        const store = { dispose() {} };
        const viewModel = widget.createViewModel({
          documents: new eventMod.ValueWithChangeEvent(
            items.map((item) => utilsMod.RefCounted.createOfNonDisposable(item, store)),
          ),
        });
        disposables.push(viewModel);
        widget.setViewModel(viewModel);
        viewModelRef.current = viewModel;

        void viewModel.waitForDiffOr1s().then(() => {
          if (disposed) return;
          const itemsByPath = new Map<string, DocItem>();
          for (const item of viewModel.items.get()) {
            const p = (item.modifiedUri ?? item.originalUri)?.path.replace(`${dir}/`, "");
            if (p) itemsByPath.set(p, item);
          }
          itemsByPathRef.current = itemsByPath;
          applyReviewedState(files, reviewedRef.current);
        });

        const layout = () => {
          const el = containerRef.current;
          if (el && el.clientWidth > 0 && el.clientHeight > 0) {
            widget.layout(new domMod.Dimension(el.clientWidth, el.clientHeight));
          }
        };
        layout();
        const observer = new ResizeObserver(layout);
        observer.observe(containerRef.current);
        disposables.push({ dispose: () => observer.disconnect() });

        const wired = new WeakSet<object>();
        const wire = () => {
          const control = widget.getActiveControl();
          if (!control || wired.has(control)) return;
          wired.add(control);
          const modified = control.getModifiedEditor();
          let debounce: ReturnType<typeof setTimeout> | undefined;
          disposables.push({ dispose: () => clearTimeout(debounce) });

          // Read live, so the keystroke can't fire against a stale range.
          const mention = async () => {
            const path = diffWorkPath(dir, modified.getModel()?.uri);
            if (!path) return;
            await ideMention(dir, path, mentionRangeFrom(modified.getSelection()));
          };
          const sendFromThisEditor = () => void mention();

          const save = async () => {
            const model = modified.getModel();
            const path = diffWorkPath(dir, model?.uri);
            if (!model || !path) return;
            await saveFile(path, model);
          };

          // Plain ICodeEditors, not standalone ones: no addCommand.
          disposables.push(
            modified.onKeyDown((e: import("monaco-editor").IKeyboardEvent) => {
              if (!(e.ctrlKey || e.metaKey)) return;
              const action =
                e.keyCode === monaco.KeyCode.KeyA && e.shiftKey
                  ? mention
                  : e.keyCode === monaco.KeyCode.KeyS && !e.shiftKey
                    ? save
                    : null;
              if (!action) return;
              e.preventDefault();
              e.stopPropagation();
              void action();
            }),
          );

          disposables.push(
            modified.onDidChangeCursorSelection(
              (e: import("monaco-editor").editor.ICursorSelectionChangedEvent) => {
                const path = diffWorkPath(dir, modified.getModel()?.uri);
                if (!path) {
                  // Or the chip keeps `@ send`-ing the previous file.
                  setSelection(null);
                  return;
                }
                const next = mentionRangeFrom(e.selection);
                mentionRef.current = sendFromThisEditor;
                setSelection((prev) => {
                  if (!next) return null;
                  if (prev?.path === path && sameMentionRange(prev.range, next)) return prev;
                  return { path, range: next };
                });
                // Read now: the backend can't recover an editable side from disk.
                const sel = e.selection;
                const text = sel.isEmpty() ? "" : (modified.getModel()?.getValueInRange(sel) ?? "");
                clearTimeout(debounce);
                debounce = setTimeout(() => {
                  if (sel.isEmpty()) {
                    ideClearSelection(dir, path);
                    if (streamedPath === path) streamedPath = null;
                    return;
                  }
                  streamedPath = path;
                  ideSetSelection(dir, path, streamRangeFrom(sel), text);
                }, 300);
              },
            ),
          );
        };
        disposables.push(widget.onDidChangeActiveControl(wire));
        wire();

        registerReveal?.((path) => {
          const entry = modelsRef.current.get(path);
          if (!entry) return;
          try {
            widget.reveal(
              { original: entry.original?.uri, modified: entry.modified?.uri },
              { highlight: true },
            );
          } catch {
            // Not in the view (set changed under us) — the rebuild catches up.
          }
        });
        disposables.push({ dispose: () => registerReveal?.(null) });

        setLoading(false);
      } catch (e) {
        if (!disposed) {
          setError(errorMessage(e));
          setLoading(false);
        }
      }
    })();

    return () => {
      disposed = true;
      // Flush before the models die, off the dirty set rather than the timers —
      // a refused save has no timer and needs this most. Conflicts are stashed.
      for (const timer of autosaveTimersRef.current.values()) clearTimeout(timer);
      autosaveTimersRef.current = new Map();
      for (const path of dirtyReportedRef.current) {
        const model = modelsRef.current.get(path)?.modified;
        if (!model || model.isDisposed()) continue;
        if (conflictsRef.current.has(path)) conflictCarryRef.current.set(path, model.getValue());
        else void saveFile(path, model);
      }
      widgetRef.current = null;
      viewModelRef.current = null;
      optionsChangedRef.current = null;
      itemsByPathRef.current = null;
      checkboxesByPathRef.current = new Map();
      for (const d of disposables.toReversed()) d.dispose();
      for (const entry of modelsRef.current.values()) {
        entry.original?.dispose();
        entry.modified?.dispose();
      }
      modelsRef.current = new Map();
      mtimesRef.current = new Map();
      savedVersionsRef.current = new Map();
      for (const path of dirtyReportedRef.current) {
        void ideSetDiffDirty(dir, path, false);
        onDirtyChangeRef.current?.(path, false);
      }
      dirtyReportedRef.current = new Set();
      for (const path of conflictsRef.current) onConflictChangeRef.current?.(path, false);
      conflictsRef.current = new Set();
      setConflictsState(new Set());
      mentionRef.current = () => {};
      setSelection(null);
      if (streamedPath != null) ideClearSelection(dir, streamedPath);
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- filesKey stands in for files; refreshKey/reviewed apply in place below; registerReveal is an unmemoized prop excluded on purpose
  }, [dir, filesKey, mode, baseBranch]);

  useEffect(() => {
    applyReviewedState(files, reviewed);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- files is read fresh via closure; only reviewed's change should re-run this
  }, [reviewed]);

  useEffect(() => {
    optionsChangedRef.current?.fire();
  }, [editable, fontSize]);

  // Refetch the base sides in place; the build already fetched this baseKey.
  useEffect(() => {
    if (!widgetRef.current || appliedBaseKeyRef.current === baseKey) return;
    appliedBaseKeyRef.current = baseKey;
    const models = modelsRef.current;
    void Promise.all(
      files.map(async (f) => {
        const original = models.get(f.path)?.original;
        if (!original) return;
        const content = await fetchBase(dir, f, mode, baseBranch);
        if (models !== modelsRef.current || original.isDisposed()) return;
        if (content != null && original.getValue() !== content) original.setValue(content);
      }),
    );
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- dir/mode/baseBranch/files are read from the closure at call time; only baseKey should refetch
  }, [baseKey]);

  // The net behind the watch, for inotify limits and a failed start.
  useEffect(() => {
    if (!widgetRef.current) return;
    for (const f of files) void onDiskChange(f.path);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- files is read from the closure at call time; only refreshKey should re-scan
  }, [refreshKey]);

  if (error) {
    return <p className="p-3 text-sm text-muted-foreground">{error}</p>;
  }
  return (
    <div className="relative h-full w-full">
      {loading && <p className="absolute p-3 text-sm text-muted-foreground">Loading…</p>}
      {conflicts.size > 0 && (
        <ViewerBanner
          message={
            conflicts.size === 1
              ? `${[...conflicts][0]} changed on disk while you have unsaved edits`
              : `${conflicts.size} files changed on disk while you have unsaved edits`
          }
          theirsTitle="Discard those buffers and load the files as they are on disk"
          mineTitle="Keep those buffers — overwrite the disk with them now"
          onTheirs={() => void resolveConflicts("theirs")}
          onMine={() => void resolveConflicts("mine")}
        />
      )}
      <EditorContextMenu where="diff.editor">
        <div ref={containerRef} className="h-full w-full" />
      </EditorContextMenu>
      <IdeSelectionOverlay
        selection={selection?.range ?? null}
        label={selection?.path}
        connected={connected}
        loading={loading}
        onSend={() => mentionRef.current()}
      />
    </div>
  );
}

/** Null when the file has no base side (added/untracked) or the fetch failed. */
async function fetchBase(
  dir: string,
  file: ChangedFile,
  mode: string,
  baseBranch: string | null,
): Promise<string | null> {
  if (file.status === "A" || file.status === "?") return null;
  const content = await invoke<string | null>("ab_get_base_file", {
    dir,
    mode,
    baseBranch,
    path: file.oldPath ?? file.path,
  });
  return content.unwrapOr(null);
}

/** Both sides, plus the working-tree read's mtime token (the save path's
 * `expectedMtimeMs`). `undefined` means the file has no side there. */
async function fetchSides(
  dir: string,
  file: ChangedFile,
  mode: string,
  baseBranch: string | null,
): Promise<{
  original: string | undefined;
  modified: string | undefined;
  modifiedMtimeMs: number | null;
}> {
  const added = file.status === "A" || file.status === "?";
  const [original, read] = await Promise.all([
    fetchBase(dir, file, mode, baseBranch),
    file.status === "D" ? null : ideReadFile(dir, file.path),
  ]);
  return {
    original: added ? undefined : (original ?? ""),
    modified: file.status === "D" ? undefined : (read?.map((f) => f.content).unwrapOr("") ?? ""),
    modifiedMtimeMs: read?.map((f) => f.mtimeMs).unwrapOr(null) ?? null,
  };
}
