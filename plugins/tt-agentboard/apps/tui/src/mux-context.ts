import { TmuxClient } from "@tt-agentboard/mux-tmux";

export type MuxContext = { type: "tmux"; sdk: TmuxClient; paneId: string } | { type: "none" };

export function detectMuxContext(): MuxContext {
  if (process.env.TMUX_PANE && process.env.TMUX) {
    return { type: "tmux", sdk: new TmuxClient(), paneId: process.env.TMUX_PANE };
  }
  return { type: "none" };
}

/** Refocus the main (non-sidebar) pane after TUI capability detection finishes.
 *  This must happen from the TUI process — doing it from start.sh races with
 *  capability query responses and leaks escape sequences to the main pane. */
export function refocusMainPane(muxCtx: MuxContext): void {
  if (muxCtx.type === "tmux") {
    try {
      const windowId =
        process.env.REFOCUS_WINDOW ||
        Bun.spawnSync(["tmux", "display-message", "-t", muxCtx.paneId, "-p", "#{window_id}"], {
          stdout: "pipe",
          stderr: "pipe",
        })
          .stdout.toString()
          .trim();
      if (!windowId) return;
      const r = Bun.spawnSync(
        ["tmux", "list-panes", "-t", windowId, "-F", "#{pane_id} #{pane_title}"],
        { stdout: "pipe", stderr: "pipe" },
      );
      const lines = r.stdout.toString().trim().split("\n");
      const main = lines.find((l) => !l.includes("agentboard-sidebar"));
      if (main) {
        const paneId = main.split(" ")[0];
        Bun.spawnSync(["tmux", "select-pane", "-t", paneId], { stdout: "pipe", stderr: "pipe" });
      }
    } catch {}
  }
}

export function getClientTty(muxCtx: MuxContext): string {
  if (muxCtx.type === "tmux") {
    const { sdk, paneId } = muxCtx;
    const sessName = sdk.display("#{session_name}", { target: paneId });
    if (sessName) {
      const clients = sdk.listClients();
      const client = clients.find((c) => c.sessionName === sessName);
      if (client) return client.tty;
    }
    return sdk.getClientTty();
  }
  return "";
}

export function getLocalSessionName(muxCtx: MuxContext): string | null {
  if (muxCtx.type === "tmux") {
    const sessionName = muxCtx.sdk.display("#{session_name}", { target: muxCtx.paneId });
    return sessionName || null;
  }
  return null;
}
