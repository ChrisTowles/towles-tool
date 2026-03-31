#!/usr/bin/env bun
// Toggle the agentboard sidebar via the server.

import { ensureServer, serverUrl, tmuxContext } from "./lib/server-common";

if (!(await ensureServer())) process.exit(0);

const ctx = tmuxContext();
await fetch(serverUrl("/toggle"), { method: "POST", body: ctx }).catch(() => {});

// Reset tmux key table
Bun.spawnSync(["tmux", "switch-client", "-T", "root"], { stdout: "pipe", stderr: "pipe" });
