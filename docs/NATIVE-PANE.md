# `tt-jarvis` — the native pane

A Bevy scene rendered into a surface it did not create, so a region of the app
window is real GPU output rather than DOM. Referenced from
[CLAUDE.md](../CLAUDE.md)'s Architecture section.

the **native pane**: a Bevy scene rendered into a surface it
did not create, so a region of the app window is real GPU output rather
than DOM. Native rather than WebAssembly or streamed frames because only a
native surface can host Solari's ray-tracing pipeline (see
[README.md](README.md)).

It renders in two places, both fed by the same `NativePane` component:
the strip at the bottom of the Agentboard rail, and a **first-class pane
kind** — `~jarvis:<folderDir>` (`lib/agentboard.ts`,
`components/jarvis-pane.tsx`) tiled beside a checkout's terminals from the
`jarvis` button on its folder header, persisted and restored like the
files/preview panes because it's in `folderPaneDir`. Folder-scoped for
a resource reason as much as a naming one: every attached pane is its own
subsurface *and* its own Bevy render thread. It is deliberately **not**
pooled like terminals — those own a process whose state can't be rebuilt,
while a native pane can, so leaving the active window should really detach
it.

**Opt-in, off by default** while it's a proof-of-concept
(`agentboard.jarvisPane`; the cube button in the rail header, or Settings →
Agentboard) — one switch for both surfaces: off, the rail strip isn't
rendered and the folder header offers no `jarvis` button. `visible={false}`
is the *only* way to get a shown pane out of the way of DOM that must
appear over it (a screen switch): the surface composites above the webview,
so no ancestor's `hidden` reaches it.

**Nothing takes a pane down while the app runs, and that is deliberate.**
Three mechanisms were measured against compositor screenshots, and only the
third survives: attaching a **null buffer** (the textbook unmap) left the
surface on screen even with the renderer stopped; **detaching** removed it
and then ended the process within seconds, every time, cleanly enough that
the last log line was `pane render thread stopped` — dropping a Bevy app
tears down a wgpu device built on GDK's own Wayland display, so no teardown
*order* can save it; **moving the subsurface outside every output** and
parking the render thread works, reversibly and instantly. Hence
`pane_set_visible` parks, `pane_detach` *retires* (parks and keeps the
renderer for the same id to revive), and real teardown happens only at
process exit. A pane, once shown, costs a parked renderer for the app's
life. Verify any change here from `winshot` output — a pane that "should"
be gone and isn't looks exactly like a stale screenshot.

Bevy comes from **`slyedoc/bevy@solari-rt-pipeline` (0.20.0-dev)**. Keep it
there — tracking that fork is the goal, and `Cargo.lock` pins the revision
so builds stay reproducible. Bevy accepts a foreign surface through public
API with no renderer fork; `surface.rs`'s module docs explain how, and are
the place to read before changing it.

Two traps, both of which fail as something else:
**(1)** a host driving `App::update()` by hand calls
`finalize_embedded_app` first, or every `Res<RenderDevice>` system panics
with "Resource does not exist" — after a healthy-looking `AdapterInfo`.
**(2)** a `wl_subsurface` is *synchronized* by default; `set_desync()` is
what keeps the pane's framerate off the parent's. Measured at 0.65 fps
synced against 60 desynced, so it is a ceiling rather than a tax.
**(3)** an occluded Wayland surface receives **no frame callbacks**, so a
vsync'd pane stalls when its window is hidden or on another workspace. Right
behaviour for a pane, reads as a hang, and makes any vsync benchmark arm
unmeasurable on a desktop in use.

The pane's framerate is **paced by the display** because both faster present
modes flood the compositor and lose the Wayland connection —
`tt-pane/src/render.rs` carries that decision and
`tt-jarvis/examples/jarvis_demo.rs` the per-mode measurements.

**`bevy_solari` does not build, and not for local reasons:** cargo `[patch]`
applies only from the top-level workspace, so a git dependency does not
inherit its own repo's patches. `.cargo/solari-patch.toml` is the single home
for the restated patch set, the five failure modes and the upstream blocker —
read it before retrying Solari.
