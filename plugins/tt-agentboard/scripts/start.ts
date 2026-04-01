#!/usr/bin/env bun
// Start agentboard: launch the server, then open tmux with the plugin loaded.

import { ensureServer } from "./lib/server-common";
import { basename } from "node:path";

const sessionName = process.argv[2] || basename(process.cwd());

// 1. Boot the server (spawns in background if not already running)
const alive = await ensureServer();
if (!alive) {
  console.error("Failed to start agentboard server. Check /tmp/agentboard-server-err.log");
  process.exit(1);
}

function initPlugin(): void {
  Bun.spawnSync(["tt", "agentboard", "init"], { stdout: "inherit", stderr: "inherit" });
}

// 2. Check if already inside tmux
if (process.env.TMUX) {
  console.log("Already inside tmux. Loading agentboard plugin…");
  initPlugin();
  process.exit(0);
}

// 3. Check if target session already exists
const checkSession = Bun.spawnSync(["tmux", "has-session", "-t", sessionName], {
  stdout: "pipe",
  stderr: "pipe",
});

if (checkSession.exitCode === 0) {
  console.log(`Attaching to existing tmux session "${sessionName}"…`);
  Bun.spawnSync(["tmux", "attach-session", "-t", sessionName], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
} else {
  Bun.spawnSync(["tmux", "new-session", "-d", "-s", sessionName], {
    stdout: "pipe",
    stderr: "pipe",
  });
  initPlugin();
  Bun.spawnSync(["tmux", "attach-session", "-t", sessionName], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
}
