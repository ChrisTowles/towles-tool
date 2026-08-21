# Claude Code IDE integration

Towles Tool acts as an **IDE** for Claude Code sessions in its embedded
terminals: a session knows which checkout it is in, answers for that folder's
workspace and diagnostics, and its `openFile` lands in the pane beside it.
Below: the reverse-engineered wire protocol, then how the app implements it.

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
  IDE server, and which one consumes a given notification is not ours to
  predict. A single-client server (VS Code's historical behavior) starves the
  daemon. Broadcast to all authenticated connections.
- The CLI may ask once per session ("`/ide` → Towles Tool", then auto-connect);
  with auto-connect on it attaches whenever `CLAUDE_CODE_SSE_PORT` matches.

### Notifications, IDE → CLI (no `id`)

Lines and characters are **0-based** throughout. **Only `diagnostics_changed` is
sent** — the editor is code-server, in a cross-origin iframe, so nothing on this
side can see a selection. The other two are recorded as the wire shapes an
in-workbench extension would have to produce to bring the feature back.

`selection_changed` is the ambient "user is looking at this" signal, sent on
every selection change, debounced 300 ms; the CLI caches the latest one and
attaches it to the next prompt (the "user selected lines X–Y of file Z" context
in transcripts).

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

`crates-tauri/tt-app/src/ide.rs` runs one `IdeServer` per embedded terminal over
`crates/tt-ide`, the Tauri-free protocol core (lockfile schema, JSON-RPC
dispatcher, notification builders). The app advertises a deliberately small
slice of the table above — **the editor half of the protocol is code-server's
job now**, and the Files pane is a cross-origin workbench the parent cannot
reach into ([CODE-SERVER.md](CODE-SERVER.md)).

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
- **Status surface.** Connect/disconnect emits `ide://status`
  (`{termId, connected}`) behind the panes' "✦ claude" badge.
- **Advertised tools**: `getWorkspaceFolders`, `getDiagnostics` and `openFile`,
  and nothing else. `getDiagnostics` serves real cargo/tsc results from the app's
  DiagHub (`crates-tauri/tt-app/src/diagnostics.rs`). `openFile` is intercepted
  in the app shell before the pure dispatcher and opens the file in that
  checkout's Files pane (the `startText`/`endText` anchors have no receiver in a
  cross-origin workbench) — **but only when `makeFrontmost` isn't `false`**,
  which is the one shape the CLI actually sends, since its diagnostics tracker
  calls `openFile` before every file it edits just so the "IDE" holds the
  document, and honoring that popped a files pane on screen at every agent edit.
- **What is deliberately not advertised**, because the app has no editor of its
  own to back it: `openDiff` (the session reviews its edits in the terminal),
  the selection and dirty-state tools, and the diff-tab management that only
  `openDiff` needs. Unadvertised is the supported way to say no — the CLI never
  calls them.
