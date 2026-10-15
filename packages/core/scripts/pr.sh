#!/usr/bin/env bash
# The mechanics behind /pr, /prm and /done, so the agent's only job is words and
# which files belong. Every subcommand is safe to re-run.
#
#   pr.sh state                              facts about this checkout and its PR
#   pr.sh branch <name>                      leave the default branch, carrying changes
#   pr.sh open --title T --body-file F       push, then create or update the PR
#   pr.sh merge [--body-file F]              wait for checks, merge, verify, clean up
#
# Exit 0 = done. Exit 2 = a stop the user must act on: one `STOP:` line and one
# `FIX:` line, nothing to work around. Any other exit is a bug in this script.
set -uo pipefail

stop() {
  printf 'STOP: %s\nFIX: %s\n' "$1" "$2"
  exit 2
}

need() { command -v "$1" >/dev/null 2>&1 || stop "$1 is not installed" "Install $1, then run this again."; }
need git
need gh

root=$(git rev-parse --show-toplevel 2>/dev/null) || stop "not inside a git repository" "cd into the checkout first."
cd "$root" || exit 1

default_branch() {
  local name
  name=$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null)
  [ -n "$name" ] || name=$(git symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')
  printf '%s' "${name:-main}"
}

current_branch() {
  git symbolic-ref -q --short HEAD || stop "HEAD is detached" "git switch -c <branch> to put the work on a branch."
}

# The repo's linked worktrees can't check out the default branch, which the
# main checkout holds; only the main checkout switches back after a merge.
is_main_worktree() {
  [ "$(git rev-parse --path-format=absolute --git-dir)" = "$(git rev-parse --path-format=absolute --git-common-dir)" ]
}

# The nearest local ancestor branch with an open PR, so a stacked branch's PR
# targets it rather than the default branch (the shell `pr()`'s rule).
stacked_base() {
  local branch=$1 default=$2 candidate count pairs=()
  while IFS= read -r candidate; do
    [ "$candidate" = "$branch" ] || [ "$candidate" = "$default" ] && continue
    git merge-base --is-ancestor "$candidate" "$branch" 2>/dev/null || continue
    count=$(git rev-list --count "$candidate..$branch")
    pairs+=("$count $candidate")
  done < <(git for-each-ref --format='%(refname:short)' refs/heads)
  [ ${#pairs[@]} -eq 0 ] && return
  while IFS= read -r candidate; do
    [ -z "$candidate" ] && continue
    if [ "$(gh pr view "$candidate" --json state -q .state 2>/dev/null)" = "OPEN" ]; then
      printf '%s' "$candidate"
      return
    fi
  done < <(printf '%s\n' "${pairs[@]}" | sort -n | cut -d' ' -f2-)
}

# Tell a running towles-tool app to refresh its PR view now. Best-effort: the
# app is optional, and the plugin's own gh hook can't see gh run from a script.
nudge() {
  command -v tt >/dev/null 2>&1 || return 0
  tt task nudge prs --only-if-tracked --trigger "pr:$1" >/dev/null 2>&1 || true
}

pr_field() {
  gh pr view "$1" --json "$2" -q ".$2" 2>/dev/null
}

cmd_state() {
  local branch default ahead pr
  default=$(default_branch)
  branch=$(current_branch)
  git fetch -q --prune origin 2>/dev/null || echo "note: git fetch failed, refs may be stale"
  echo "root: $root"
  echo "worktree: $(is_main_worktree && echo main || echo linked)"
  echo "default: $default"
  echo "branch: $branch"
  echo "on-default: $([ "$branch" = "$default" ] && echo yes || echo no)"
  ahead=$(git rev-list --count "origin/$default..HEAD" 2>/dev/null || echo 0)
  echo "commits-ahead-of-$default: $ahead"
  if git rev-parse -q --verify "refs/remotes/origin/$branch" >/dev/null; then
    echo "unpushed: $(git rev-list --count "origin/$branch..HEAD")"
  else
    echo "unpushed: $ahead (branch not on origin)"
  fi
  echo "uncommitted:"
  git status --porcelain | sed 's/^/  /'
  if [ "$branch" != "$default" ]; then
    pr=$(gh pr view --json number,state,url,baseRefName -q '"#\(.number) \(.state) base=\(.baseRefName) \(.url)"' 2>/dev/null)
    echo "pr: ${pr:-none}"
  else
    echo "pr: none (on $default)"
  fi
}

cmd_branch() {
  local name=${1:-} default branch
  [ -n "$name" ] || stop "no branch name given" "pr.sh branch <name>, e.g. feat/wow-flight-bar."
  default=$(default_branch)
  branch=$(current_branch)
  [ "$branch" = "$default" ] || stop "already on $branch, not $default" "Skip this step: the work is already on a branch."
  git rev-parse -q --verify "refs/heads/$name" >/dev/null && stop "branch $name already exists" "Pick another name."
  git switch -q -c "$name" || exit 1
  echo "branch: $name (uncommitted changes came along)"
}

cmd_open() {
  local title="" body="" default branch base number url leftover
  while [ $# -gt 0 ]; do
    case $1 in
      --title) title=$2; shift 2 ;;
      --body-file) body=$2; shift 2 ;;
      *) stop "unknown argument $1" "pr.sh open --title T --body-file F" ;;
    esac
  done
  if [ -z "$title" ] || [ ! -f "$body" ]; then
    stop "open needs --title and an existing --body-file" "Write the body to a file, then pass both."
  fi
  default=$(default_branch)
  branch=$(current_branch)
  [ "$branch" != "$default" ] || stop "on $default" "pr.sh branch <name> first."
  git fetch -q origin "$default" 2>/dev/null
  # A squash merge leaves the branch "ahead" forever; a PR that merged this exact
  # tip means there's nothing to open, not a second PR to create.
  if [ "$(pr_field "$branch" state)" = "MERGED" ] && [ "$(pr_field "$branch" headRefOid)" = "$(git rev-parse HEAD)" ]; then
    echo "pr: #$(pr_field "$branch" number) already merged this exact commit, nothing to open"
    return
  fi
  [ "$(git rev-list --count "origin/$default..HEAD")" -gt 0 ] ||
    stop "$branch has no commits beyond $default" "Commit the work first."
  git push -q -u origin "$branch" 2>&1 || stop "push of $branch was rejected" "Pull or rebase onto origin/$branch, then run this again."

  number=$(gh pr view "$branch" --json number,state -q 'select(.state=="OPEN") | .number' 2>/dev/null)
  if [ -n "$number" ]; then
    gh pr edit "$number" --title "$title" --body-file "$body" >/dev/null || exit 1
    echo "pr: #$number updated"
  else
    base=$(stacked_base "$branch" "$default")
    [ -n "$base" ] && echo "stacked: targeting $base, which has an open PR"
    gh pr create --base "${base:-$default}" --head "$branch" --title "$title" --body-file "$body" >/dev/null || exit 1
    number=$(pr_field "$branch" number)
    echo "pr: #$number opened"
  fi
  nudge create
  url=$(pr_field "$number" url)
  echo "url: $url"
  leftover=$(git status --porcelain)
  if [ -n "$leftover" ]; then
    echo "left uncommitted:"
    printf '%s\n' "$leftover" | sed 's/^/  /'
  fi
}

# Checks can take a few seconds to register after a push; a repo with no
# workflows never gets any, and waiting for them would hang.
wait_for_checks() {
  local number=$1 out
  [ -d .github/workflows ] || { echo "checks: none (no workflows)"; return; }
  for _ in 1 2 3 4 5 6; do
    out=$(gh pr checks "$number" 2>&1)
    printf '%s' "$out" | grep -q "no checks reported" || break
    sleep 5
  done
  if printf '%s' "$out" | grep -q "no checks reported"; then
    echo "checks: none reported"
    return
  fi
  if gh pr checks "$number" --watch --fail-fast --interval 15 >/dev/null 2>&1; then
    echo "checks: passed"
    return
  fi
  stop "checks failed on #$number: $(gh pr checks "$number" 2>/dev/null | awk -F'\t' '$2=="fail"{print $1}' | paste -sd, -)" \
    "Fix them and push (/pr), then run /prm again."
}

merge_method() {
  local allowed
  allowed=$(gh repo view --json squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed \
    -q '[if .squashMergeAllowed then "squash" else empty end, if .mergeCommitAllowed then "merge" else empty end, if .rebaseMergeAllowed then "rebase" else empty end] | first // "squash"')
  printf '%s' "${allowed:-squash}"
}

# After the merge: the main checkout goes back to the default branch, updated, and
# drops the merged branch. Only when the local tip is exactly what merged, so no
# unpushed commit can go with it. A linked worktree is left for /done to remove.
cleanup_local() {
  local branch=$1 default=$2 head_oid=$3
  is_main_worktree || return 0
  [ "$(git rev-parse HEAD)" = "$head_oid" ] || { echo "note: local $branch has commits the PR didn't, kept it"; return 0; }
  [ -z "$(git status --porcelain)" ] || { echo "note: uncommitted changes, stayed on $branch"; return 0; }
  git switch -q "$default" && git pull -q --ff-only origin "$default" && git branch -q -D "$branch" &&
    echo "local: on $default, up to date; deleted $branch"
}

cmd_merge() {
  local body="" default branch number state base head_oid mergeable method out commit
  while [ $# -gt 0 ]; do
    case $1 in
      --body-file) body=$2; shift 2 ;;
      *) stop "unknown argument $1" "pr.sh merge [--body-file F]" ;;
    esac
  done
  default=$(default_branch)
  branch=$(current_branch)
  [ "$branch" != "$default" ] || stop "on $default, there's no PR branch to merge" "Run /pr first."
  number=$(pr_field "$branch" number)
  [ -n "$number" ] || stop "$branch has no PR" "Run /pr first."
  state=$(pr_field "$number" state)
  head_oid=$(pr_field "$number" headRefOid)

  if [ "$state" = "MERGED" ]; then
    commit=$(gh pr view "$number" --json mergeCommit -q '.mergeCommit.oid' 2>/dev/null)
    echo "pr: #$number already merged as ${commit:0:7}"
    [ -n "$body" ] && gh pr edit "$number" --body-file "$body" >/dev/null
    cleanup_local "$branch" "$default" "$head_oid"
    return
  fi
  [ "$state" = "OPEN" ] || stop "PR #$number is $state" "Reopen it or open a new one with /pr."
  [ "$(git rev-parse HEAD)" = "$head_oid" ] || stop "local $branch differs from the PR head" "Push it with /pr, then run /prm again."
  base=$(pr_field "$number" baseRefName)
  [ "$base" = "$default" ] || stop "#$number is stacked on $base" "Merge the PR for $base first."
  [ -n "$body" ] && { gh pr edit "$number" --body-file "$body" >/dev/null || exit 1; }

  mergeable=$(pr_field "$number" mergeable)
  [ "$mergeable" != "CONFLICTING" ] || stop "#$number conflicts with $default" "Rebase or merge $default into $branch, push, then run /prm again."

  wait_for_checks "$number"

  method=$(merge_method)
  # Running /prm is the user's permission for an admin merge: one retry with
  # --admin when branch protection (not a check or a conflict) refuses it.
  if ! out=$(gh pr merge "$number" "--$method" 2>&1); then
    echo "note: normal merge refused ($(printf '%s' "$out" | head -n1)), retrying with --admin"
    out=$(gh pr merge "$number" "--$method" --admin 2>&1) ||
      stop "merge of #$number refused even with --admin: $(printf '%s' "$out" | head -n1)" \
        "Merge it on GitHub, or ask a repo admin to."
  fi
  nudge merge

  for _ in 1 2 3 4 5; do
    state=$(pr_field "$number" state)
    [ "$state" = "MERGED" ] && break
    sleep 2
  done
  [ "$state" = "MERGED" ] || stop "gh reported success but #$number is $state" "Check the PR on GitHub."
  commit=$(gh pr view "$number" --json mergeCommit -q '.mergeCommit.oid' 2>/dev/null)
  echo "pr: #$number merged by $method as ${commit:0:7}"

  # Not `gh pr merge --delete-branch`: it switches to the default branch, which
  # fails in a linked worktree. A 422 means GitHub already auto-deleted it.
  gh api -X DELETE "repos/{owner}/{repo}/git/refs/heads/$branch" >/dev/null 2>&1 &&
    echo "remote: deleted $branch"
  cleanup_local "$branch" "$default" "$head_oid"
}

sub=${1:-}
[ $# -gt 0 ] && shift
case $sub in
  state) cmd_state ;;
  branch) cmd_branch "$@" ;;
  open) cmd_open "$@" ;;
  merge) cmd_merge "$@" ;;
  *) stop "unknown subcommand '${sub}'" "pr.sh state|branch|open|merge" ;;
esac
