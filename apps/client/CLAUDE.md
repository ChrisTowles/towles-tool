# CLAUDE.md — apps/client

React 19 + Vite frontend — the root [`CLAUDE.md`](../../CLAUDE.md) has the shell
overview; this file has the frontend-internal conventions a read won't surface.

## Three unrelated things are called "tab" here

**Workspace tabs** — open-screens bookkeeping in `useWorkspace()`
(`lib/workspace.tsx`, persisted by `workspace-persistence.ts`). No visible tab
strip (the sidebar is the only nav), but screens stay mounted when you switch
away and `close-tab`/`next-tab`/`tab-1`…`9` act on this set headlessly; this is
what "tab" usually means. **Settings' sub-tab panel** is the vendored Radix
`Tabs` widget, not navigation. **IDE editor/diff tabs** are `tt-ide`'s
([docs/CLAUDE-CODE-IDE.md](../../docs/CLAUDE-CODE-IDE.md)) — no shared path.

## Adding a screen is a 4-file ritual — there's no single source of truth

1. `ScreenId` + `ScreenMeta` (icon/keywords/`fullBleed`) in `lib/screens.ts`.
2. The component into `SCREEN_COMPONENTS` in `screens/index.tsx`.
3. A `NAV_SECTIONS` group in `lib/screens.ts` — miss this and the screen is
   reachable only via palette / tab restore, not the sidebar.
4. Shortcuts, if any, into `SHORTCUTS` in `lib/shortcuts.tsx`.

`fullBleed` is load-bearing: `App.tsx` branches on it to skip the centered
`max-w-3xl` `ScrollArea`, so a canvas screen that forgets it gets squeezed into
the narrow column. Screens stay mounted once visited (terminal buffers survive
switches); `closeTab` is the only unmount path, and refuses the last tab.

## IPC failures are values — the call site picks the UX

`lib/tauri.ts` exports one `invoke` returning `Result<T, IpcError>`
([better-result](https://better-result.dev)). It **never throws and never
rejects**: no Tauri host, a rejected command, a Zod mismatch and a timeout all
come back as typed `Err`s (`lib/errors.ts`). Each call site states its own intent
— `.unwrapOr([])` to degrade, `.isErr()` to branch, `.match` to report. Avoid a
wrapper that degrades to `null`/`false`: it hides a real backend error as "not
wired in browser". **Browser dev is `NotInTauri`, not a failure** — test with
`NotInTauri.is(e)`, never `e._tag === "…"` (oxlint rejects it), and don't toast
it. **Fire-and-forget is safe by construction**: an ignored `Result` can't
produce an unhandled rejection, so `void invoke(…)` needs no `.catch` — the hot
PTY-write path relies on it, and a `.catch` on an `invoke` is dead code. For
display use **`errorMessage(e)`, not `String(e)`**: Tauri rejects with a bare
string, which `String()` renders as `"[object Object]"`.

Two boundaries keep a *throwing* contract because a foreign interface demands it:
`lib/monaco-fs.ts` (monaco's `IFileSystemProvider`) and `lib/lsp.ts`
(vscode-jsonrpc's rejecting `write`). Translate `Err` → throw there only;
`.claude/hooks/guard-better-result.sh` flags drift. There is no `mock-data.ts`
either: each module owns its browser-dev fallback (`mockSnapshot` in
`lib/data.ts`, `mockView` in `lib/slack.ts`), gated on `!isTauri()`.

## Shortcuts registry validates at build time

`defineShortcuts`/`parseKeys` (`lib/shortcuts.tsx`) throw at module-eval time on
a bad spec or duplicate id, so a typo'd shortcut fails the build. Every binding
that fires records `shortcut.<id>`, and every *click target doing the same thing
as a binding* must record `mouse.<id>` via `mouseAction(id, screen)`
(`lib/shortcut-coach.ts`) instead of a plain `uiAction` — that pair is the whole
input to the keyboard-habit score (`tt-telemetry/src/keyboard.rs`) and the "⌘B
does that" toast. Only exact twins: a near-twin scored as a missed keystroke
makes the number lie, and palette items score as neither. `allowInEditable` is
likewise two-sided, working only if the owning component *also* checks
`matchesEditableOverride` to yield the keystroke rather than consume it
(`components/terminal-view.tsx`); it is gated behind
`agentboard.shortcutsWorkInTerminal` via `useShortcutsWorkInTerminal`, refreshed
on window focus and on `tt:settings-saved`, so a save propagates immediately.

**On mac, `mod` is ⌘ but a shift-bearing chord also answers to Ctrl+Shift**, so
one spelling drives both platforms and no external remapper is needed — the same
alias in `lib/term-protocol.ts` covers Ctrl+Shift+C/V. It stops at shift on
purpose: bare Ctrl is the shell's (⌃C is SIGINT, ⌃D is EOF), which is also why a
mac Ctrl chord no binding claims never matches on its main key alone.

## A pane has no PTY until it is rendered

Terminal rendering is a custom protocol, not xterm.js: `lib/term-protocol.ts`
defines the `terminal://frame` wire shape (dirty-row diffs, packed colors, style
bits) mirroring the Rust `tt-vt` crate, plus the DOM-key→escape encoder and
wide-char handling, so a new terminal feature threads through the Rust frame
struct and this file in lockstep
([`tt-vt/CLAUDE.md`](../../crates/tt-vt/CLAUDE.md)). `term_start` runs from
`TerminalView`'s mount effect and the screen renders only
the **active folder's active window** — so a session can exist in the rail, even
report agent-running (the watcher reads Claude's on-disk state, not the PTY),
while no shell exists. Anything writing to a PTY must `selectSession(folderDir,
id)` then `await waitForFirstFrame(id)`; `termWriteRetry` covers only the few
hundred ms before `term_start` registers the id, not a never-mounted pane. **A
write to an unmounted pane resolves `Err`** and, unchecked, appears to work while
doing nothing — hence every `SessionActions` lifecycle action takes `folderDir`,
including `stopClaude`/`compactClaude`, whose triggers render for *every* folder.
Restoring several sessions must drain **serially** (select, await frame, write,
next): only one folder is active at a time, so concurrent requests leave every
folder but the last with a placed-but-never-started pane.

Relatedly, **a pane that owns a process is pooled; one that owns a view is not.**
`PaneGrid` renders only the active folder's active window, so a conditionally
rendered pane unmounts the moment you click another folder — fine for
diff/files/preview (refetch on mount, own nothing), unacceptable for a terminal
and its shell, which render from a flat pool of *every* such pane in *any*
window, merely `hidden` elsewhere, so unmount means "really closed" and the
unmount effect can kill the process. **A new pane kind that owns a process or
accumulates state must join the pool and keep its state outside the component.**
Chrome (`browser-pane.tsx`) is the near miss: it owns a browser process, but that
lives in Rust, so the component is only a view and stays conditional. Jarvis
(`jarvis-pane.tsx`) isn't pooled either, since unmounting retires its Bevy
renderer rather than destroying it — but its body is a compositor surface *above*
the webview, so `hidden` on an ancestor is invisible to it and screen switches
must push down `visible={false}`.

## Clickable rows can't be `<button>`s

Radix's `Checkbox`, `Switch`, `RadioGroupItem` and `*Trigger` render real
`<button>`s, and a `<button>` may not contain interactive descendants. Checkbox
row → `<label htmlFor>` wrapping the `Checkbox` (`components/resume-picker.tsx`).
Inline rename → render *either* the input *or* the chip button, never nested. Row
with trailing actions → action buttons as *siblings* in a flex row, only the
identity cluster inside the button. A `stopPropagation` on a child of a clickable
parent means the nesting is wrong. React reports these only at **runtime** and
nothing else here sees them: no linter, `tsc` doesn't model the DOM, vitest runs
in node with no renderer. `node scripts/drive.mjs console` is the check.

## The rail, and animation

Two areas with rules of their own, and only when you are inside them: the rail is
**five files split by what a row *is*** (a new row kind gets a sixth, not a grown
one) and boxes a control or an alert but never a fact; animation is **`motion`
for enter/exit of backend-snapshot lists, `tw-animate-css` for everything else**,
and the choice is mechanical. Read
**[docs/CLIENT-RAIL-AND-MOTION.md](../../docs/CLIENT-RAIL-AND-MOTION.md)** before
touching either.

## Testing convention: logic-only

Logic tests (`*.test.ts`) run in the fast Node env. Components are deliberately
thin, so most branching logic lives in pure `lib/*.ts` functions testable without
a DOM (`workspace-persistence.ts` exists solely to make tab-restore testable) —
prefer that seam. Render tests (`*.test.tsx`) cover only what a pure function
can't, that a screen mounts without throwing, opting into jsdom per-file
(`// @vitest-environment jsdom`) through `src/test/render.tsx`. **The backend seam
is jsdom itself:** no `__TAURI_INTERNALS__`, so every `invoke` returns
`NotInTauri` and each component paints its colocated browser-dev fallback. Stub
there, never mock component internals.

**A green test run still says little about a *correct* render.** The
authoritative signal for a runtime React complaint (invalid DOM nesting, bad hook
order) is the page's own console, buffered under `VITE_WDIO`
(`lib/wdio-console.ts`): every `scripts/drive.mjs` verb prints a console-error
summary and `drive.mjs console` dumps it, exiting non-zero on real errors. Verify
UI/IPC by driving the shell; a change made without reading that output is
unverified.
