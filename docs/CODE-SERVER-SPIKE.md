# code-server as the editor — spike findings

Can [coder/code-server](https://github.com/coder/code-server) — a real VS Code
server — replace the in-webview Monaco editor
([`lib/monaco.ts`](../apps/client/src/lib/monaco.ts) over
`@codingame/monaco-vscode-api`)? Built as a swap-in behind
**Settings → Agentboard → "code-server editor (spike)"**: with it on, the Files
pane renders a code-server workbench instead of Monaco. Everything else — the
diff pane, the rail, the terminals — is untouched.

**It works, and it is the better shape.** Measured on Linux/WebKitGTK against
code-server 4.133.0 (Code 1.133.0), 2026-08-20.

## The baseline that matters

Not "Monaco versus code-server". The thing this app exists to replace is
**switching between many VS Code windows**, and code-server is the only option
here that keeps being VS Code while collapsing N windows into N panes. One
server, one Node runtime, one extension install, one settings file — and one
browser engine, our webview, instead of an Electron shell per window.

That reframes the cost table below: the question is not what a workbench costs,
it is what the *fourth* one costs.

## How it's wired

- `crates/tt-codeserver` — Tauri-free launcher. Finds the binary
  (`TT_CODE_SERVER_BIN`, PATH, then the install script's prefixes), spawns it
  with `--bind-addr 127.0.0.1:0`, and parses the OS-assigned port off its first
  log line. No port claim in `.env`: the port is never ours to choose, same rule
  as `term_start`'s IDE server.
- `crates-tauri/tt-app/src/codeserver.rs` — one process per app instance,
  started lazily on the first pane. A workbench is just `/?folder=<dir>`, so N
  panes across N checkouts are N iframes against one server.
- `apps/client/src/components/code-server-pane.tsx` — the iframe, keyed on URL.
- State lives at `tt_config::code_server_user_data_dir()` (instance-scoped: two
  checkouts would contend on one `code-server-ipc.sock`) and
  `code_server_extensions_dir()` (shared, like the Chrome profile).

Auth is `none` and the config file is ours, so the user's
`~/.config/code-server/config.yaml` — which can pin a bind address or re-enable
password auth — never reaches this process. Loopback-only, same posture as
[MCP](MCP.md).

**Framing is not a problem.** Unlike the Chrome pane ([why not the iframe
preview](BROWSER-PANE.md)), code-server ships no `X-Frame-Options` and its CSP
has no `frame-ancestors`, so the workbench frames cleanly from `tauri://` and
its own WebSocket is same-origin to the frame. No headless browser needed.

## What it costs, per open checkout

One shared server, workspaces added one at a time, whole process tree:

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

- **The Claude Code selection bridge.** `ide_set_selection` hangs off Monaco's
  cursor callback; there is none to hook, and the parent cannot read a
  cross-origin selection. Highlight-to-prompt stops working in this pane. The
  diff pane still has it, being untouched by the swap. **Accepted** — the
  workbench's own agent surfaces cover the same ground.
- **`openFile` from the MCP tool** — same reason: the event has no receiver.
- **The app's keyboard, while the editor has focus.** Keydown in a cross-origin
  frame never reaches the parent, so the palette and pane navigation stop at the
  frame boundary. This is the live cost of adoption, and the one to design for.
- **`drive`/`e2e` over the editor.** Selectors fail cross-origin and WebDriver's
  synthetic input does not reach the subframe (verified: the frame switch reports
  success, the element lookup then throws `SecurityError`, and a `Ctrl+P` through
  the actions API produced nothing).
- **Monaco does not leave.** The diff pane's hunk-level stage/unstage rides VS
  Code's `DiffEditorGutter` through our own menu registration (#613), so the
  bundle and its `@codingame` pin stay until that moves too.

## The door back in

Everything above is recoverable through **an extension inside the pane**, not
through the page. The app's MCP HTTP server already admits exactly that caller
and refuses the other one — verified against a live instance:

| Caller | Sends | Result |
| --- | --- | --- |
| Extension host (Node) | no `Origin` | **200** |
| The workbench page itself | browser `Origin` | **403** |

So a small extension we ship into the pane can call back into the app for
`openFile`, selection relay, or a command bound to one of our chords — the
keyboard problem included. `anthropic.claude-code` is itself on Open VSX
(2.1.238), so the official bridge is installable in the pane if it is ever wanted
back. Note that it would then serve its own lockfile while our terminals stamp
`CLAUDE_CODE_SSE_PORT` at ours, and ours wins the pairing.

**Known gap:** `PR_SET_PDEATHSIG` reaps the server when the app is killed on
Linux; macOS has no equivalent, so a `SIGKILL`ed app there leaks one tree.
