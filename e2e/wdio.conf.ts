import path from "node:path";
import { requireDevPort, resolveWebdriverPort } from "../scripts/task-port.mjs";

// Never a hardcoded 1420: concurrent worktrees would collide, so ports resolve
// from this checkout's rendered `.env` (scripts/e2e.mjs injects them).
// The forced scope is all that keeps `store_add_task` off this checkout's real board.
if (!(process.env.TT_STATE_SCOPE ?? "").startsWith("e2e-")) {
  throw new Error("e2e needs TT_STATE_SCOPE=e2e-<checkout>: run `bun run e2e`, not wdio directly");
}

const repoRoot = process.cwd();
const devPort = requireDevPort(repoRoot, { tag: "wdio" });
const wdPort = resolveWebdriverPort(devPort);

// Debug binary built with `--features wdio`, in the same target dir cargo just
// wrote to: a shared `CARGO_TARGET_DIR` (several worktrees, one warm cache) has
// no `target/` under the repo root.
const targetDir = process.env.CARGO_TARGET_DIR ?? path.resolve(process.cwd(), "target");
const appBinary = path.resolve(targetDir, "debug/tt-app");

export const config: WebdriverIO.Config = {
  runner: "local",
  tsConfigPath: path.resolve(process.cwd(), "e2e/tsconfig.json"),

  specs: ["./specs/**/*.e2e.ts"],
  maxInstances: 1,

  // The app boots pointing at its baked devUrl (unused here); we navigate the
  // automatable WebView to the live dev server in `before`.
  baseUrl: `http://localhost:${devPort}`,

  capabilities: [
    {
      browserName: "tauri",
      // @ts-expect-error tauri capability shape isn't in the base WDIO types
      "tauri:options": { application: appBinary },
    },
  ],

  services: [
    [
      "@wdio/tauri-service",
      {
        appBinaryPath: appBinary,
        // Needs TAURI_WEBVIEW_AUTOMATION=true (set by e2e.mjs) to be automatable.
        driverProvider: "embedded",
        embeddedPort: wdPort,
        // GTK/WebKit GUI cold-starts in ~6-8s; give the readiness poll room.
        startTimeout: 60000,
        statusPollTimeout: 20000,
      },
    ],
  ],

  framework: "mocha",
  reporters: ["spec"],
  logLevel: "warn",
  bail: 0,
  waitforTimeout: 15000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 3,
  mochaOpts: { ui: "bdd", timeout: 90000 },

  // Point the WebView at the live dev server once per session, then wait for the
  // React app to mount before any spec runs.
  before: async function () {
    await browser.url("/");
    await browser.$("#root").waitForExist({ timeout: 20000 });
  },
};
