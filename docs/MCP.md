# `tt-mcp` — the MCP server

The hand-rolled JSON-RPC MCP server and its transport, including the trust
boundary. Referenced from [CLAUDE.md](../CLAUDE.md)'s Architecture section.

hand-rolled JSON-RPC MCP server, **transport-free** (the same
split as `tt-ide`): `Dispatcher::dispatch_at` takes a request string and an
injected `now_ms` and returns a response string, so the whole tool surface
is unit-testable with no server to stand up. The transport is
`crates-tauri/tt-app/src/mcp_http.rs` — read that module's doc before
touching either half.

**It speaks MCP 2026-07-28 only.** That revision has no `initialize`
handshake and no session: every request names its protocol version in
`params._meta` (and, over HTTP, in the mirrored `MCP-Protocol-Version`,
`Mcp-Method` and `Mcp-Name` headers, which the dispatcher checks against the
body), `server/discover` answers with the one supported version, the caller's
identity for the call log comes from each request's own `clientInfo`, and
every result carries `resultType` plus `_meta.serverInfo`. A client that
opens with `initialize` — an older Claude Code, or Cursor as of 2026-07 —
gets a 400 whose message names the version, which is all the spec asks of a
modern-only server; there is no dual-era fallback. `tt open` and the MCP
screen's tool tester are the in-repo clients, and `tt_mcp` exports the
version, `_meta` keys and header names so they cannot drift. Statuses follow
the spec: an unknown method is a 404, a header mismatch or unsupported
version a 400 (`-32020`/`-32022`), and a tool's own `isError` answer a 200
(`mcp_http::status_for`). Tools: `task_list`, `task_status`, `task_create`
(a #339 board task in a tracked repo's swimlane, same store path as the
app's `store_add_task`), `task_summary`, `task_start`, `task_delete`,
`preview_file`, plus the calendar family `calendar_today`, `calendar_next`
and the push-model write `calendar_set`.
`task_summary` is how a finished agent leaves a record: it writes the
wrap-up onto the task's row (`summary`/`summary_at`, schema v17) instead of
into a PTY scrollback that dies with the worktree. It is a *separate column
from `notes` on purpose* — `notes` is the user's own context and
`task_prompt` feeds it into a `task_start` prompt, so a summary folded in
there would come back as instructions to the next session. It records only:
it never closes the task or touches the worktree, because confirming a task
is done is the user's job.
**`task_start` and `task_delete` are the two tools that cannot work from the
dispatcher alone**, and both enter through the injected `TaskHost`; a
dispatcher without one refuses rather than half-doing the job. `task_delete`
kills the task's panes and removes its worktree (the row itself is
*closed* with an optional `outcome` arg, not deleted — see the
task-removal bullet in Worktree tasks) via `tt-app`'s
`task::delete_task_blocking`. `task_start` is the inverse — it mints a
worktree for an existing card and launches an agent on the task's goal *plus
its notes* — and it is **asynchronous where `task_delete` blocks**: a pane
has no PTY until the frontend renders it and the goal is typed into that
PTY, so the host can only emit `task://start` for the frontend to run down
its normal `createTask` path (`apps/client/src/lib/task-start.ts` →
`screens/agentboard/use-task-creation.ts`). Hence `status: "starting"`, not
`"started"` — the tool genuinely cannot know. Don't "fix" this by minting the
worktree in Rust and leaving the launch to the frontend: that forks the
start path in two, and the frontend's half already encodes the
no-PTY-until-rendered and serial-drain rules the second copy would have to
restate.
**`preview_file` is the third host-backed tool, and the only one pointing
the other way**: an agent points at a file — Markdown rendered as prose, a
self-contained HTML artifact as the page it is, anything else as text — and
asks for it on screen in its own task's Preview pane. The pane **watches the
file** (`preview_watch_file`, one shared `MultiFileNotifier`) and re-reads on
every write, so an agent iterating on a plan updates what the user is looking
at without calling the tool again. Extension is what picks the surface, in
Rust, so a file mid-rewrite can't flip renderers under the user. It is the agent→human
half of the channel whose human→agent half already existed (draw on the
pane, send the annotated screenshot back), and the two share a surface
deliberately, so the user can circle a line of the agent's own plan and
reply to it. A hand-off like `task_start`, since only the frontend can
open a pane. **It routes by *caller*, not by path** — the request carries
the agent's `TT_SESSION_ID` in an `X-TT-Session` header, filled in by the
MCP client from the plugin's `.mcp.json` (`"${TT_SESSION_ID:-}"`, Claude
Code's env expansion) rather than by the model, and the frontend resolves
that session to the folder owning its pane. Path-prefix matching survives
only as the fallback for a caller with no session (a Claude Code session
started outside the app). Don't restore it as the primary: an agent's
natural place for a throwaway page is a scratch dir under no tracked
folder, which matches nothing and lands the page in whatever task is on
screen — one instance serves every session on the machine. Making the file's
location load-bearing also meant an agent had to know that and write
somewhere unnatural to be routed right; the terminal it is sitting in is
the fact that actually answers "whose pane is this?". The
delivery mechanics (path not bytes, the sandboxed `srcDoc` frame) are
documented at `tt-mcp`'s `PreviewHost` and
`crates-tauri/tt-app/src/preview.rs`. The broader
dashboard-read tools (`day_brief`, `needs_you`, `snapshot`,
PR/issue/DM/collector reads) were pruned in the 2026-07 tool-surface
review and have not returned.

**Security posture changed on 2026-07-20 — don't reason from the old
shape.** There is no bearer token and no `mcp.mutationsEnabled` gate; both
are gone, not merely defaulted. What guards writes is entirely the
transport's request admission: **any request carrying an `Origin` header is
refused** (browsers always send one, real MCP clients never do — the
DNS-rebinding mitigation) and **`Content-Type: application/json` is
required** (not a CORS-simple type, so a page can't dodge a preflight).
Loopback binding alone does *not* keep web pages out, which is why those
checks exist and why they're pure functions with direct tests. A
consequence worth knowing before debugging: **the app's own webview cannot
call the endpoint** — its `fetch` carries an `Origin` — so the MCP screen's
tool tester issues its request from Rust (`mcp_test_call`). Both crates'
module docs carry the full threat model.

Served **one per app instance**, each on its own `${tt:port 8787-8986}`
claim (`TT_MCP_PORT`) like every other port here — no exception to the
no-hardcoded-ports rule any more. App closed = that checkout's MCP down;
there is no headless fallback (the stdio server and `tt mcp serve` were
deleted). The plugin still ships a **static checked-in `.mcp.json`**,
because the port rides the environment rather than the file:
`"http://127.0.0.1:${TT_MCP_PORT:-8787}/mcp"`, expanded by Claude Code from
the stamp the app put on the terminal. Precedence for the app's own port is
process env → the checkout's rendered `.env` → settings `mcp.port`
(`mcp_http::resolve_port`, unit-tested). The pre-2026-07-26 shared-8787
singleton is described in the Worktree tasks section — read that before
proposing a shared port again; it cross-wired tool writes between
checkouts' boards.

**`file_open` is the same shape one step down**: reveal a path that already
exists in the caller's own Files pane (its VS Code workbench), where
`preview_file` renders a page the agent *authored*. Same `EditorHost`
hand-off, same session-first routing, and it lands on the route a terminal
file link and Claude Code's IDE `openFile` already take (`editor://open-file`
→ `apps/client/src/lib/editor-open.ts` → the screen's `filesOpenRequests` →
`code_server_reveal`).
One asymmetry with `preview_file` is deliberate: **here the path fallback is
a good guess**, because a file someone asked to read names its checkout,
which is what lets `tt open` work from a terminal with no `TT_SESSION_ID`.
It is also **the one MCP tool the CLI dials** — `tt open` is a client of
this endpoint (see the `tt-cli` bullet), so the per-checkout port lives in
`tt_mcp::port` where both ends read it rather than in the transport.
