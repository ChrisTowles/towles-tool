---
name: run-app
description: Build, run, and screenshot the Towles Tool desktop app (Tauri 2 + WebKitGTK shell). Use when asked to run, start, build, test, or screenshot the app, or to launch it for the user to check.
---

# Running the desktop app

This is a Tauri 2 desktop app: `crates-tauri/tt-app` (Rust shell) +
`apps/client` (React/Vite frontend). "Running" it means the real
WebKitGTK WebView with real Rust IPC — never a bare browser against the
Vite dev server alone.

All paths below are relative to the repo/task root (wherever this
`.claude/skills/run-app/` lives).

## Prerequisites

- **zig 0.15.x on `PATH`** — needed to compile `libghostty-vt-sys`
  (`crates/tt-vt`). Build fails there, not in `tt-app`, if missing/mismatched.
- **webkit2gtk** dev libs + WebDriver binary (Linux only; macOS needs
  nothing extra):
  ```bash
  sudo apt-get install -y libwebkit2gtk-4.1-dev webkit2gtk-driver   # Debian/Ubuntu/Pop!_OS
  # Fedora 40+: sudo dnf install -y webkit2gtk4.1-devel webkit2gtk-driver
  # Arch:       sudo pacman -S webkit2gtk-4.1
  ```
- `npm install` at the repo root (npm workspaces — installs `apps/client` too).

## Build

The driver (`scripts/drive.mjs`) launches the app itself via `npm run
dev:drive` — there's no separate manual build step to run first.

## Run (agent path) — first

The **live-drive automation server** is the way an agent runs and drives
this app: one persistent, automatable window + a plain-`fetch` CLI client
talking to an in-process W3C WebDriver server. No Playwright, no
WebdriverIO at runtime. See [e2e/README.md](../../../e2e/README.md) for
the full protocol; this is the short version.

```bash
npm run dev:drive > /tmp/dev-drive.log 2>&1 &
disown
until node scripts/drive.mjs status 2>/dev/null | grep -q '"ready":true'; do sleep 5; done
```

This is a **cold `cargo build` + Vite dev server** — expect **several
minutes** the first time in a task with no warm `target/` (5-7 min
observed for a from-scratch build with the `wdio` feature; faster once
`target/` is warm). Poll `status`, don't guess a fixed sleep.

Once ready, drive it:

```bash
node scripts/drive.mjs invoke settings_get        # call a real Rust IPC command
node scripts/drive.mjs eval "document.title"      # run JS in the live window
node scripts/drive.mjs shot cockpit               # → e2e/screenshots/cockpit.png — Read it
node scripts/drive.mjs clicktext "Board"           # click a button/link by visible text
node scripts/drive.mjs click "input[name=foo]"     # click by CSS selector
node scripts/drive.mjs type "input[name=foo]" "x"  # type into an element
node scripts/drive.mjs url /                        # navigate the window
```

**Look at the screenshot** with `Read` — a blank or error frame is a
failure to launch, not a pass.

Ports are per-task/deterministic (`TT_DEV_PORT`-derived); `drive.mjs`
resolves them with no arguments, so nothing needs manual configuration.

## Run (human path)

```bash
npm start   # release build (`tauri build --no-bundle`) + run the binary — daily-driving
npm run dev # debug build via `tauri dev` — noticeably laggier, use dev:drive/start instead
```

Neither is automatable — they open a real window with no WebDriver
server attached. Use `dev:drive` for anything an agent needs to drive.

Per this repo's `CLAUDE.md`: after finishing a task that touches the app,
launch `npm start` as a background task as the last step, so the running
app is already on screen for Chris to check — this doesn't replace
driving/screenshotting it yourself first.

## Gotchas

- **`dev:drive` and `npm run e2e` share a task's ports** — don't run both
  in the same task at once.
- **`click`/`type` take CSS selectors only** (W3C `POST /element`) — they
  can't match by visible text. Use `clicktext "<text>"` for that; it fails
  loudly with the list of clickable texts found if there's no match/too
  many matches.
- **The left nav rail icons carry no visible text**, only `aria-label` —
  `clicktext` can't find them. Click via `eval` instead:
  ```bash
  node scripts/drive.mjs eval '(() => { document.querySelector(`[aria-label="Agentboard"]`).click(); return "clicked"; })()'
  ```
- **`eval`'s argument is wrapped as `await (<expr>)`** — pass a single
  expression (an IIFE for multi-step logic), not a statement list with a
  top-level `;`.
- **Don't click destructive-looking buttons** (e.g. "Delete") — the
  auto-mode permission classifier blocks them even when the real handler
  only opens a confirmation dialog. Verify that code path by reading the
  guard instead of clicking through it live.

## Troubleshooting

- **`drive.mjs status` → `ECONNREFUSED`:** `dev:drive` isn't running (or
  hasn't finished its cold build yet) in this task. Check the log you
  redirected to; a `cargo`/zig compile error shows up there, not in
  `drive.mjs`'s output.
- **Build fails in `libghostty-vt-sys`:** zig isn't on `PATH`, or is the
  wrong version — needs 0.15.x.
- **Stopping a stray `dev:drive` session:** it spawns `tauri` as its own
  process-group leader, so a background `&` launch has no wrapper to
  relay a signal to the whole tree. Kill the group, not just the PID you
  can see:
  ```bash
  ps aux | grep -E "dev-drive|tauri dev|target/debug/tt-app|vite" | grep -v grep
  kill -- -$(ps -o pgid= -p <any pid in the tree> | tr -d ' ')
  ```
  Confirm with `node scripts/drive.mjs status` (should fail to connect)
  rather than trusting `ps` alone — `vite`/esbuild can survive as an
  orphan and keep the port bound.
- **"another instance already holds the singleton lock, parking"** in the
  log — harmless if Chris's daily-driver app (or another task's `npm
  start`) is already running; it's the Slack-socket/MCP-port singleton
  guard, not this task's window failing to start.
