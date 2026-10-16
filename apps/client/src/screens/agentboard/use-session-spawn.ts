import { useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { StartClaudeTarget } from "@/lib/agentboard/actions";
import { claudeCommand, type ClaudeLaunchOptions } from "@/lib/agentboard/claude-command";
import { abSetSessionPurpose } from "@/lib/agentboard/ipc";
import { OVERLAY_STARTED, type Overlay } from "@/lib/agentboard/overlays";
import { sleep, termWriteRetry, waitForFirstFrame } from "@/lib/agentboard/pty";
import type { FolderData, RepoData, SessionData, WindowsPayload } from "@/lib/agentboard/types";
import { nextWindowId, type FocusLevel } from "@/lib/agentboard/windows";
import { errorMessage, NotInTauri } from "@/lib/errors";
import { launchCommand, launchRegister, type LaunchConfigStatus } from "@/lib/launch";
import { invoke } from "@/lib/tauri";
import { toast } from "@/lib/toast";
import { uiAction } from "@/lib/ui-action";

export type FocusTerminalRequest = { id: string; nonce: number };

/** Starting shells and Claude in them: new sessions, windows, dev servers, and
 * the typed-into-the-PTY launch path they all share. */
export function useSessionSpawn(args: {
  folderOf: Map<string, FolderData>;
  cwds: RefObject<Record<string, string>>;
  collapsed: Record<string, boolean>;
  selectSession: (folderDir: string, sessionId: string) => void;
  setOverlay: (sessionId: string, overlay: Overlay) => void;
  applyCollapse: (changes: { key: string; collapsed: boolean }[]) => void;
  setFocusLevel: Dispatch<SetStateAction<FocusLevel>>;
  setFocusTerminalRequest: Dispatch<SetStateAction<FocusTerminalRequest | null>>;
  updateWins: (folderDirs: string[], fn: (w: WindowsPayload) => WindowsPayload) => void;
}) {
  const {
    folderOf,
    cwds,
    collapsed,
    selectSession,
    setOverlay,
    applyCollapse,
    setFocusLevel,
    setFocusTerminalRequest,
    updateWins,
  } = args;
  const [startClaudeTarget, setStartClaudeTarget] = useState<StartClaudeTarget | null>(null);
  const [startClaudePrompt, setStartClaudePrompt] = useState("");

  /** Run `fn` against a session's PTY, guaranteeing its shell exists first. */
  async function withLiveSession(
    sessionId: string,
    fn: () => Promise<unknown>,
    folderDir?: string,
  ) {
    const dir = folderDir ?? folderOf.get(sessionId)?.dir ?? cwds.current[sessionId];
    if (!dir) return;
    selectSession(dir, sessionId);
    await waitForFirstFrame(sessionId);
    await fn();
  }

  async function newSession(folderDir: string, launchClaude = false) {
    const added = await invoke<SessionData>("ab_add_session", { dir: folderDir, name: null });
    if (added.isErr()) return;
    const rec = added.value;
    selectSession(folderDir, rec.id);
    if (launchClaude) {
      setStartClaudeTarget({ folderDir, sessionId: rec.id, sessionName: rec.name, restart: false });
    }
  }

  // The repo header's "+": a shell in the root checkout, wherever focus was, and
  // the keyboard goes straight into it — unfolding whatever would hide its row.
  async function newRootShell(repo: RepoData) {
    uiAction("agentboard.new_root_shell", "agentboard");
    const added = await invoke<SessionData>("ab_add_session", { dir: repo.dir, name: null });
    if (added.isErr()) {
      if (!NotInTauri.is(added.error)) toast.error(errorMessage(added.error));
      return;
    }
    const rec = added.value;
    applyCollapse(
      [repo.key, `${repo.key}::${repo.dir}`]
        .filter((key) => collapsed[key])
        .map((key) => ({ key, collapsed: false })),
    );
    selectSession(repo.dir, rec.id);
    setFocusLevel("pane");
    setFocusTerminalRequest((r) => ({ id: rec.id, nonce: (r?.nonce ?? 0) + 1 }));
  }

  // A window can't exist without panes, so "+ window" spawns a session too.
  async function newWindow(folderDir: string) {
    const added = await invoke<SessionData>("ab_add_session", { dir: folderDir, name: null });
    if (added.isErr()) return;
    const sessionId = added.value.id;
    const id = nextWindowId();
    updateWins([folderDir], (cur) => {
      const count = cur.windows.filter((w) => w.folderDir === folderDir).length;
      return {
        windows: [
          ...cur.windows,
          { id, name: `window ${count + 1}`, folderDir, panes: [sessionId] },
        ],
        activeWindows: { ...cur.activeWindows, [folderDir]: id },
      };
    });
    // Mount + focus the session; `placePane` sees it already hosted here.
    selectSession(folderDir, sessionId);
  }

  async function launchClaudeIn(
    target: StartClaudeTarget,
    prompt: string,
    options?: ClaudeLaunchOptions,
    /** What the toast shows when it should differ from what's typed into the PTY. */
    label?: string,
  ) {
    const { folderDir, sessionId, sessionName, restart } = target;
    const shown = label ?? prompt;
    setOverlay(sessionId, OVERLAY_STARTED);
    const verb = restart ? "starting over — fresh Claude session" : "starting Claude";
    toast(shown ? `✦ ${verb} in ${sessionName}: ${shown}` : `✦ ${verb} in ${sessionName}`);
    await withLiveSession(
      sessionId,
      async () => {
        if (restart) {
          await termWriteRetry(sessionId, "\x03");
          await sleep(150);
          await termWriteRetry(sessionId, "\x04");
          await sleep(300);
        }
        await termWriteRetry(sessionId, claudeCommand(prompt, options));
      },
      folderDir,
    );
  }

  // A `.claude/launch.json` config in a fresh session, over the same PTY-typing
  // path (no backend spawn). The config→session mapping is what lets the popover
  // offer "focus" instead of a second launch while the pane lives.
  async function launchDevServer(folderDir: string, cfg: LaunchConfigStatus) {
    const added = await invoke<SessionData>("ab_add_session", {
      dir: folderDir,
      name: `dev: ${cfg.name}`,
    });
    if (added.isErr()) {
      toast(errorMessage(added.error));
      return;
    }
    const rec = added.value;
    const command = launchCommand(cfg);
    toast(`▶ ${command} — in ${rec.name}`);
    void abSetSessionPurpose(rec.id, command);
    await withLiveSession(
      rec.id,
      async () => {
        const wrote = await termWriteRetry(rec.id, `${command}\r`);
        if (wrote.isErr()) {
          toast(`could not start ${cfg.name}: ${errorMessage(wrote.error)}`);
          return;
        }
        void launchRegister(folderDir, cfg.name, rec.id, cfg.port ?? null, command);
      },
      folderDir,
    );
  }

  // Dismiss the start-Claude dialog and launch with whatever's typed — blank is
  // a valid answer, it just skips the initial prompt + purpose.
  function commitStartClaude() {
    const target = startClaudeTarget;
    if (!target) return;
    setStartClaudeTarget(null);
    const prompt = startClaudePrompt.trim();
    setStartClaudePrompt("");
    // The typed prompt is why this session exists; blank leaves it unlabeled.
    if (prompt) void abSetSessionPurpose(target.sessionId, prompt);
    void launchClaudeIn(target, prompt);
  }

  return {
    startClaudeTarget,
    setStartClaudeTarget,
    startClaudePrompt,
    setStartClaudePrompt,
    withLiveSession,
    newSession,
    newRootShell,
    newWindow,
    launchClaudeIn,
    launchDevServer,
    commitStartClaude,
  };
}
