# CLAUDE.md — apps/client

React 19 + Vite frontend — see the root [`CLAUDE.md`](../../CLAUDE.md) for
the shell overview (sidebar nav, command palette, Focus screens, product
rules). This file covers the frontend-internal conventions that a single
read of the code won't surface.

## Three unrelated things are called "tab" in this repo

- **Workspace tabs** — open-screens bookkeeping in `useWorkspace()`
  (`src/lib/workspace.tsx`, persisted by `workspace-persistence.ts`). No
  visible tab strip — the sidebar is the only nav — but screens stay mounted
  when you switch away (a terminal keeps running), and
  `close-tab`/`next-tab`/`prev-tab`/`tab-1`…`9` operate on this set
  headlessly. This is what "tab" means in most docs/comments here.
- **Settings' sub-tab panel** — the panes inside the Settings screen, on the
  vendored shadcn/Radix `Tabs` primitive (`src/components/ui/tabs.tsx`). A
  generic tabbed-panel widget, not app-level navigation.
- **IDE editor/diff tabs** — `crates/tt-ide` / `ide.rs`'s
  `tabs`/`close_tab`/`closeAllDiffTabs`, the Claude Code IDE protocol
  ([docs/CLAUDE-CODE-IDE.md](../../docs/CLAUDE-CODE-IDE.md)). No shared code
  path with either of the above.

## Adding a screen is a 4-file ritual — there's no single source of truth

1. Register the `ScreenId` + `ScreenMeta` (icon/keywords/`fullBleed`) in
   `src/lib/screens.ts`.
2. Wire the component into `SCREEN_COMPONENTS` in `src/screens/index.tsx`.
3. Add it to a `NAV_SECTIONS` group in `src/lib/screens.ts` — miss this and
   the screen is reachable only via palette / tab restore, not the sidebar.
4. If it needs shortcuts, extend `SHORTCUTS` in `src/lib/shortcuts.tsx`.

`fullBleed` is load-bearing: `App.tsx` branches on it to skip the centered
`max-w-3xl` `ScrollArea` wrapper — a canvas screen that forgets it gets
squeezed into the narrow column. Screens stay mounted forever once visited
(`App.tsx` toggles `hidden`), so local state like terminal buffers survives
tab switches; `closeTab` is the only unmount path and refuses the last tab.

## IPC failures are values — the call site picks the UX

`src/lib/tauri.ts` exports one `invoke`, returning
`Result<T, IpcError>` ([better-result](https://better-result.dev)). It
**never throws and never rejects**: no Tauri host, a rejected command, a Zod
schema mismatch, and a timeout all come back as typed `Err`s
(`src/lib/errors.ts` — `NotInTauri`, `IpcFailed`, `SchemaMismatch`,
`IpcTimeout`).

That is deliberate: four wrappers each hardcoded one failure UX, and the two
that degraded to `null`/`false` hid real backend errors as "not wired in
browser". Each call site states its own intent:

```ts
const repos = (await invoke<Repo[]>("list_repos")).unwrapOr([]);      // degrade
if ((await taskDelete({ id })).isErr()) revertOptimisticDelete();      // branch
result.match({ ok: setView, err: (e) => {                             // report
  if (!NotInTauri.is(e)) toast.error(e.message);                      // …but not in browser dev
} });
```

Three rules that follow from this:

- **Browser dev is `NotInTauri`, not a failure.** Test for it with
  `NotInTauri.is(e)` — never `e._tag === "…"`, which oxlint rejects.
- **Fire-and-forget is safe by construction.** An ignored `Result` can't
  produce an unhandled rejection, so `void invoke(…)` needs no `.catch`.
  The hot PTY-write path in `components/terminal-view.tsx` relies on this.
  A `.catch` on an `invoke` is dead code.
- **Use `errorMessage(e)` (`src/lib/errors.ts`), not `String(e)`**, for
  display. Tauri rejects with a bare string, which `String()` renders as
  `"[object Object]"`.

Two boundaries keep a *throwing* contract because a foreign interface demands
it: `lib/monaco-fs.ts` (monaco's `IFileSystemProvider`) and `lib/lsp.ts`
(vscode-jsonrpc's rejecting `write`). Translate `Err` → throw there only.

`.claude/hooks/guard-better-result.sh` flags drift back to the old shapes
on every edit.

## Mock-data fallback is colocated per-module, not a single file

There is no `mock-data.ts`: each module owns its fallback (`mockSnapshot` in
`src/lib/data.ts`, `mockView` in `src/lib/slack.ts`), gated on `!isTauri()`
so plain-Vite browser dev still renders. Add new ones the same way.

## Shortcuts registry validates at build time

`defineShortcuts`/`parseKeys` (`src/lib/shortcuts.tsx`) throw at module-eval
time on a bad spec or duplicate id — a typo'd shortcut fails the build.

Every binding that fires records `shortcut.<id>`, and every *click target that
does the same thing as a binding* must record `mouse.<id>` by calling
`mouseAction(id, screen)` (`lib/shortcut-coach.ts`) in place of a plain
`uiAction` — that pair is the whole input to the keyboard-habit score
(Telemetry → Keyboard, `crates/tt-telemetry/src/keyboard.rs`) and to the
occasional "⌘B does that" toast. Only exact twins: a near-twin that scores as
a missed keystroke makes the number lie, and palette items deliberately score
as neither. Adding a shortcut with a clickable equivalent means wiring both
sides, the same way `allowInEditable` means wiring both sides below.

`allowInEditable` is a two-sided contract: it only works if the owning
component *also* checks `matchesEditableOverride` to yield the keystroke
instead of consuming it (see `components/terminal-view.tsx`). The whole
opt-out is further gated behind the `agentboard.shortcutsWorkInTerminal`
setting via `useShortcutsWorkInTerminal`, which refreshes on window focus and
on the `tt:settings-saved` event fired right after a successful Settings save
(`SETTINGS_SAVED_EVENT` in `lib/settings.ts`) — a save on the Settings tab
propagates immediately, no relaunch or app-level refocus needed.

## Terminal rendering is a custom protocol, not xterm.js

`src/lib/term-protocol.ts` defines the `terminal://frame` wire shape
(dirty-row diffs, packed colors, style bits) mirroring the Rust `tt-vt`
crate, plus the DOM-key→escape encoder (`encodeKey`) and wide-char handling
(`isWideRun`). A new terminal feature threads through the Rust frame struct
and this file in lockstep ([`crates/tt-vt/CLAUDE.md`](../../crates/tt-vt/CLAUDE.md)).

## A pane has no PTY until it is rendered

`term_start` runs from `TerminalView`'s mount effect, and the screen renders
only the **active folder's active window** panes — so a session can exist in
the rail, even report agent-running (the watcher reads Claude's on-disk
state, not the PTY), while no shell exists.

Anything that writes to a PTY must `selectSession(folderDir, id)` and then
`await waitForFirstFrame(id)` — `termWriteRetry` only covers the few hundred
ms before `term_start` registers the id, not a never-mounted pane. **A write
to an unmounted pane resolves `Err`**; unchecked, the action appears to work
and does nothing (worse under an optimistic overlay). Check it:
`if ((await termWrite(id, data)).isErr())`. This is why every `SessionActions`
lifecycle action takes `folderDir`, including `stopClaude`/`compactClaude` —
their triggers render for *every* folder, not just the active one.

Restoring several sessions must drain **serially** — select, await first
frame, write, next — since only one folder is active at a time; concurrent
requests leave every folder but the last with a placed-but-never-started pane
(the open-session drain effect in `screens/agentboard.tsx`).

## A pane that owns a process is pooled; one that owns a view is not

`PaneGrid` renders only the **active folder's active window**, so a
conditionally rendered pane unmounts the moment you click another folder.
Fine for diff/files/preview (refetch on mount, own nothing) — unacceptable
for a terminal and its shell. Those render from a flat pool of *every* such
pane open in *any* window, merely `hidden` elsewhere, so unmount means
"really closed" and the unmount effect can kill the process. **A new pane
kind that owns a process or accumulates state must join the pool and keep its
state outside the component** — adding it to the conditionally-rendered list
is the bug this rule exists to prevent.

Two panes show where the line actually falls. **Chrome**
(`browser-pane.tsx`) owns a browser process, but that process lives in Rust,
so the component is only a view and stays conditional — the sign-ins live in
the profile directory, not React. **Jarvis** (`jarvis-pane.tsx`) owns a Bevy
render thread and is still not pooled, because unmounting retires the
renderer rather than destroying it (`crates-tauri/tt-pane`); a shell's
scrollback has no such net. Jarvis' body is also a compositor surface
*above* the webview, so `hidden` on an ancestor is invisible to it — screen
switches push down as `visible={false}` (`PaneGrid`'s `nativeVisible`).

## Clickable rows can't be `<button>`s

Radix's `Checkbox`, `Switch`, `RadioGroupItem` and `*Trigger` primitives render
real `<button>`s, and a `<button>` may not contain interactive descendants.
The established patterns here:

- **Checkbox row** → `<label htmlFor>` wrapping the `Checkbox`; the label makes
  the whole row a click target natively, with no extra handler
  (`components/resume-picker.tsx`).
- **Inline rename input** → swap the element rather than nesting one: render
  *either* the input *or* the chip button, never an input inside the button
  (the window tab strip in `screens/agentboard.tsx`).
- **Row with trailing actions** → keep the action buttons as *siblings* in a
  flex row, with only the identity cluster inside the button
  (`components/agentboard-folder-header.tsx`).
- A `stopPropagation` on a child of a clickable parent is a smell that the
  nesting is wrong.

React reports these only at **runtime**, and nothing else in this repo can see
them: there is no linter, `tsc` doesn't model the DOM, and vitest runs in a
node environment with no renderer. `node scripts/drive.mjs console` is the
check — see below.

## The rail is five files, split by what a row *is*

`components/agentboard-rail.tsx` is the rail's own chrome (collapsed strip,
rollup tally) — not the tree. The tree is `agentboard-repo-group` (a repo's
subtree) → `agentboard-folder-header` (a checkout's row) →
`agentboard-session-row` (a PTY) / `agentboard-pane-rows` (chat, view panes,
window spine). Shared atoms live in `agentboard-bits`, pure logic in
`lib/agentboard.ts`. It was one 1,800-line file; a new row kind gets a sixth
file, not a grown one.

**In a rail row, a box means a control or an alert — never a fact.** Diff
counts, branch, base-moved and the pane buttons are bare mono type
(`CHIP_CLASS`), the box arriving on hover; per-row icon buttons pass `ghost`.
Only needs-you, port drift, safe-to-delete and deleting keep a resting box. A
pane *header* is the opposite case (one toolbar, room to spare) and keeps the
bordered, `labeled` form. Per the `visual-design` skill: a rail that boxes
everything ranks nothing.

A folder row is **one line when the rail is wide enough, two when it isn't**
— `@container/row` at 34rem, an `order` swap keeping the toolbar on the
name's line while git counts drop below. Container, not viewport: the rail is
independently resizable (300–760px), so the question is *this row's* room.

## Two animation idioms — the choice is mechanical, not stylistic

`tw-animate-css` (imported in `index.css`) is the default: the vendored
`components/ui/*` animate with `data-open:animate-in fade-in-0 …`, which works
because Radix keeps a closing element mounted until its animation ends.

Nothing else has that luxury. The agentboard rail renders a backend snapshot
(`agentboard://state`), so a removed repo/task/session is just absent from the
next payload and React unmounts the row before any CSS can run. That case uses
`motion`: `<AnimatePresence>` holds the departed row on screen, and `layout`
slides the survivors into the space it frees. Config lives in
`lib/rail-motion.ts` — spread it rather than hand-rolling per-row variants.

Deliberately **not** wrapped in yaak's `<LazyMotion strict>` + `m.*`: that
splits motion into its own chunk only when every `AnimatePresence` consumer is
lazily imported, and screens here are static imports (`screens/index.tsx`), so
a build puts motion in the initial chunk regardless. `main.tsx` keeps only
`<MotionConfig reducedMotion="user">`, which is real app-wide a11y policy.

## Testing convention: logic-only

Logic tests (`*.test.ts`) run in the fast Node env — the default. Components
are kept deliberately thin, so most branching logic lives in pure `lib/*.ts`
functions that are unit-testable without a DOM (e.g. `workspace-persistence.ts`
exists solely to make tab-restore logic testable). Prefer that seam when you
can.

Render-level tests (`*.test.tsx`) cover what a pure function can't — a
screen mounts without throwing. They opt into jsdom per-file
(`// @vitest-environment jsdom`, keeping the Node suite quick) and render
through `src/test/render.tsx`'s `renderWithProviders` (App.tsx's provider
tree plus the polyfills jsdom omits). **The backend seam is jsdom itself:**
no `__TAURI_INTERNALS__`, so every `invoke` returns `NotInTauri` and each
component paints its colocated browser-dev fallback — stub at that seam,
never mock component internals. Smoke/regression guards only, not a
substitute for driving the real shell.

**A green test run still says little about a *correct* render.** The
authoritative signal for a runtime React complaint (invalid DOM nesting, bad
hook order) is the page's own console, buffered under `VITE_WDIO`
(`lib/wdio-console.ts`): every `scripts/drive.mjs` verb prints a console-error
summary, and `drive.mjs console` dumps it, exiting non-zero on real errors.
Verify UI/IPC by driving the shell (`npm run e2e` / `npm run dev:drive`); a
UI change made without looking at that output is unverified.
