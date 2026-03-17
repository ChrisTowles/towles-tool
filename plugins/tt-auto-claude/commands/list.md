---
description: List open issues with the auto-claude label in the current repo
allowed-tools: Bash(gh *)
---

List open issues across all auto-claude pipeline states in the current repo.

1. Get repo: `gh repo view --json nameWithOwner --jq '.nameWithOwner'`
2. `gh issue list --repo <repo> --state open --json number,title,labels,assignees,state --limit 50` for each label:
   - `auto-claude` (queued)
   - `auto-claude-in-progress`
   - `auto-claude-failed`
   - `auto-claude-review`
3. Deduplicate across queries. Display as a table sorted by issue number:

   | #   | Title | Status | Labels | Assignee |
   | --- | ----- | ------ | ------ | -------- |

   Status derived from pipeline label. Labels column excludes pipeline labels. Assignee shows login or `—`.

$ARGUMENTS
