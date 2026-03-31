#!/usr/bin/env bun
// Focus the agentboard2 sidebar pane, or toggle it on if missing.

import { ensureServer, serverUrl, tmuxContext, tmuxDisplay } from "./lib/server-common";

function findSidebarPane(windowId: string): string | null {
  try {
    const r = Bun.spawnSync(
      ["tmux", "list-panes", "-t", windowId, "-F", "#{pane_id} #{pane_title}"],
      { stdout: "pipe", stderr: "pipe" },
    );
    for (const line of r.stdout.toString().trim().split("\n")) {
      const [paneId, title] = line.split(" ", 2);
      if (title === "agentboard2-sidebar" && paneId) return paneId;
    }
  } catch {}
  return null;
}

function selectPaneAndResetKeys(paneId: string): void {
  Bun.spawnSync(["tmux", "select-pane", "-t", paneId], { stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(["tmux", "switch-client", "-T", "root"], { stdout: "pipe", stderr: "pipe" });
}

const windowId = tmuxDisplay("#{window_id}");
if (!windowId) process.exit(0);

// If sidebar already exists, just focus it
const existing = findSidebarPane(windowId);
if (existing) {
  selectPaneAndResetKeys(existing);
  process.exit(0);
}

// Otherwise, ensure server + toggle sidebar on
if (!(await ensureServer())) process.exit(0);

const ctx = tmuxContext();
await fetch(serverUrl("/toggle"), { method: "POST", body: ctx }).catch(() => {});

// Wait for sidebar pane to appear
for (let i = 0; i < 20; i++) {
  const paneId = findSidebarPane(windowId);
  if (paneId) {
    selectPaneAndResetKeys(paneId);
    process.exit(0);
  }
  await Bun.sleep(50);
}

Bun.spawnSync(["tmux", "switch-client", "-T", "root"], { stdout: "pipe", stderr: "pipe" });
