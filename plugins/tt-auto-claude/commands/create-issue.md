---
description: Create a GitHub issue with the auto-claude label for AI-driven work
allowed-tools: Bash(gh *), AskUserQuestion(*)
---

Create a GitHub issue with the `auto-claude` label for Claude Code pipeline work.

1. Get repo: `gh repo view --json nameWithOwner --jq '.nameWithOwner'`
2. Fetch labels: `gh label list --repo <repo> --json name --jq '.[].name'`
3. AskUserQuestion (up to 4 at once): title, description, extra labels (multi-select from repo labels)
4. `gh issue create`:
   - Always include `auto-claude` label + any extras
   - Prefix title with conventional type (`feat:`, `fix:`, `refactor:`, `research:`, `chore:`)
   - Body: `## Summary`, `## Type`, `## Notes` sections
   - If `auto-claude` label missing, create it first:
     `gh label create "auto-claude" --repo <repo> --description "Issue for Claude Code auto-claude pipeline" --color "7C3AED"`
5. **Batch**: multiple issues → create in parallel with appropriate prefix/labels each
6. Report all issue URLs in a table

$ARGUMENTS
