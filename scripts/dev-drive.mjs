#!/usr/bin/env node
// Launch the app as a PERSISTENT, automatable dev window: `npm run dev` plus the
// `wdio` cargo feature and WebKit automation, so `tauri-plugin-wdio-webdriver`
// serves W3C WebDriver on `wdPort` for the window's whole lifetime and
// `scripts/drive.mjs` can drive it while you watch — no WDIO, no spawn/kill (see
// e2e/README.md). Ports are the per-checkout `.env` claims, never a free scan.
import { fileURLToPath } from "node:url";
import path from "node:path";
import { requireDevPort, resolveWebdriverPort, spawnTauriDev, killPort } from "./task-port.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const devPort = requireDevPort(repoRoot, { tag: "dev-drive", render: true });
const wdPort = resolveWebdriverPort(devPort);

// This port is always pinned to the task (never scanned), so anything
// already listening here is almost certainly this task's own orphaned
// session — safe to kill before we rebind. See killPort in task-port.mjs.
await killPort(devPort);

console.log(`[dev-drive] dev server ${devPort} · automation server ${wdPort}`);
console.log(
  `[dev-drive] once the window is up: node scripts/drive.mjs status  (→ http://127.0.0.1:${wdPort}/status)`,
);

// `tauri dev` builds the app (with our feature) and runs beforeDevCommand (vite).
// devUrl is baked to the dev port so the WebView is a trusted Tauri origin (IPC
// invokes allowed); VITE_WDIO makes the frontend load @wdio/tauri-plugin.
spawnTauriDev(
  [
    "dev",
    "--features",
    "wdio",
    "--config",
    JSON.stringify({ build: { devUrl: `http://localhost:${devPort}` } }),
  ],
  {
    ...process.env,
    TT_DEV_PORT: String(devPort),
    VITE_WDIO: "1",
    TAURI_WEBVIEW_AUTOMATION: "true",
    TAURI_WEBDRIVER_PORT: String(wdPort),
    // A live-drive window is a verification tool, not the user sitting down
    // to use the app — don't let it steal OS focus on launch.
    TT_NO_FOCUS_STEAL: "1",
  },
);
