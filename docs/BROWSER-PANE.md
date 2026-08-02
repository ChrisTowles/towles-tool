# The Chrome pane

A real Chrome, tiled beside a checkout's terminals. Its point is **login
persistence**: sign into a site inside the pane once and it stays signed in,
because the pane's Chrome runs on a profile the app owns. Referenced from
[CLAUDE.md](../CLAUDE.md)'s Architecture section; the crate is
`crates/tt-browser`, the host `crates-tauri/tt-app/src/browser.rs`, the pane
`apps/client/src/components/browser-pane.tsx`.

**The profile is ours and starts empty. It is never seeded from the user's
personal Chrome** — not a limitation, the design: agents may drive this
browser, so it holds only what was deliberately signed into it. It lives at
`tt_config::browser_profile_dir()`, a *shared* store (a sign-in is a machine
fact, like `repos.json`).

## Why not the iframe preview

Verified live before any of this was built: `google.com` renders a blank frame
in the preview pane — `X-Frame-Options` refuses framing, and Google blocks
sign-in in embedded webviews besides. No iframe or WebKit surface can satisfy
"log in and stay logged in". A top-level Chromium context is a requirement,
not a preference.

## Why frames, not a window

Neither target OS can embed a foreign process's window: Wayland subsurface
parentage is per-client (`tt-pane/src/wayland.rs`) and macOS has no supported
cross-process NSView adoption. So Chrome runs headless and its pixels arrive
as CDP frames painted onto a DOM `<canvas>`, with input dispatched back. That
is also why the pane needs no platform code at all — one implementation
serves Linux and macOS, unlike `tt-jarvis`, which is Linux-only.

Being DOM has a second payoff: dialogs and the palette overlay the pane
normally, and the annotation canvas composites over it, neither of which is
true of a native surface.

## Three facts that will bite

**Shutdown must be CDP `Browser.close` first.** Chrome flushes its cookie DB
on graceful exit only; the Phase-0 spike lost a just-set cookie to a SIGTERM
every time. `Instance::shutdown_graceful` does close → wait → signal, and
that order is the whole feature working.

**The CDP event closure must never issue a blocking call.** It runs on the
socket thread, which is the only thread that reads responses, so a `call()`
there deadlocks. Frames are handled inline (decode + channel send); every
other event re-dispatches to a worker.

**One profile dir backs one Chrome process.** Chrome's own singleton lock
means a second launch against a live profile is delegated to the first and
its debugging flags are dropped. Concurrent worktree instances therefore
contend: the first to open a pane takes an `InstanceLock("browser-profile")`
and the rest are told which checkout holds it. Per-instance profiles were
rejected because they would mean per-worktree logins.

## Shape

One process per app instance, one CDP target per pane. Panes are cheap; the
process is the resource, and it exits when the last pane closes. `BrowserHost`
holds the instance plus a `sessionId -> Route` map; frames go out per-pane over
a `tauri::ipc::Channel` as raw JPEG (no base64 hop), state over
`browser://state`.

Pane phases: `launching → live ⇄ parked`, plus `poppedOut` and `crashed`.
`parked` stops the screencast and keeps the target — screencast is
paint-driven, so an idle page costs nothing anyway (measured: one frame total
for a static page, ~60 fps for animating content).

**Pop-out** swaps the whole instance to a headful window on the same profile.
CDP stays enabled there — the 136+ block on remote debugging applies to
Chrome's *default* profile dir, not ours — but it takes every embedded target
with it, so it is single-pane only.

## Verifying

`npm run dev:drive`, then drive it: the surface is a DOM canvas, so plain
`drive.mjs shot` sees it and `winshot` is unnecessary. `TT_BROWSER_BIN`
overrides the binary for tests. Two traps when driving: headless Chrome
inherits a dark `prefers-color-scheme`, so `about:blank` renders dark and
looks like "no frames"; and the pane has two stacked canvases — the frame
canvas and the ink overlay — so a synthetic event has to target the last one.
