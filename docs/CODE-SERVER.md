# code-server as the editor

The Files pane is a real VS Code: [coder/code-server](https://github.com/coder/code-server)
running as a child of the app, one workbench per checkout, each in an iframe.
It is the app's **only** editor — the Monaco diff pane and
`@codingame/monaco-vscode-api` are gone, diffs and hunk staging with them.

## The baseline that matters

Not "Monaco versus code-server". This app exists to replace **switching between
many VS Code windows**, and code-server is the only option that keeps being VS
Code while collapsing N windows into N panes: one server, one Node runtime, one
extension install, one settings file, one browser engine instead of an Electron
shell per window. So the question below is not what a workbench costs, it is what
the *fourth* one costs.

## How it's wired

- `crates/tt-codeserver` — Tauri-free launcher. Finds the binary
  (`TT_CODE_SERVER_BIN`, the app's own install, PATH, then the install script's
  and Homebrew's prefixes), spawns it with `--bind-addr 127.0.0.1:0`, and parses
  the OS-assigned port off its first log line. No port claim in `.env`: the port is never ours to choose, same rule
  as `term_start`'s IDE server.
- `crates-tauri/tt-app/src/codeserver.rs` — one process per app instance,
  started lazily on the first pane. A workbench is just `/?folder=<dir>`, so N
  panes across N checkouts are N iframes against one server.
- `crates/tt-codeserver/src/install.rs` — the copy the app provisions when the
  machine has none ([Installing itself](#installing-itself)).
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
- **A diff** goes neither way. The CLI's `open` does file-vs-file only and the
  web payload has no command lever, so VS Code's *git* diff — `git:` URIs,
  staging gutters, decorations — can only be asked for from inside the workbench.
  The Agentboard's uncommitted chip invokes `code_server_show_changes`, which
  reaches the bridge extension to run VS Code's own multi-file diff commands.
  There is one per SCM group and none spanning them, so both halves of the chip's
  one number open, `git.viewStagedChanges` pinned because `git.viewChanges` would
  otherwise replace it in the same preview slot. That chip is usually clicked with
  no server running at all, so `show` polls through the server starting, the
  workbench booting and git's first scan — which the extension reports as `503`
  rather than opening a diff of nothing.

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

Disk is the one number that is worse and stays worse: **740 MB unpacked**, which
cannot ride the Tauri bundle sensibly — hence the install below. Cold start is
~5 s to a usable workbench; every pane after that is an iframe against a warm
server.

## Installing itself

Nothing to install by hand. The first Files pane on a machine with no
code-server downloads one, the way VS Code fetches its own remote server: the
pinned release tarball, checked against a SHA-256 pinned beside the version in
`install.rs`, unpacked into `tt_config::code_server_install_dir()` — *shared*, so
740 MB is a machine cost, and version-scoped, so a bumped pin installs beside a
running server rather than over it.

The pane shows it: `code-server://install` carries phase and bytes, so the
several minutes are a bar, not a spinner. Scratch is removed however the install
ends, and two instances racing a version resolve by rename. An existing
code-server (PATH, Homebrew, the install script's prefix) is used as-is;
`TT_CODE_SERVER_BIN` beats everything. Pre-warm with `cargo run -p tt-codeserver
--example provision`.

First launch also seeds `User/settings.json` with a dark theme, once — past that
the file is the user's, edited in the workbench's own Settings editor.

## What it gives up

The iframe is a cross-origin document, and that one fact costs:

- **The Claude Code selection bridge.** `ide_set_selection` hung off Monaco's
  cursor callback; there is none to hook, and the parent cannot read a
  cross-origin selection. `tt-ide` no longer advertises the selection tools or
  `openDiff` ([CLAUDE-CODE-IDE.md](CLAUDE-CODE-IDE.md)). **Accepted**, and
  recoverable through the bridge below.
- **`openFile`'s text anchors.** The tool's `startText`/`endText` selection has
  no receiver; the file opens, the range doesn't select.
- **The app's keyboard, while the editor has focus.** Keydown in a cross-origin
  frame never reaches the parent, so the palette and pane navigation stop at the
  frame boundary. This is the live cost, and the one to design for.
- **`drive`/`e2e` over the editor.** Selectors fail cross-origin and WebDriver's
  synthetic input does not reach the subframe (verified: the frame switch
  reports success, the element lookup then throws `SecurityError`, and a
  `Ctrl+P` through the actions API produced nothing).

## The bridge extension

Everything above is recoverable from **inside** the pane rather than from the
page, and one extension now ships there: `tt-bridge`, written into the shared
extensions dir at launch by `tt_codeserver::bridge`. It runs in the remote
extension host, so it sees `file:` URIs and can listen on a unix socket, and the
Rust side POSTs to it in the same HTTP/1.0 style as the reveal path. The socket
is named for a hash of the folder, one per *window*: a single code-server serves
every checkout and all its extension hosts inherit the same env, so the folder is
the only thing that distinguishes them.

Registering it is the part with a trap. `scanUserExtensions` reads the profile's
`extensions.json`, never the directory listing, so a folder dropped in is simply
invisible. `install` rewrites only our own entry and leaves other publishers'
alone, because that manifest is shared across every checkout.

The same door fits the rest. The app's MCP HTTP server already admits the
extension host and refuses the page — verified against a live instance:

| Caller | Sends | Result |
| --- | --- | --- |
| Extension host (Node) | no `Origin` | **200** |
| The workbench page itself | browser `Origin` | **403** |

So selection relay, or a command bound to one of our chords, is this mechanism
with a different payload. `anthropic.claude-code` is itself on Open VSX (2.1.238)
if the official bridge is ever wanted back — it would serve its own lockfile
while our terminals stamp `CLAUDE_CODE_SSE_PORT` at ours, and ours wins.

**Known gap:** `PR_SET_PDEATHSIG` reaps the server when the app is killed on
Linux; macOS has no equivalent, so a `SIGKILL`ed app there leaks one tree.
