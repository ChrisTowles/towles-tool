---
name: run-app
description: Build, run, and screenshot the Towles Tool desktop app (Tauri 2 + WebKitGTK shell). Use when asked to run, start, build, test, or screenshot the app, or to launch it for the user to check.
---

# Running the desktop app

Tauri 2 app: `crates-tauri/tt-app` (Rust) + `apps/client` (React/Vite).
"Running" means the real WebKitGTK WebView with real Rust IPC — never a
bare browser against the Vite dev server.

Paths below are relative to the repo/task root.

## Prerequisites

- **zig 0.15.x on `PATH`** (compiles `libghostty-vt-sys`). Missing/wrong
  version → build fails in `tt-vt`, not `tt-app`.
- **Linux only:**
  ```bash
  sudo apt-get install -y libwebkit2gtk-4.1-dev webkit2gtk-driver
  ```
- `npm install` at the repo root.

## Run (agent path) — start here

```bash
npm run dev:drive > /tmp/dev-drive.log 2>&1 &
disown
until node scripts/drive.mjs status 2>/dev/null | grep -q '"ready":true'; do sleep 5; done
```

Cold `cargo build`, so this takes several minutes (5-7 observed) the first
time in a task — poll `status`, don't guess a sleep. Full protocol:
[e2e/README.md](../../../e2e/README.md).

```bash
node scripts/drive.mjs invoke settings_get        # real Rust IPC command
node scripts/drive.mjs eval "document.title"      # JS in the live window
node scripts/drive.mjs shot cockpit               # → e2e/screenshots/cockpit.png — Read it
node scripts/drive.mjs clicktext "Board"           # click by visible text
node scripts/drive.mjs click "input[name=foo]"     # click by CSS selector
node scripts/drive.mjs type "input[name=foo]" "x"  # type into an element
node scripts/drive.mjs url /                        # navigate
```

**Read the screenshot** — blank/error means it didn't launch. Ports
resolve automatically per task, no config needed.

## Run (human path)

```bash
npm start   # release build + run — daily-driving
npm run dev # debug build, laggier
```

Neither is automatable (no WebDriver server attached) — use `dev:drive`
for anything an agent needs to drive.

Per this repo's `CLAUDE.md`: after finishing a task that touches the app,
launch `npm start` in the background as the last step so it's already on
screen for Chris — doesn't replace driving it yourself first.

## Gotchas

- `dev:drive` and `npm run e2e` share a task's ports — don't run both at once.
- `click`/`type` need CSS selectors, not text — use `clicktext` for text.
- Nav rail icons have no visible text, only `aria-label`:
  ```bash
  node scripts/drive.mjs eval '(() => { document.querySelector(`[aria-label="Agentboard"]`).click(); return "clicked"; })()'
  ```
- `eval`'s arg is wrapped as `await (<expr>)` — pass one expression (an
  IIFE), not a `;`-separated statement list.
- Don't click destructive-looking buttons (e.g. "Delete") — the auto-mode
  permission classifier blocks them even if the handler just opens a
  confirm dialog. Read the guard instead.

## Troubleshooting

- **`ECONNREFUSED` on `status`:** not ready yet, or the log has a
  cargo/zig compile error — check the log, not `drive.mjs`'s output.
- **Build fails in `libghostty-vt-sys`:** zig missing or wrong version.
- **Killing a stray `dev:drive`:** it's a process-group leader; kill the
  group, not one PID:
  ```bash
  ps aux | grep -E "dev-drive|tauri dev|target/debug/tt-app|vite" | grep -v grep
  kill -- -$(ps -o pgid= -p <any pid in the tree> | tr -d ' ')
  ```
  Confirm with `drive.mjs status` — `vite`/esbuild can survive as an orphan.
- **"another instance already holds the singleton lock"** in the log:
  harmless if Chris's daily driver (or another task) is already running.
