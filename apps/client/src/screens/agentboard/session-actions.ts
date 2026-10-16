import type { Dispatch, SetStateAction } from "react";
import type { SessionActions, StartClaudeTarget } from "@/lib/agentboard/actions";
import { OVERLAY_STARTED, OVERLAY_STOPPED, type Overlay } from "@/lib/agentboard/overlays";
import { sleep, termWriteRetry } from "@/lib/agentboard/pty";
import type { WindowsPayload } from "@/lib/agentboard/types";
import type { FocusLevel } from "@/lib/agentboard/windows";
import type { LaunchConfigStatus } from "@/lib/launch";
import { openNoteDialog } from "@/lib/inbox";
import { mouseAction } from "@/lib/shortcut-coach";
import { toast } from "@/lib/toast";

/** The per-session verbs the rail rows, pane chrome and working-context band
 * all call, so they cannot drift apart. */
export function sessionActions(a: {
  wins: WindowsPayload | null;
  setOverlay: (sessionId: string, overlay: Overlay) => void;
  selectSession: (folderDir: string, sessionId: string) => void;
  selectFolder: (folderDir: string) => void;
  setStartClaudeTarget: Dispatch<SetStateAction<StartClaudeTarget | null>>;
  setRenaming: Dispatch<SetStateAction<string | null>>;
  setFocusLevel: Dispatch<SetStateAction<FocusLevel>>;
  withLiveSession: (sessionId: string, fn: () => Promise<unknown>) => Promise<void>;
  closeSession: (sessionId: string) => Promise<void>;
  launchDevServer: (folderDir: string, cfg: LaunchConfigStatus) => Promise<void>;
  updateWins: (folderDirs: string[], fn: (w: WindowsPayload) => WindowsPayload) => void;
}): SessionActions {
  return {
    startClaude: (folderDir, s) => {
      a.selectSession(folderDir, s.id);
      a.setStartClaudeTarget({
        folderDir,
        sessionId: s.id,
        sessionName: s.name,
        restart: false,
      });
    },
    stopClaude: (s) => {
      a.setOverlay(s.id, OVERLAY_STOPPED);
      toast(`■ interrupting Claude — ${s.name}'s shell stays alive`);
      void a.withLiveSession(s.id, async () => {
        await termWriteRetry(s.id, "\x03"); // interrupt the current turn
        await sleep(150);
        await termWriteRetry(s.id, "\x04"); // Ctrl-D at the empty prompt exits Claude
      });
    },
    compactClaude: (s) => {
      a.setOverlay(s.id, OVERLAY_STARTED);
      toast(`⤿ compacting ${s.name} — summarize & drop stale turns`);
      void a.withLiveSession(s.id, () => termWriteRetry(s.id, "/compact\r"));
    },
    noteAgent: (s) => {
      mouseAction("ab-note-agent", "agentboard");
      openNoteDialog({ sessionId: s.id, label: s.name });
    },
    restartClaude: (folderDir, s) => {
      a.selectSession(folderDir, s.id);
      a.setStartClaudeTarget({
        folderDir,
        sessionId: s.id,
        sessionName: s.name,
        restart: true,
      });
    },
    close: (sessionId) => void a.closeSession(sessionId),
    renameStart: a.setRenaming,
    launchDevServer: (folderDir, cfg) => void a.launchDevServer(folderDir, cfg),
    focusSession: a.selectSession,
    focusWindow: (windowId) => {
      const win = a.wins?.windows.find((w) => w.id === windowId);
      if (!win) return;
      a.selectFolder(win.folderDir);
      a.setFocusLevel("window");
      a.updateWins([win.folderDir], (w) => ({
        ...w,
        activeWindows: { ...w.activeWindows, [win.folderDir]: windowId },
      }));
    },
  };
}
