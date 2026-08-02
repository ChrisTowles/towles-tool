import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { loadMonaco } from "@/lib/monaco";
import { applyLanguageFallback } from "@/lib/language-fallback";
import {
  ideClearSelection,
  ideMention,
  ideReadFile,
  ideSetOpenFile,
  ideSetSelection,
  ideStat,
  ideUnwatchFiles,
  ideWatchFiles,
  onFileChangedOnDisk,
  saveBufferSnapshot,
  snapshotModel,
  type FileRead,
} from "@/lib/ide";
import { AUTOSAVE_DELAY_MS, diskChangeAction } from "@/lib/viewer-refresh";
import {
  clampEditorFontSize,
  DEFAULT_EDITOR_FONT_SIZE,
  useEditorFontSize,
} from "@/lib/editor-prefs";
import { recallViewState, rememberViewState, viewStateKey } from "@/lib/editor-view-state";
import { NotInTauri, errorMessage } from "@/lib/errors";
import { uiAction } from "@/lib/ui-action";
import { IdeSelectionOverlay } from "@/components/ide-selection-chip";
import { EditorContextMenu } from "@/components/editor-context-menu";
import { ViewerBanner } from "@/components/viewer-banner";
import {
  mentionRangeFrom,
  sameMentionRange,
  streamRangeFrom,
  type MentionRange,
} from "@/lib/ide-selection";

/** Monaco editor for one repo file. Opens **read-only** (the pane header's
 * toggle arms typing) and auto-saves after a typing pause; a write is refused
 * if the file moved on disk — `lib/viewer-refresh.ts` decides the banner. */

/** Text anchors from Claude's openFile tool, or a bare line from a `path:line`
 * terminal link; text anchors win when both are set. */
export type ViewerAnchor = {
  startText?: string | null;
  endText?: string | null;
  selectToEndOfLine?: boolean | null;
  line?: number | null;
};

/** Whether an anchor points anywhere — a request may carry none at all. */
export function isAnchored(anchor: ViewerAnchor | undefined): boolean {
  return Boolean(anchor?.startText) || anchor?.line != null;
}

function applyViewerAnchor(
  monaco: typeof import("monaco-editor"),
  editor: import("monaco-editor").editor.IStandaloneCodeEditor,
  anchor: ViewerAnchor,
) {
  const model = editor.getModel();
  if (!model) return;
  if (!anchor.startText) {
    if (anchor.line == null) return;
    const line = Math.max(1, Math.min(anchor.line, model.getLineCount()));
    editor.setPosition({ lineNumber: line, column: 1 });
    editor.revealLineInCenter(line);
    editor.focus();
    return;
  }
  const start = model.findMatches(anchor.startText, false, false, false, null, false, 1)[0];
  if (!start) return;
  let range = start.range;
  if (anchor.endText) {
    const after = model.findMatches(anchor.endText, false, false, false, null, false, 50);
    const end = after.find(
      (m) =>
        m.range.startLineNumber > range.startLineNumber ||
        (m.range.startLineNumber === range.startLineNumber &&
          m.range.startColumn >= range.endColumn),
    );
    if (end) {
      range = new monaco.Range(
        range.startLineNumber,
        range.startColumn,
        end.range.endLineNumber,
        end.range.endColumn,
      );
    }
  }
  if (anchor.selectToEndOfLine) {
    range = new monaco.Range(
      range.startLineNumber,
      range.startColumn,
      range.endLineNumber,
      model.getLineMaxColumn(range.endLineNumber),
    );
  }
  editor.setSelection(range);
  editor.revealRangeInCenter(range);
  editor.focus();
}

export function CodeViewer({
  dir,
  path,
  anchor,
  wordWrap = true,
  editable = false,
  connected = false,
  onDirtyChange,
}: {
  dir: string;
  path: string;
  /** Changes identity per openFile request so re-anchoring re-runs. */
  anchor?: ViewerAnchor & { nonce?: number };
  wordWrap?: boolean;
  /** Only the *editor* is locked: disk reloads and conflict resolution still
   * write the model, being programmatic edits `readOnly` doesn't block. */
  editable?: boolean;
  connected?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selection, setSelection] = useState<MentionRange | null>(null);
  /** "conflict" = disk changed under unsaved edits, "deleted" = file gone and
   * the buffer is all that's left (⌘S recreates it). Mutually exclusive. */
  const [banner, setBannerState] = useState<"none" | "conflict" | "deleted">("none");
  const editorRef = useRef<import("monaco-editor").editor.IStandaloneCodeEditor | null>(null);
  const resolveConflictRef = useRef<((choice: "theirs" | "mine") => Promise<void>) | null>(null);
  const savedVersionRef = useRef(0);
  const mtimeRef = useRef<number | null>(null);
  const dirtyRef = useRef(false);
  const onDirtyRef = useRef(onDirtyChange);
  onDirtyRef.current = onDirtyChange;
  const wordWrapRef = useRef(wordWrap);
  wordWrapRef.current = wordWrap;
  const [fontSize, setFontSize] = useEditorFontSize();
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;
  const setFontSizeRef = useRef(setFontSize);
  setFontSizeRef.current = setFontSize;
  // A mode change must not rebuild the editor (undo stack, scroll).
  const editableRef = useRef(editable);
  editableRef.current = editable;
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;

  /** Read live from the editor, not the debounced chip state — never stale. */
  const mention = useCallback(async () => {
    const editor = editorRef.current;
    if (!editor) return;
    await ideMention(dir, path, mentionRangeFrom(editor.getSelection()));
  }, [dir, path]);

  useEffect(() => {
    let disposed = false;
    let editor: import("monaco-editor").editor.IStandaloneCodeEditor | undefined;
    let model: import("monaco-editor").editor.ITextModel | undefined;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let streamed = false;
    let applyingDisk = false;
    let offDiskChange: (() => void) | undefined;
    let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
    /** Closure mirror — the autosave deadline fires outside React. */
    let bannerNow: "none" | "conflict" | "deleted" = "none";
    let flushSave: (() => void) | undefined;

    setError(null);
    setLoading(true);
    setSelection(null);
    setBannerState("none");
    dirtyRef.current = false;
    void (async () => {
      let read: FileRead;
      try {
        const [, r] = await Promise.all([loadMonaco(), ideReadFile(dir, path)]);
        if (r.isErr()) {
          if (!disposed) {
            setError(NotInTauri.is(r.error) ? "not available in browser dev" : r.error.message);
            setLoading(false);
          }
          return;
        }
        read = r.value;
      } catch (e) {
        if (!disposed) {
          setError(errorMessage(e));
          setLoading(false);
        }
        return;
      }
      if (disposed || !containerRef.current) return;
      const monaco = await loadMonaco();
      const uri = monaco.Uri.file(`${dir}/${path}`);
      monaco.editor.getModel(uri)?.dispose();
      model = monaco.editor.createModel(read.content, undefined, uri);
      applyLanguageFallback(monaco, model, path);
      mtimeRef.current = read.mtimeMs;
      editor = monaco.editor.create(containerRef.current, {
        model,
        automaticLayout: true,
        minimap: { enabled: false },
        fontSize: fontSizeRef.current,
        lineNumbersMinChars: 4,
        scrollBeyondLastLine: false,
        renderLineHighlight: "line",
        occurrencesHighlight: "off",
        contextmenu: false,
        wordWrap: wordWrapRef.current ? "on" : "off",
        readOnly: !editableRef.current,
      });
      editorRef.current = editor;
      savedVersionRef.current = model.getAlternativeVersionId();
      setLoading(false);
      const remembered = recallViewState(viewStateKey(dir, path));
      if (remembered) {
        editor.restoreViewState(remembered as import("monaco-editor").editor.ICodeEditorViewState);
      }
      // The open request usually lands before the editor exists.
      if (anchorRef.current) applyViewerAnchor(monaco, editor, anchorRef.current);
      ideSetOpenFile(dir, path, false);

      const setDirty = (dirty: boolean) => {
        if (dirtyRef.current === dirty) return;
        dirtyRef.current = dirty;
        ideSetOpenFile(dir, path, dirty);
        onDirtyRef.current?.(dirty);
      };

      // A pending autosave would only bounce off the save's mtime guard.
      const setBanner = (value: "none" | "conflict" | "deleted") => {
        bannerNow = value;
        if (value !== "none") clearTimeout(autosaveTimer);
        setBannerState(value);
      };

      // The one save path — ⌘S, autosave, "keep mine", the cleanup flush.
      // Serialized: overlapping writes race each other's mtime tokens.
      let saveChain: Promise<void> = Promise.resolve();
      const save = () => {
        if (!model || model.isDisposed()) return saveChain;
        clearTimeout(autosaveTimer);
        const snapshot = snapshotModel(model);
        saveChain = saveChain.then(async () => {
          const result = await saveBufferSnapshot(dir, path, snapshot, mtimeRef.current);
          if (!result) return;
          // A disposed model means this generation is dead (the unmount flush
          // racing the next mount); the bookkeeping is that mount's to redo.
          if (!model || model.isDisposed()) return;
          mtimeRef.current = result.mtimeMs;
          savedVersionRef.current = result.versionAtSave;
          setDirty(model.getAlternativeVersionId() !== result.versionAtSave);
          setBanner("none");
        });
        return saveChain;
      };
      flushSave = () => {
        if (dirtyRef.current && bannerNow === "none") void save();
      };

      /** Re-checked at fire time: clean buffer, or a banner the user owns. */
      const scheduleAutosave = () => {
        clearTimeout(autosaveTimer);
        autosaveTimer = setTimeout(() => {
          if (disposed || !model || model.isDisposed()) return;
          if (bannerNow !== "none") return;
          if (model.getAlternativeVersionId() === savedVersionRef.current) return;
          void save();
        }, AUTOSAVE_DELAY_MS);
      };

      model.onDidChangeContent(() => {
        if (applyingDisk) return;
        setDirty(model!.getAlternativeVersionId() !== savedVersionRef.current);
        scheduleAutosave();
      });

      /** In place, so cursor/scroll and undo survive; a touch costs nothing. */
      const applyDisk = (disk: FileRead) => {
        if (!editor || !model || model.isDisposed()) return;
        if (model.getValue() !== disk.content) {
          const viewState = editor.saveViewState();
          applyingDisk = true;
          model.pushEditOperations(
            [],
            [{ range: model.getFullModelRange(), text: disk.content }],
            () => null,
          );
          applyingDisk = false;
          if (viewState) editor.restoreViewState(viewState);
        }
        mtimeRef.current = disk.mtimeMs;
        savedVersionRef.current = model.getAlternativeVersionId();
        setDirty(false);
        setBanner("none");
      };

      // Stat-first: most events here are the echo of our own save.
      const onDiskChange = async () => {
        const stat = await ideStat(dir, path);
        if (disposed || !model || model.isDisposed()) return;
        if (stat.isErr()) {
          if (NotInTauri.is(stat.error)) return;
          // Gone — keep the buffer as the sole copy and null the token so ⌘S
          // recreates it. Dirty is left alone: a clean buffer adopts what returns.
          mtimeRef.current = null;
          setBanner("deleted");
          return;
        }
        if (stat.value.mtimeMs === mtimeRef.current) return;
        const reread = await ideReadFile(dir, path);
        // A failed read after a good stat (mid-rename, binary) keeps the buffer.
        if (disposed || reread.isErr() || !model || model.isDisposed()) return;
        const action = diskChangeAction({
          dirty: dirtyRef.current,
          bufferMtimeMs: mtimeRef.current,
          diskMtimeMs: reread.value.mtimeMs,
        });
        if (action === "reload") applyDisk(reread.value);
        else if (action === "conflict") setBanner("conflict");
      };

      resolveConflictRef.current = async (choice) => {
        if (choice === "theirs") {
          const reread = await ideReadFile(dir, path);
          if (disposed || !model || model.isDisposed()) return;
          if (reread.isErr()) {
            toast.error(`Couldn't reload ${path} — ${reread.error.message}`);
            return;
          }
          applyDisk(reread.value);
        } else {
          // Keep mine: re-arm the token to the current disk state (null once
          // the file vanished, so the save recreates it) and overwrite now.
          const stat = await ideStat(dir, path);
          if (disposed || !model || model.isDisposed()) return;
          mtimeRef.current = stat.isOk() ? stat.value.mtimeMs : null;
          setBanner("none");
          await save();
        }
      };

      void ideWatchFiles(dir, [path]).then((started) => {
        // Catch-up for an edit between the initial read and the watch start.
        if (started.isOk() && !disposed) void onDiskChange();
      });
      offDiskChange = onFileChangedOnDisk(dir, path, () => void onDiskChange());

      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void save());

      editor.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyA,
        () => void mention(),
      );

      const zoomTo = (px: number) => {
        const clamped = clampEditorFontSize(px);
        setFontSizeRef.current(clamped);
        uiAction("editor.font_size", "agentboard", String(clamped));
      };
      for (const [key, delta] of [
        [monaco.KeyCode.Equal, 1],
        [monaco.KeyCode.NumpadAdd, 1],
        [monaco.KeyCode.Minus, -1],
        [monaco.KeyCode.NumpadSubtract, -1],
      ] as const) {
        editor.addCommand(monaco.KeyMod.CtrlCmd | key, () => zoomTo(fontSizeRef.current + delta));
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | key, () =>
          zoomTo(fontSizeRef.current + delta),
        );
      }
      for (const key of [monaco.KeyCode.Digit0, monaco.KeyCode.Numpad0] as const) {
        editor.addCommand(monaco.KeyMod.CtrlCmd | key, () => zoomTo(DEFAULT_EDITOR_FONT_SIZE));
      }

      editor.onDidChangeCursorSelection((e) => {
        const next = mentionRangeFrom(e.selection);
        setSelection((prev) => (sameMentionRange(prev, next) ? prev : next));
        // Read the text off the model *now*: the backend can't recover it from
        // disk, and 300ms later a file switch may have disposed the model.
        const sel = e.selection;
        const text =
          sel.isEmpty() || !model || model.isDisposed() ? "" : model.getValueInRange(sel);
        clearTimeout(debounce);
        debounce = setTimeout(() => {
          if (sel.isEmpty()) {
            ideClearSelection(dir, path);
            streamed = false;
            return;
          }
          streamed = true;
          ideSetSelection(dir, path, streamRangeFrom(sel), text);
        }, 300);
      });
    })();

    return () => {
      disposed = true;
      clearTimeout(debounce);
      clearTimeout(autosaveTimer);
      // Flush before the model dies: switching files must not eat the last
      // second of typing. Conflicted/deleted skipped — neither side has won.
      flushSave?.();
      offDiskChange?.();
      const leaving = editor?.saveViewState();
      if (leaving) rememberViewState(viewStateKey(dir, path), leaving);
      void ideUnwatchFiles(dir, [path]);
      resolveConflictRef.current = null;
      editorRef.current = null;
      editor?.dispose();
      model?.dispose();
      // A closed file's selection must not stay the folder's ambient context.
      if (streamed) ideClearSelection(dir, path);
      ideSetOpenFile(dir, null);
    };
  }, [dir, path, mention]);

  useEffect(() => {
    editorRef.current?.updateOptions({ wordWrap: wordWrap ? "on" : "off" });
  }, [wordWrap]);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly: !editable });
  }, [editable]);

  useEffect(() => {
    editorRef.current?.updateOptions({ fontSize });
  }, [fontSize]);

  // The mount effect covers fresh-open, where this runs before the editor.
  useEffect(() => {
    // Field by field, not `isAnchored`: the deps below are those same fields.
    if (!anchor?.startText && anchor?.line == null) return;
    void (async () => {
      const monaco = await loadMonaco();
      const editor = editorRef.current;
      if (!editor) return;
      applyViewerAnchor(monaco, editor, {
        startText: anchor?.startText,
        endText: anchor?.endText,
        selectToEndOfLine: anchor?.selectToEndOfLine,
        line: anchor?.line,
      });
    })();
  }, [anchor?.nonce, anchor?.startText, anchor?.endText, anchor?.selectToEndOfLine, anchor?.line]);

  if (error) {
    return <p className="p-3 text-sm text-muted-foreground">{error}</p>;
  }
  return (
    <div className="relative h-full w-full">
      {loading && <p className="absolute p-3 text-sm text-muted-foreground">Loading…</p>}
      {banner === "deleted" && (
        <ViewerBanner message="Deleted on disk — this buffer is all that's left · ⌘S recreates the file" />
      )}
      {banner === "conflict" && (
        <ViewerBanner
          message="Changed on disk while you have unsaved edits"
          onTheirs={() => void resolveConflictRef.current?.("theirs")}
          onMine={() => void resolveConflictRef.current?.("mine")}
        />
      )}
      <EditorContextMenu where="files.editor">
        <div ref={containerRef} className="h-full w-full" />
      </EditorContextMenu>
      <IdeSelectionOverlay
        selection={selection}
        connected={connected}
        loading={loading}
        onSend={() => void mention()}
      />
    </div>
  );
}
