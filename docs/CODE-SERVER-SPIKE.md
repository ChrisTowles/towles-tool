# code-server as the editor — spike findings

Can [coder/code-server](https://github.com/coder/code-server) — a real VS Code
server — replace the in-webview Monaco editor
([`lib/monaco.ts`](../apps/client/src/lib/monaco.ts) over
`@codingame/monaco-vscode-api`)? Built as a swap-in behind
**Settings → Agentboard → "code-server editor (spike)"**: with it on, the Files
pane renders a code-server workbench instead of Monaco. Everything else — the
diff pane, the rail, the terminals — is untouched.

**It works. It is not the replacement.** Measured on Linux/WebKitGTK against
code-server 4.133.0 (Code 1.133.0), 2026-08-20.

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

## What it gets right

The full workbench renders and is interactive in WebKitGTK: explorer with git
decorations, SCM view, command palette, extension marketplace (Open VSX),
integrated terminal, problems, timeline. The extension host activates
`vscode.git` on boot, so source control is the real one. `anthropic.claude-code`
**is** on Open VSX (2.1.238), so the official Claude Code extension is
installable inside the pane.

That is the whole argument for it: extensions and the parts of VS Code we have
not rebuilt, for free, forever, with no `@codingame` prerelease pin to track.

## What it costs

| | Monaco (today) | code-server |
| --- | --- | --- |
| Memory | ~300 MB, in `tt-app` | **+978 MB across 7 node processes** |
| Disk | ~16 MB of JS in the bundle | **740 MB unpacked, outside it** |
| Cold start | in-process, lazy | ~5 s to a usable workbench |
| Ships how | in the Tauri bundle | a separate install, or a 740 MB bundle |

Measured with one folder open and one pane. A second pane is another iframe, not
another server — the process cost is per app instance, not per checkout.

## What breaks, and why it is structural

The iframe is a cross-origin document. That single fact takes out most of the
integration:

- **The Claude Code selection bridge dies.** `ide_set_selection` is called from
  Monaco's `onDidChangeCursorSelection` in `code-viewer.tsx`; there is no such
  callback to hook, and the parent cannot read a cross-origin selection. Select
  code in the pane and nothing reaches the prompt — the one behavior
  [CLAUDE-CODE-IDE.md](CLAUDE-CODE-IDE.md) exists for. The diff pane still
  provides it, being untouched by the swap.
- **`openFile` becomes a no-op.** The interception in `ide.rs` emits an event the
  Files pane consumes; the iframe has no way to receive it. code-server's own
  `VSCODE_IPC_HOOK_CLI` socket (`/run/user/<uid>/vscode-ipc-*.sock`) is the only
  door in, and finding the right one means matching a uuid out of its logs.
- **Every app shortcut is dead while the editor has focus** — keydown in a
  cross-origin frame never reaches the parent document. The palette, pane
  navigation, `Ctrl+Shift+W`: all of it stops at the frame boundary.
- **`drive`/`e2e` go blind.** Selectors fail cross-origin and WebDriver's
  synthetic input does not reach the subframe (verified: frame-switch returns
  success, element lookup then throws `SecurityError`; a `Ctrl+P` through
  `/actions` produced nothing). Every UI check we have for the editor stops
  working, in a repo whose rule is that a green test says little and driving the
  shell is the proof.
- **The diff pane has no path across.** Hunk-level stage/unstage rides VS Code's
  `DiffEditorGutter` through our own menu registration (#613). Reproducing that
  inside code-server means shipping an extension, not calling an API.

Two smaller ones: the extension host is reachable from any local process (auth
is off), and this Code build bundles Copilot chat — an agent panel we did not
put there, in an app whose whole point is the agents we did.

## Verdict

Feasible, and not worth the swap. It buys extensions and pays with the
integration that makes this an agent surface rather than a worse VS Code — and
[CLAUDE.md](../CLAUDE.md)'s test is whether a feature widens the channel between
the human and the agents. This narrows it.

Worth keeping the flag for the one thing it answers well: "I need real VS Code
for ten minutes" without leaving the window. If it ever becomes the editor, the
selection bridge has to move inside — `anthropic.claude-code` in the pane,
serving its own lockfile — and then two IDE servers compete for the same
`CLAUDE_CODE_SSE_PORT` and ours wins, so that is a rewrite of the bridge, not a
port of it.

**Known gap:** `PR_SET_PDEATHSIG` reaps the server when the app is killed on
Linux; macOS has no equivalent, so a `SIGKILL`ed app there leaks one tree.
