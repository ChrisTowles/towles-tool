# code-server as the editor

The Files pane is a real VS Code: [coder/code-server](https://github.com/coder/code-server)
running as a child of the app, one workbench per checkout, each in an iframe.
Monaco (`@codingame/monaco-vscode-api`, [`lib/monaco.ts`](../apps/client/src/lib/monaco.ts))
stays only for the diff pane, whose hunk-level staging rides VS Code's
`DiffEditorGutter` through our own menu registration (#613).

## The baseline that matters

Not "Monaco versus code-server". The thing this app exists to replace is
**switching between many VS Code windows**, and code-server is the only option
that keeps being VS Code while collapsing N windows into N panes. One server,
one Node runtime, one extension install, one settings file — and one browser
engine, our webview, instead of an Electron shell per window.

That reframes the cost table below: the question is not what a workbench costs,
it is what the *fourth* one costs.

## How it's wired

- `crates/tt-codeserver` — Tauri-free launcher. Finds the binary
  (`TT_CODE_SERVER_BIN`, PATH, then the install script's and Homebrew's
  prefixes), spawns it with `--bind-addr 127.0.0.1:0`, and parses the
  OS-assigned port off its first log line. No port claim in `.env`: the port is never ours to choose, same rule
  as `term_start`'s IDE server.
- `crates-tauri/tt-app/src/codeserver.rs` — one process per app instance,
  started lazily on the first pane. A workbench is just `/?folder=<dir>`, so N
  panes across N checkouts are N iframes against one server.
- `apps/client/src/components/code-server-pane.tsx` — the iframe, keyed on URL.
- State lives at `tt_config::code_server_user_data_dir()` (instance-scoped) and
  `code_server_extensions_dir()` (shared, like the Chrome profile). The window
  registry socket is passed explicitly (`--session-socket`, a pid-named path in
  temp via `code_server_session_socket()`): its default under the user data dir
  overflows `sun_path`'s 108 bytes, and code-server only warns when the bind
  fails.

Auth is `none` and the config file is ours, so the user's
`~/.config/code-server/config.yaml` — which can pin a bind address or re-enable
password auth — never reaches this process. Loopback-only, same posture as
[MCP](MCP.md).

**Framing is not a problem.** Unlike the Chrome pane ([why not the iframe
preview](BROWSER-PANE.md)), code-server ships no `X-Frame-Options` and its CSP
has no `frame-ancestors`, so the workbench frames cleanly from `tauri://` and
its own WebSocket is same-origin to the frame. No headless browser needed.

## Opening a file from outside the pane

`tt open src/main.rs:42`, a `path:line` link in a terminal and Claude Code's
`openFile` all end in `filesOpenRequests` on the Agentboard screen, as before.
From there the pane has two ways in, because the iframe is cross-origin and the
page can't reach the workbench:

- **A pane that doesn't exist yet** gets the file on its URL. VS Code's web
  entry reads `?payload=[["openFile","vscode-remote://<host>/<path>:<line>"],["gotoLineMode","true"]]`
  and opens it as the workbench boots (`tt_codeserver::workbench_url`).
- **A running workbench** is told over code-server's own session socket
  (`tt_codeserver::reveal`) — the route `code -r` takes from an integrated
  terminal. `GET /session?filePath=` on the registry socket names the VS Code
  IPC socket of the window whose folder contains the file, and
  that socket takes the same `{"type":"open"}` request the `code` CLI sends.
  Both are HTTP/1.0 over Unix sockets, ~60 lines, pinned by a test with fake
  sockets at both ends.

The registry answers with the *most recent* window when none matches — `code
-r`'s semantics too — so a reveal aimed at a pane still booting its workbench,
while another checkout's is up, can land in the other one. The URL route covers
the common case (the request created the pane); the window is a few seconds.

## What it costs, per open checkout

One shared server, workspaces added one at a time, whole process tree. Measured
on Linux/WebKitGTK against code-server 4.133.0 (Code 1.133.0), 2026-08-20:

| Open checkouts | Resident | Processes | Marginal |
| --- | --- | --- | --- |
| 0 (server idle) | 148 MB | 2 | — |
| 1 | 1,073 MB | 7 | +925 MB |
| 2 | 1,606 MB | 10 | +533 MB |
| 3 | 1,912 MB | 13 | +306 MB |
| 4 | 2,268 MB | 16 | +356 MB |

**The first workbench is the expensive one.** After it, a checkout costs
~300–530 MB and three processes — an extension host, a file watcher, a shared
worker — and the size of the repo moves that number more than anything else.
Four checkouts live in 2.3 GB. Four VS Code desktop windows do not.

Disk is the one number that is worse and stays worse: **740 MB unpacked**, and
it cannot ride the Tauri bundle sensibly, so it is a separate install
(`TT_CODE_SERVER_BIN` overrides the lookup). Cold start is ~5 s to a usable
workbench; every pane after that is an iframe against a warm server.

## What it gives up

The iframe is a cross-origin document, and that one fact costs:

- **The Claude Code selection bridge, in this pane.** `ide_set_selection` hung
  off Monaco's cursor callback; there is none to hook, and the parent cannot
  read a cross-origin selection. The diff pane still streams its selection.
  **Accepted** — the workbench's own agent surfaces cover the same ground.
- **`openFile`'s text anchors.** The tool's `startText`/`endText` selection has
  no receiver; the file opens, the range doesn't select.
- **The app's keyboard, while the editor has focus.** Keydown in a cross-origin
  frame never reaches the parent, so the palette and pane navigation stop at the
  frame boundary. This is the live cost, and the one to design for.
- **`drive`/`e2e` over the editor.** Selectors fail cross-origin and WebDriver's
  synthetic input does not reach the subframe (verified: the frame switch
  reports success, the element lookup then throws `SecurityError`, and a
  `Ctrl+P` through the actions API produced nothing).

## The door back in

Everything above is recoverable through **an extension inside the pane**, not
through the page. The app's MCP HTTP server already admits exactly that caller
and refuses the other one — verified against a live instance:

| Caller | Sends | Result |
| --- | --- | --- |
| Extension host (Node) | no `Origin` | **200** |
| The workbench page itself | browser `Origin` | **403** |

So a small extension we ship into the pane can call back into the app for
selection relay, or a command bound to one of our chords — the keyboard problem
included. `anthropic.claude-code` is itself on Open VSX (2.1.238), so the
official bridge is installable in the pane if it is ever wanted back. Note that
it would then serve its own lockfile while our terminals stamp
`CLAUDE_CODE_SSE_PORT` at ours, and ours wins the pairing.

**Known gap:** `PR_SET_PDEATHSIG` reaps the server when the app is killed on
Linux; macOS has no equivalent, so a `SIGKILL`ed app there leaks one tree.
