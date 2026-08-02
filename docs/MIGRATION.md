# Migration Backlog (historical)

> **Historical.** The port from the TypeScript `towles-tool` CLI is finished —
> every item below is done or deliberately superseded, and nothing here is
> outstanding work. It's the record of what was ported, what was dropped, and
> which behaviors deviate on purpose. Paths, command names, and crate names are
> as they were at the time, not a live reference; for the current shape see
> [CLAUDE.md](../CLAUDE.md).

Source of truth for the old behavior was the TS CLI, then at
`~/code/p/towles-tool-repos/towles-tool-slot-1`. Structural patterns come from
Yaak (see [ATTRIBUTION.md](../ATTRIBUTION.md)). Items were worked roughly in
order, each building on the last.

**2026-07-11 — CLI parity dropped as a requirement.** The app is the primary
product; remaining TS features were ported selectively and landed on their
natural surface — app screen or CLI command, no obligation to ship both.

- [x] **0 — Scaffold.** Cargo workspace, `tt-config` + `tt-exec`, `tt-cli`,
  Tauri shell, React client.

- [x] **1 — Journal commands.** `tt-journal` (`tokens` + `entries`), wired as
  `journal daily-notes|note|meeting|list|search` plus a top-level `today`.

- [x] **2 — GitHub helpers.** `gh pr` / `branch-clean` / `branch`, pure logic in
  `tt-git`, prompts via `inquire` (its `Select` gives fuzzy filtering out of the
  box, so no `fzf`). Branch-name/PR-title slugging matches the TS byte-for-byte,
  including its ASCII-only `\w` semantics.

- [x] **3 — Install + Claude settings; doctor history/diff.** `claude_settings`
  models Claude Code's real `~/.claude/settings.json` as an open
  `serde_json::Map`, so every unknown key survives a rewrite.

- [x] **4 — Graph.** JSONL token accounting and treemap rendering; the local
  HTTP server was dropped as an approved simplification. Renamed
  `graph` → `claude-sessions` (2026-07-10), then made app-only (2026-07-17):
  the CLI command went, the crate became `tt-claude-sessions`, and the treemap
  explorer was retired for an answer-first **Insights** tab (ranked waste
  findings over the cached ledger scan) plus a per-session turn/tool dialog.

- [~] **5 — Claude plugin carry-over.** `packages/core/` copied across verbatim.
  Distribution stayed on the live ChrisTowles/towles-tool repo through the
  cutover, since marketplaces are URL-keyed — see
  [docs/PLUGIN-DISTRIBUTION.md](PLUGIN-DISTRIBUTION.md).

- [x] **6 — Tauri app feature direction: agentboard-as-desktop.** The desktop
  app *is* agentboard (adopted 2026-07-02), which is why the rewrite targeted
  Tauri rather than a `ratatui` TUI.

- [x] **7 — Agentboard rewrite inside the Tauri app.** The Tauri-free
  `tt-agentboard` crate (types, tracker, metadata, session-order, git-info,
  ports, the claude-code/amp/codex/opencode watchers, bridge assembly), the
  `tt-app` bridge, the React UI, and the repos CLI. Only claude-code has a
  process-liveness signal; amp/codex/opencode are status-derived and so are
  never pinned against the stuck-session rule.

- [x] **8 — Distribution + rename.** Local-first (`cargo install --path
  crates-cli/tt-cli`; tauri bundle for the app) — own infrastructure only, never
  Yaak's. The `ttr` → `tt` flip executed 2026-07-13, hard cutover, no alias;
  operator steps live in [docs/CUTOVER.md](CUTOVER.md).

- [~] **9 — Data hub + day screens** (new feature, not a TS port). Built
  2026-07-04: `tt-store` (SQLite), `tt-collect`, `tt-mcp`, the collector
  scheduler, and the day screens. Product rules set here and still binding:
  agent TUIs are never re-rendered (status is read-only, interaction is a real
  PTY), and collectors are the only tt.db writers.

  **Day-screens pivot** (same day). The product refocused on *getting in the
  zone*: PRs + cross-repo issues + a personal kanban. Email was removed
  everywhere; calendar reduced to the next-meeting countdown; `tasks` became a
  local kanban with an optional issue link. Collectors became config-driven via
  `settings.collectors`.

  **Since:** the stdio `tt mcp serve` was retired — the MCP server runs inside
  the app over loopback HTTP, one per checkout, and is no longer a CLI surface.
