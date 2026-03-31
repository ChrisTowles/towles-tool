#!/usr/bin/env bun
// Start agentboard: launch the server, then open tmux with the plugin loaded.

import { ensureServer, resolvePluginDir } from "./lib/server-common";
import { join, basename } from "node:path";

const pluginDir = resolvePluginDir();
const pluginEntry = join(pluginDir, "agentboard.tmux");
const sessionName = process.argv[2] || basename(process.cwd());

// 1. Boot the server (spawns in background if not already running)
const alive = await ensureServer();
if (!alive) {
  console.error("Failed to start agentboard server. Check /tmp/agentboard-server-err.log");
  process.exit(1);
}

// 2. Check if already inside tmux
if (process.env.TMUX) {
  // Already in tmux — just source the plugin to register hooks/keybindings
  console.log("Already inside tmux. Loading agentboard plugin…");
  Bun.spawnSync(["bash", pluginEntry], {
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, AGENTBOARD2_DIR: pluginDir },
  });
  process.exit(0);
}

// 3. Check if target session already exists
const checkSession = Bun.spawnSync(["tmux", "has-session", "-t", sessionName], {
  stdout: "pipe",
  stderr: "pipe",
});

if (checkSession.exitCode === 0) {
  // Session exists — attach and source the plugin
  console.log(`Attaching to existing tmux session "${sessionName}"…`);
  Bun.spawnSync(["tmux", "attach-session", "-t", sessionName], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
} else {
  // Create new session (detached), source plugin, then attach
  Bun.spawnSync(["tmux", "new-session", "-d", "-s", sessionName], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, AGENTBOARD2_DIR: pluginDir },
  });

  // Source the plugin inside the new session to register hooks + keybindings
  Bun.spawnSync(["bash", pluginEntry], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, AGENTBOARD2_DIR: pluginDir },
  });

  // Attach
  Bun.spawnSync(["tmux", "attach-session", "-t", sessionName], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
}
