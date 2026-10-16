import { useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { FilesOpenRequest } from "@/components/files-pane";
import {
  browserPaneId,
  filesPaneId,
  filesPaneTarget,
  jarvisPaneId,
  previewPaneId,
} from "@/lib/agentboard/pane-ids";
import type { FolderData } from "@/lib/agentboard/types";
import { nextOpenFileNonce, type FocusLevel } from "@/lib/agentboard/windows";
import { codeServerOpenClaudeSession, codeServerRevealInExplorer } from "@/lib/code-server";
import { errorMessage, NotInTauri } from "@/lib/errors";
import type { OpenFileRequest } from "@/lib/ide";
import type { PreviewRequest } from "@/lib/preview-artifact";
import { invoke } from "@/lib/tauri";
import { toast } from "@/lib/toast";
import { uiAction } from "@/lib/ui-action";
import type { RailSnapshot } from "./selection-actions";
import { useTauriEvent } from "./use-tauri-event";

/** Files, preview, browser and Jarvis panes: the tiles that show a folder
 * rather than run a shell, and the requests that point them at something. */
export function useViewPanes(args: {
  folderByDir: Map<string, FolderData>;
  railRef: RefObject<RailSnapshot>;
  activeFolderDirRef: RefObject<string | null>;
  setActiveFolderDir: Dispatch<SetStateAction<string | null>>;
  setFocusedPaneId: Dispatch<SetStateAction<string | null>>;
  setFocusLevel: Dispatch<SetStateAction<FocusLevel>>;
  addPaneToActive: (folderDir: string, paneId: string) => void;
  ackFolder: (folderDir: string) => void;
}) {
  const {
    folderByDir,
    railRef,
    activeFolderDirRef,
    setActiveFolderDir,
    setFocusedPaneId,
    setFocusLevel,
    addPaneToActive,
    ackFolder,
  } = args;
  const [previewRequests, setPreviewRequests] = useState<Record<string, PreviewRequest>>({});
  // Claude's openFile tool → that folder's files pane, focused on the file.
  const [filesOpenRequests, setFilesOpenRequests] = useState<Record<string, FilesOpenRequest>>({});

  // View panes go beside the live terminals — never a modal.
  function placeViewPane(dir: string, paneId: string) {
    setActiveFolderDir(dir);
    addPaneToActive(dir, paneId);
    setFocusedPaneId(paneId);
    setFocusLevel("pane");
  }

  const openFiles = (dir: string) => placeViewPane(dir, filesPaneId(dir));
  const openPreview = (dir: string) => placeViewPane(dir, previewPaneId(dir));

  // Same, for the folder's Chrome pane — a real browser whose sign-ins stick.
  function openBrowser(dir: string) {
    uiAction("agentboard.open_browser_pane", "agentboard");
    setActiveFolderDir(dir);
    addPaneToActive(dir, browserPaneId(dir));
    setFocusedPaneId(browserPaneId(dir));
  }

  // Same, for the native pane — a window rectangle rendered by Bevy, not DOM.
  function openJarvis(dir: string) {
    uiAction("agentboard.open_jarvis_pane", "agentboard");
    placeViewPane(dir, jarvisPaneId(dir));
  }

  function showPreviewFile(req: {
    folderDir: string | null;
    path: string;
    title: string;
    nonce: number;
  }) {
    // A file in no tracked folder lands on whatever's on screen, else the first.
    const dir =
      req.folderDir ?? activeFolderDirRef.current ?? railRef.current.repos[0]?.folders[0]?.dir;
    if (!dir) {
      toast.error(`Couldn't show ${req.title} — no checkouts are open on the rail`);
      return;
    }
    setPreviewRequests((prev) => ({
      ...prev,
      [dir]: { path: req.path, title: req.title, nonce: req.nonce },
    }));
    // Ack where the file landed, not what the payload named.
    ackFolder(dir);
    openPreview(dir);
  }

  function focusFiles(dir: string) {
    setActiveFolderDir(dir);
    ackFolder(dir);
    openFiles(dir);
  }

  // The MCP `file_open` tool / `tt open`. Shares `showPreviewFile`'s fallback
  // folder; a file outside it still opens in that folder's workbench, which is
  // not confined to the tree it has open.
  function openFileFromRequest(req: {
    folderDir: string | null;
    path: string;
    isDir: boolean;
    line: number | null;
    nonce: number;
  }) {
    const dir =
      req.folderDir ?? activeFolderDirRef.current ?? railRef.current.repos[0]?.folders[0]?.dir;
    if (!dir) {
      toast.error(`Couldn't open ${req.path} — no checkouts are open on the rail`);
      return;
    }
    // A directory: the tree is already rooted there, nothing to select.
    if (!req.isDir) {
      const target = filesPaneTarget(dir, req.path);
      if (target == null) {
        toast.error(`Couldn't open ${req.path} — it names no file this app can reach`);
        return;
      }
      setFilesOpenRequests((prev) => ({
        ...prev,
        [dir]: { path: target, line: req.line, nonce: req.nonce },
      }));
    }
    focusFiles(dir);
  }

  // The extension resumes from the transcripts filed under its workspace folder,
  // so the session's cwd has to *be* a checkout on the rail, not sit inside one.
  async function openClaudeSessionInEditor(dir: string, sessionId: string) {
    if (!railRef.current.folderNameByDir.has(dir)) {
      toast.error(`Couldn't open the session in the editor — ${dir} isn't a checkout on the rail`);
      return;
    }
    focusFiles(dir);
    const opened = await codeServerOpenClaudeSession(dir, sessionId);
    if (opened.isErr()) {
      toast.error(`Couldn't open the session in the editor — ${opened.error.message}`);
    }
  }

  useTauriEvent<OpenFileRequest>("ide://open-file", (p) => {
    const dir = p.dir;
    if (!folderByDir.has(dir)) return;
    const target = filesPaneTarget(dir, p.filePath);
    if (target == null) return;
    setFilesOpenRequests((prev) => ({
      ...prev,
      [dir]: { path: target, line: null, nonce: nextOpenFileNonce() },
    }));
    openFiles(dir);
  });

  // A terminal file link takes the same files-pane route, wherever on disk it
  // points. The backend resolves first (`term_resolve_path`) because a relative
  // link is only folder-relative until the pane's shell `cd`s elsewhere, and
  // because it is what expands a `~`. Only a link that resolves to nothing at
  // all falls through to the external editor.
  async function openTerminalPath(dir: string, termId: string, path: string, line: number | null) {
    uiAction("terminal.link_open_file", "agentboard");
    const resolved = (
      await invoke<string | null>("term_resolve_path", { path, cwd: dir, termId })
    ).unwrapOr(null);
    const target = filesPaneTarget(dir, resolved ?? path);
    if (target == null) {
      void invoke("term_open_path", { path, cwd: dir, line, termId });
      return;
    }
    setFilesOpenRequests((prev) => ({
      ...prev,
      [dir]: { path: target, line, nonce: nextOpenFileNonce() },
    }));
    openFiles(dir);
  }

  // "Open folder in files": the link's folder in the workbench's Explorer, the
  // link selected. One outside the checkout has no Explorer row to land on, so
  // it goes to the OS file manager instead.
  async function revealTerminalPath(dir: string, termId: string, path: string) {
    uiAction("terminal.link_reveal_in_files", "agentboard");
    const resolved = (
      await invoke<string | null>("term_resolve_path", { path, cwd: dir, termId })
    ).unwrapOr(null);
    const target = resolved && filesPaneTarget(dir, resolved);
    if (target == null || target.startsWith("/")) {
      void invoke("term_reveal_path", { path, cwd: dir, termId });
      return;
    }
    openFiles(dir);
    const revealed = await codeServerRevealInExplorer(dir, target);
    if (revealed.isErr() && !NotInTauri.is(revealed.error)) {
      toast.error(`Couldn't show ${target} in files — ${errorMessage(revealed.error)}`);
    }
  }

  return {
    previewRequests,
    filesOpenRequests,
    openFiles,
    openPreview,
    openBrowser,
    openJarvis,
    showPreviewFile,
    openFileFromRequest,
    openClaudeSessionInEditor,
    openTerminalPath,
    revealTerminalPath,
  };
}
