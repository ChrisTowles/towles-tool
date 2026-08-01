#!/usr/bin/env bash
# PostToolUse(Bash): if the command just run was a `gh pr` or `gh issue`
# mutation (merge/create/close/reopen/ready/edit/comment/review/draft/undraft
# for PRs; create/close/reopen/edit/comment/transfer for issues), nudge a
# running towles-tool app instance to refresh the matching view immediately
# instead of waiting for its normal poll interval (`tt task nudge
# prs`/`tt task nudge issues` -- see crates-tauri/tt-app/src/scheduler.rs's
# nudge-dir watch).
#
# Fails open on *absence*: this plugin can be enabled globally in Claude
# Code, so it runs for every Bash command in every project, not just
# towles-tool checkouts, and a parse hiccup, missing `jq`/`tt`, or an
# irrelevant session just exits 0 -- a pure UI-responsiveness accelerant
# should never block a Claude Code turn. A nudge that *runs and fails* is
# different: that's broken wiring (July 2026: a `tt` predating the
# `collect nudge` -> `task nudge` rename ate every nudge for days, exit 0,
# output discarded), so it exits 2 to surface the error to the session --
# PostToolUse can't block anything, the tool already ran.
input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
[ -z "$cmd" ] && exit 0

# Which nudge target(s) this command touches, and which verb matched -- the
# verb (not the full command, which may carry a PR body/token) is passed
# through to `tt task nudge --trigger` so the resulting telemetry event
# names what fired without ever recording command content. Separator- or
# line-start-anchored (same heuristic as the repo's own
# .claude/hooks/guard-task-pkill.sh) so this never fires on a bare mention of
# the phrase inside prose, a commit message, or a code span. A chained
# command (`gh pr create && gh issue close 5`) can match both.
pr_verb=$(printf '%s\n' "$cmd" |
  grep -oE '(^|[;&|(])[[:space:]]*gh[[:space:]]+pr[[:space:]]+(merge|create|close|reopen|ready|edit|comment|review|draft|undraft)([[:space:]]|$)' |
  grep -oE '(merge|create|close|reopen|ready|edit|comment|review|draft|undraft)' | head -n1)
is_pr_command=0
[ -n "$pr_verb" ] && is_pr_command=1

issue_verb=$(printf '%s\n' "$cmd" |
  grep -oE '(^|[;&|(])[[:space:]]*gh[[:space:]]+issue[[:space:]]+(create|close|reopen|edit|comment|transfer)([[:space:]]|$)' |
  grep -oE '(create|close|reopen|edit|comment|transfer)' | head -n1)
is_issue_command=0
[ -n "$issue_verb" ] && is_issue_command=1

if [ "$is_pr_command" -ne 1 ] && [ "$is_issue_command" -ne 1 ]; then
  exit 0
fi

cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)
[ -z "$cwd" ] && cwd="${CLAUDE_PROJECT_DIR:-$PWD}"

# Only nudge when this session is actually towles-tool-relevant, via either
# signal:
#   1. An env value the app itself stamps into every terminal it spawns
#      (TT_SESSION_ID/TT_APP_INSTANCE -- crates-tauri/tt-app/src/terminal.rs).
#   2. `cwd` is inside a towles-tool checkout (primary or a worktree
#      task), recognised the same way tt_config::task_scope_from_dir does:
#      a `crates/tt-config` directory at some ancestor.
# Without this, a hook enabled globally would still fire for `gh` commands
# run against completely unrelated projects in a plain tmux pane, making
# every running towles-tool-app instance burn a `gh` sweep on it (the nudge
# dir is machine-global, addressed per note -- tt_config::nudge_dir_path).
# Guard-fail is intentionally not logged anywhere: it's the expected,
# high-volume case for a globally-enabled hook running against unrelated
# projects, and logging it would just be noise. The one audit trail this
# hook contributes is the `hook.nudge` telemetry event emitted by `tt task
# nudge` itself below, which only happens once both the matcher and this
# guard have already passed.
in_app_terminal=0
[ -n "${TT_SESSION_ID:-}" ] && in_app_terminal=1
[ -n "${TT_APP_INSTANCE:-}" ] && in_app_terminal=1

in_checkout=0
dir="$cwd"
while [ -n "$dir" ] && [ "$dir" != "/" ]; do
  if [ -d "$dir/crates/tt-config" ]; then
    in_checkout=1
    break
  fi
  parent=$(dirname "$dir")
  # A malformed/relative `cwd` can make `dirname` stop shortening (e.g. "."
  # maps to itself) -- bail immediately rather than spin until the hook's
  # own timeout kills it.
  [ "$parent" = "$dir" ] && break
  dir="$parent"
done

if [ "$in_app_terminal" -ne 1 ] && [ "$in_checkout" -ne 1 ]; then
  exit 0
fi

command -v tt >/dev/null 2>&1 || exit 0

# stderr is captured (stdout stays discarded) because the one failure mode
# telemetry can never record is a `tt` too old to parse its own invocation.
failed="" detail=""
if [ "$is_pr_command" -eq 1 ]; then
  out=$(cd "$cwd" && tt task nudge prs --trigger "pr:$pr_verb" 2>&1 >/dev/null) || {
    failed="prs"
    detail="$out"
  }
fi
if [ "$is_issue_command" -eq 1 ]; then
  out=$(cd "$cwd" && tt task nudge issues --trigger "issue:$issue_verb" 2>&1 >/dev/null) || {
    failed="${failed:+$failed,}issues"
    detail="${detail:-$out}"
  }
fi
[ -z "$failed" ] && exit 0
{
  printf 'gh-pr-nudge: `tt task nudge %s` failed -- the towles-tool app will not see this mutation until its next poll.\n' "$failed"
  printf '%s\n' "${detail:-"(no error output)"}" | head -n 3
  printf 'If the subcommand is unrecognized, the installed tt predates this plugin: reinstall it from the towles-tool repo (cargo install --path crates-cli/tt-cli).\n'
} >&2
exit 2
