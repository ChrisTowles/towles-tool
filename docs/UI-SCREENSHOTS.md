# Screenshotting and driving the Tauri app UI

How to capture and manipulate the running desktop app from an agent/terminal
session on this machine (Pop!_OS, COSMIC desktop, Wayland). Verified 2026-07-03.

## Taking screenshots

COSMIC on Wayland rules out the usual tools:

- `grim` fails — cosmic-comp doesn't implement `wlr-screencopy-unstable-v1`.
- The GNOME Shell D-Bus screenshot API isn't present (not GNOME).
- X11 tools (`import`, `scrot`, `xdotool`-based capture) only see XWayland
  windows; the Tauri/GTK app runs native Wayland.

What works is the portal-backed COSMIC tool:

```sh
cosmic-screenshot --interactive=false --notify=false --save-dir <dir>
# prints the saved file path; captures ALL monitors as one wide PNG
```

Then crop to the app window with ImageMagick (find the window region by
viewing the full capture once; the app window position is stable between
shots as long as it isn't moved):

```sh
convert full.png -crop <W>x<H>+<X>+<Y> +repage app.png
```

### The "Allow Towles Tool to Take Screenshots?" dialog

`cosmic-screenshot` is a client of `org.freedesktop.portal.Screenshot`, and
xdg-desktop-portal gates each app-id behind a one-time Access dialog. The
app-id comes from the caller's systemd scope, and everything spawned from a
terminal pane inside the app inherits it
(`app-cosmic-dev.towles.tool-<pid>.scope` → `dev.towles.tool` →
`Name=Towles Tool`). Run the same command from a terminal outside the app and
the app-id is `""` — a separate row, granted separately.

The grant is only written when the dialog is *answered*; a Deny or a timeout
(`Failed to show access dialog: Timeout was reached` in
`journalctl --user -u xdg-desktop-portal`) leaves it unset and the next capture
re-prompts. Grant both rows once, without waiting for a dialog:

```sh
flatpak permission-set screenshot screenshot dev.towles.tool yes
flatpak permission-set screenshot screenshot "" yes
flatpak permission-list screenshot   # verify
```

It lands in `~/.local/share/flatpak/db/screenshot` and survives reboots and
app rebuilds.

## Driving the UI (no input injection)

There is no working synthetic input on this setup — `xdotool` can't reach
native Wayland surfaces and nothing like `ydotool` is configured. Two
approaches that do work:

### 1. Vite HMR against the live Tauri window (preferred)

`bun run dev` keeps the Vite dev server attached to the real WebView, so any
source edit hot-reloads into the running app in ~1s. To put the UI in a
desired state, temporarily hard-code that state, screenshot, revert:

```tsx
<Dialog open>          {/* temporarily controlled-open */}
```

**Gotcha:** React Fast Refresh preserves component state, so *initial-state*
props like `defaultOpen` or changed `useState` initializers do nothing on
hot reload. Use a **controlled** prop (`open`, `value`, …), which takes
effect on re-render. Revert the edit when done — never commit it.

### 2. Bare browser via Chrome DevTools (for real interaction)

The same frontend runs in a normal browser (`bun run client:dev` if the
Tauri app isn't already running the dev server, defaults to
`http://localhost:1420`). There, browser-automation tooling (Chrome DevTools
MCP) can click, type, and screenshot the page normally. Caveat: the app
renders the "bare browser" code path (`__TAURI_INTERNALS__` is absent), so
Tauri-specific behavior (IPC commands, WebView quirks) is only observable in
the real shell via approach 1.

## Misc

- `bun run dev` (root) picks a deterministic per-task port automatically via
  `scripts/dev-port.mjs` instead of hardcoding 1420, so running this repo
  from multiple worktrees at once no longer collides (a stale listener
  on that port gets killed rather than skipped). Watch its
  `[dev-port] using port N` log line to find which port a given task's
  WebView/browser target is on. `bun run client:dev` (bare Vite, no Tauri)
  still defaults to 1420 since it isn't task-aware.
- If the tt-app build script fails reading plugin permissions from a *stale
  absolute path* (another checkout's `target/`), the cargo build cache was
  copied between worktrees: `rm -rf target/debug/build/tauri-* target/debug/build/tt-app-*`
  and rebuild.
