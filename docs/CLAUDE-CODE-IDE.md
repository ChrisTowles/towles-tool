# Claude Code IDE integration

Towles Tool acts as an **IDE** for Claude Code sessions in its embedded
terminals: selecting lines in the file viewer or the diff pane feeds that file +
line range to the `claude` session in the same folder, exactly like highlighting
code in VS Code does. Below: the reverse-engineered wire protocol, then how the
app implements it.

> Verified against the VS Code extension `anthropic.claude-code` 2.1.207 and
> Claude Code CLI 2.1.208 (2026-07). It is a private protocol — re-verify
> against the shipped extension when something breaks.

## The protocol

The model is inverted from what you might expect: **the IDE hosts a WebSocket
MCP server; the Claude Code CLI is the client** that dials in, discovering it by
env var or cwd from a lockfile the IDE writes.

### Discovery and connection

- The IDE picks a free localhost port, starts a WebSocket server on
  `127.0.0.1:<port>`, and writes `~/.claude/ide/<PORT>.lock` (file mode 0600,
  dir 0700). **The port is the filename** — the CLI parses it from
  `basename.replace(".lock")`; there is no port field in the JSON, whose
  camelCase shape is `{"pid", "workspaceFolders": ["/abs/dir"], "ideName",
  "transport": "ws", "runningInWindows": false, "authToken": "<uuid>"}`. It is
  deleted on shutdown; a crash's leftovers fail the CLI's pid-liveness check.
- The IDE exports `CLAUDE_CODE_SSE_PORT=<port>` into the shell it spawns
  (`ENABLE_IDE_INTEGRATION` no longer exists). A lockfile is accepted when the
  port equals that variable — which skips all other checks — **or** the CLI's
  cwd is at/under one of `workspaceFolders` *and* the lockfile `pid` is alive
  and related to the CLI process.
- Transport is JSON-RPC 2.0 over WebSocket, one JSON object per text frame,
  subprotocol `mcp` (the CLI requests it; the server must echo it). The CLI
  authenticates with an `x-claude-code-ide-authorization: <authToken>` header on
  the upgrade request — mismatch closes with code 1008 — then runs the standard
  MCP handshake: `initialize`, `notifications/initialized`, `tools/list`.
- **Serve connections concurrently.** Claude Code >= 2.1.x is multi-process: the
  interactive TUI *and* its session daemon (`claude daemon run`) each dial the
  IDE server, and the one that consumes selection context is daemon-run. A
  single-client server (VS Code's historical behavior) starves the daemon and
  selections never reach prompts. Broadcast to all authenticated connections.
- The CLI may ask once per session ("`/ide` → Towles Tool", then auto-connect);
  with auto-connect on it attaches whenever `CLAUDE_CODE_SSE_PORT` matches. Only
  foreground sessions consume selection context — headless ones do not.

### Notifications, IDE → CLI (no `id`)

Lines and characters are **0-based** throughout. `selection_changed` is the
ambient "user is looking at this" signal, sent on every selection change,
debounced 300 ms; the CLI caches the latest one and attaches it to the next
prompt (the "user selected lines X–Y of file Z" context in transcripts).

```json
{"jsonrpc":"2.0","method":"selection_changed","params":{
  "text":"<selected text or empty>","filePath":"/abs/f.rs","fileUrl":"file:///abs/f.rs",
  "selection":{"start":{"line":10,"character":0},"end":{"line":12,"character":0},"isEmpty":false}}}
```

`at_mentioned` — the explicit "send this to Claude" gesture, becoming an
`@file#Lx-y` reference in the prompt; `lineStart`/`lineEnd` are omitted when
there is no selection:
`{"method":"at_mentioned","params":{"filePath":"/abs/f.rs","lineStart":10,"lineEnd":12}}`.
`diagnostics_changed` — `{"params":{"uris":["file:///..."]}}` — only signals
staleness; the diagnostics themselves are pulled via `getDiagnostics`.

### Tools, CLI → IDE (`tools/call`)

All results use the MCP text-content envelope
`{"content":[{"type":"text","text":"<usually JSON>"}]}`. Tools not advertised in
`tools/list` are never called — the CLI degrades gracefully (no `openDiff` →
terminal diffs). The full VS Code set:

| Tool | Input | Notes |
| --- | --- | --- |
| `getCurrentSelection` / `getLatestSelection` | `{}` | `{success,text,filePath,fileUrl,selection}` of the active editor / the last cached one |
| `getWorkspaceFolders` / `getOpenEditors` | `{}` | `{folders:[{name,uri,path}]}` / `{tabs:[{uri,isActive,label,…}]}` |
| `getDiagnostics` | `{uri?}` | `[{uri,linesInFile,diagnostics:[…]}]`, 0-based |
| `openFile` | `{filePath,preview?,startText?,endText?,…}` | Focus a file, select a range |
| `openDiff` | `{old_file_path,new_file_path,new_file_contents,tab_name}` | Blocking accept/reject of an edit |
| `close_tab` / `closeAllDiffTabs` | `{tab_name}` / `{}` | Diff-tab management |
| `checkDocumentDirty` / `saveDocument` | `{filePath}` | Editor dirty state (`executeCode`, `{code}`, is Jupyter-only) |

## Towles Tool's implementation

Monaco selection in `apps/client` → `ide_set_selection`/`ide_at_mention` (Tauri
commands, routed by folder dir) → `crates-tauri/tt-app/src/ide.rs`, one
`IdeServer` per embedded terminal → `crates/tt-ide`, the Tauri-free protocol
core (lockfile schema, JSON-RPC dispatcher, notification builders).

- **One server per terminal.** `term_start` binds `127.0.0.1:0` (OS-assigned
  port — never hardcoded, per the multi-task rule), writes
  `~/.claude/ide/<port>.lock` with `workspaceFolders = [terminal cwd]`, and
  stamps `CLAUDE_CODE_SSE_PORT` into that PTY's env, so a `claude` started in the
  pane pairs with exactly that pane. The stamp happens *after*
  `tt_exec::scrub_app_instance_env`, which strips any inherited value (issue
  #39's nested session-identity scrub).
- **Lifecycle.** The server task and lockfile die with the session: `term_kill`,
  a replacing `term_start` on the same id, and window teardown all drop the
  `IdeServer` handle, whose `Drop` removes the lockfile. Startup sweeps stale
  ones left by dead towles-tool processes.
- **Selection flow.** Monaco's `onDidChangeCursorSelection` — in
  `components/code-viewer.tsx` and `components/diff-monaco.tsx` (the modified
  side of each diff) — calls `ide_set_selection` (debounced client-side to VS
  Code's 300 ms) with the folder dir, file path, **1-based** line range and
  **0-based** character columns; the command converts lines to 0-based at the
  boundary, caches the selection per server (serving
  `getCurrentSelection`/`getLatestSelection`), and pushes `selection_changed` to
  every connected session rooted in that folder. Closing a file clears the cache,
  so a stale range can't ride the next prompt. **The text comes from the editor
  buffer, never from disk** — both surfaces are editable, and re-reading the file
  at those line numbers served whatever an unsaved insertion above the highlight
  had shifted into place (issue #309). That read is synchronous with the
  selection event, not inside the debounce, so a file switch can't dispose the
  model first.
- **Status surface.** Connect/disconnect emits `ide://status`
  (`{termId, connected}`) behind the panes' "✦ claude" badge.
- **Explicit @-mention.** Two gestures fire `ide_at_mention`: the selection
  chip's `@ send` button (or `⌘⇧A`) sends the highlighted range as
  `@file#L12-40`, the Files pane header's `@` button sends the whole file. The
  conversions live in `lib/ide-selection.ts` — notably that an empty selection
  means *whole file*, and a selection ending in column 1 of the next line doesn't
  count that line.
- **Advertised tools**: every tool in the table above except `executeCode`
  (notebooks) and `saveDocument` (the viewer surfaces dirty state instead).
  `getDiagnostics` serves real cargo/tsc results from the app's DiagHub
  (`crates-tauri/tt-app/src/diagnostics.rs`). The ones with app-side effects are
  intercepted in the app shell before the pure dispatcher: `openFile` focuses
  the Files tab (with `startText`/`endText` anchor selection) — **but only when
  `makeFrontmost` isn't `false`**, which is the one shape the CLI actually
  sends, since its diagnostics tracker calls `openFile` before every file it
  edits just so the "IDE" holds the document, and honoring that popped a files
  pane on screen at every agent edit. `openDiff` blocks the CLI's tool call on an
  in-app accept/reject review (Monaco DiffEditor; accept atomically writes the —
  possibly user-tweaked — contents and answers `FILE_SAVED`, reject answers
  `DIFF_REJECTED` + tab name).

### Open ends

- **LSP shipped, and is on probation.** `apps/client/src/lib/lsp.ts` +
  `crates-tauri/tt-app/src/lsp.rs` bridge rust-analyzer to Monaco over Tauri IPC
  (`lsp_send` down, `lsp://msg` up), one server following the active workspace,
  reporting `starting`/`ready`/`failed` through a chip in the Files pane header.
  Keep or cut it on that evidence, against two costs: `vscode/localExtensionHost`
  registers an initialize-time participant so it **cannot** be made lazy (every
  editor mount pays for it, even in a checkout with no `Cargo.toml`), and
  `monaco-languageclient` is a caret-pinned prerelease. Its markers land in
  Monaco but never reach `getDiagnostics`; wiring that up is unclaimed, as is
  `saveDocument`.
